import { afterEach, describe, expect, it, vi } from "vitest";

import { LockLostError } from "./errors.js";
import { LockManager } from "./lock_manager.js";
import type { LockInstrumentationEvent } from "./observations.js";
import type { LockAdapter, LockExtendRequest, LockHandle, LockLease } from "./types.js";

function deferred<Value>() {
  const { promise, resolve } = Promise.withResolvers<Value>();
  return { promise, resolve };
}

/** Keep storage outcomes controllable while exercising only the public exclusive-operation API. */
function setup(batch?: (requests: readonly LockExtendRequest[]) => Promise<readonly LockLease[] | undefined>) {
  vi.useFakeTimers();
  const events: LockInstrumentationEvent[] = [];
  const adapter: LockAdapter = {
    tryAcquire: vi.fn(async (request) => ({ ...request, expiresAt: new Date(1_000), fencingToken: 1n })),
    extend: vi.fn(async (request) => ({ ...request, expiresAt: new Date(2_000), fencingToken: 1n })),
    release: vi.fn(async () => true),
    ...(batch === undefined ? {} : { extendMany: vi.fn(batch) }),
  };
  let owner = 0;
  const manager = new LockManager(adapter, {
    namespace: "test", defaultTtlMs: 1_000, maxTtlMs: 10_000, defaultWaitTimeoutMs: 0,
    retryIntervalMs: 10, now: () => new Date(0), createOwnerId: () => `owner-${++owner}`,
    instrumentation: { record: (event) => events.push(event) },
  });
  const started = deferred<{ handles: readonly LockHandle[]; signal: AbortSignal }>();
  const finish = deferred<void>();
  const outcome = manager.runExclusiveMany(["first", "second"], async (handles, { signal }) => {
    started.resolve({ handles, signal });
    await finish.promise;
    return "completed";
  }).then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  return { adapter, events, started: started.promise, finish: () => finish.resolve(), outcome };
}

function renewed(requests: readonly LockExtendRequest[]): LockLease[] {
  return requests.map((request) => ({ ...request, expiresAt: new Date(2_000), fencingToken: 1n }));
}

describe("LockManager batch renewal contracts", () => {
  afterEach(() => vi.useRealTimers());

  for (const variant of ["rejected", "short", "extra", "key", "owner", "reordered"] as const) {
    it(`aborts, preserves leases and releases every handle after a ${variant} renewal result`, async () => {
      const failure = new Error("batch backend unavailable");
      const state = setup(async (requests) => {
        if (variant === "rejected") throw failure;
        const leases = renewed(requests);
        if (variant === "short") return leases.slice(0, 1);
        if (variant === "extra") return [...leases, leases[0]!];
        if (variant === "key") leases[1] = { ...leases[1]!, key: "test:other" };
        if (variant === "owner") leases[1] = { ...leases[1]!, ownerId: "another-owner" };
        if (variant === "reordered") leases.reverse();
        return leases;
      });
      const { handles, signal } = await state.started;
      try {
        await vi.advanceTimersByTimeAsync(500);
      } finally {
        // Even a mutant that fails to abort the handler must let this test close its heartbeat.
        state.finish();
      }
      const result = await state.outcome;
      expect(signal.aborted).toBe(true);
      expect(result.error).toBe(signal.reason);
      if (variant === "rejected") expect(result.error).toBe(failure);
      else expect(result.error).toMatchObject({ message: variant === "short" || variant === "extra"
        ? "Lock adapter returned an incomplete extension batch."
        : "Lock adapter returned a mismatched extension batch." });
      expect(handles.map((handle) => handle.expiresAt)).toEqual([new Date(1_000), new Date(1_000)]);
      expect(state.events.filter((event) => event.type === "extension")).toMatchObject([
        { outcome: "failure", data: { key: "first", result: "error" } },
        { outcome: "failure", data: { key: "second", result: "error" } },
      ]);
      expect(state.adapter.release).toHaveBeenCalledTimes(2);
      expect(state.adapter.release).toHaveBeenNthCalledWith(1, { key: "test:first", ownerId: "owner-1" });
      expect(state.adapter.release).toHaveBeenNthCalledWith(2, { key: "test:second", ownerId: "owner-2" });
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("reports every lost lease when atomic batch renewal reports lost ownership", async () => {
    const state = setup(async () => undefined);
    const { signal } = await state.started;
    try { await vi.advanceTimersByTimeAsync(500); } finally { state.finish(); }
    const result = await state.outcome;
    expect(signal.aborted).toBe(true);
    expect(result.error).toBe(signal.reason);
    expect(result.error).toBeInstanceOf(AggregateError);
    expect(result.error).toMatchObject({ message: "Lock batch ownership was lost.", errors: [
      expect.objectContaining({ key: "first" }), expect.objectContaining({ key: "second" }),
    ] });
    expect((result.error as AggregateError).errors.every((error) => error instanceof LockLostError)).toBe(true);
    expect(state.events.filter((event) => event.type === "extension")).toMatchObject([
      { outcome: "failure", data: { key: "first", result: "lost" } },
      { outcome: "failure", data: { key: "second", result: "lost" } },
    ]);
    expect(state.adapter.release).toHaveBeenCalledTimes(2);
  });

  for (const batch of [false, true]) {
    it(`publishes every successful ${batch ? "batch" : "fallback"} renewal to the handler`, async () => {
      const state = setup(batch ? async (requests) => renewed(requests) : undefined);
      const { handles, signal } = await state.started;
      try {
        await vi.advanceTimersByTimeAsync(500);
        expect(handles.map((handle) => handle.expiresAt)).toEqual([new Date(2_000), new Date(2_000)]);
        expect(state.events.filter((event) => event.type === "extension")).toMatchObject([
          { outcome: "success", data: { key: "first", result: "extended" } },
          { outcome: "success", data: { key: "second", result: "extended" } },
        ]);
        expect(signal.aborted).toBe(false);
      } finally { state.finish(); await state.outcome; }
      expect(await state.outcome).toEqual({ value: "completed", error: undefined });
      expect(state.adapter.release).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("waits for every fallback renewal and preserves every rejection before aborting", async () => {
    const state = setup();
    const first = new Error("first backend failure");
    const pending = deferred<LockLease | undefined>();
    vi.mocked(state.adapter.extend).mockImplementation(async (request) => {
      if (request.key === "test:first") throw first;
      return pending.promise;
    });
    const { signal } = await state.started;
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(state.adapter.extend).toHaveBeenCalledTimes(2);
      expect(signal.aborted).toBe(false);
      // A pending sibling must settle before cancellation and release can report a complete outcome.
      pending.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      pending.resolve(undefined);
      state.finish();
      await state.outcome;
    }
    const result = await state.outcome;
    expect(signal.aborted).toBe(true);
    expect(result.error).toBe(signal.reason);
    expect(result.error).toBeInstanceOf(AggregateError);
    expect(result.error).toMatchObject({ message: "Lock batch extension failed.", errors: [first, expect.any(LockLostError)] });
    expect(state.adapter.release).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
