import { setImmediate as nextTurn } from "node:timers/promises";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  LockAcquisitionAbortedError,
  LockAcquisitionTimeoutError,
  LockBatchAcquisitionAbortedError,
  LockBatchAcquisitionTimeoutError,
  LockLostError,
  LockReleasedError,
} from "./errors.js";
import { LockManager } from "./lock_manager.js";
import { MemoryLockAdapter } from "./adapters/memory/index.js";
import {
  lockAcquisitionObservation,
  lockBatchAcquisitionObservation,
  lockExtensionObservation,
  lockReleaseObservation,
  type LockInstrumentationEvent,
} from "./observations.js";
import type {
  LockAcquireRequest,
  LockAdapter,
  LockExtendRequest,
  LockLease,
  LockReleaseRequest,
} from "./types.js";

describe("LockManager", () => {
  afterEach(() => vi.useRealTimers());

  it("namespaces keys and caps the requested TTL", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter, { maxTtlMs: 2_000 });

    const lock = await locks.tryAcquire("job", { ttlMs: 10_000 });

    expect(adapter.acquireRequests).toEqual([{
      key: "test:job",
      ownerId: "owner-1",
      ttlMs: 2_000,
    }]);
    expect(lock).toMatchObject({
      key: "job",
      fencingToken: 1n,
    });
  });

  it("returns undefined immediately when a lock is contended", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    const locks = createManager(adapter);

    await expect(locks.tryAcquire("job")).resolves.toBeUndefined();

    expect(adapter.acquireRequests).toHaveLength(1);
  });

  it("waits and retries until a lock becomes available", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    const acquire = adapter.tryAcquire.bind(adapter);
    vi.spyOn(adapter, "tryAcquire")
      .mockImplementationOnce(acquire)
      .mockImplementation(async (request) => {
        if (!adapter.available) throw new Error("The configured sleeper did not release contention.");
        return acquire(request);
      });
    let nowMs = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
      adapter.available = true;
    });
    const locks = createManager(adapter, {
      now: () => new Date(nowMs),
      sleep,
    });

    await expect(locks.acquire("job", {
      waitTimeoutMs: 100,
      retryIntervalMs: 20,
    })).resolves.toMatchObject({ key: "job" });

    expect(sleep).toHaveBeenCalledWith(20, undefined);
    expect(adapter.acquireRequests).toHaveLength(2);
  });

  it("throws a typed error when the waiting deadline is reached", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    let nowMs = 0;
    const locks = createManager(adapter, {
      now: () => new Date(nowMs),
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
    });

    await expect(locks.acquire("job", {
      waitTimeoutMs: 40,
      retryIntervalMs: 25,
    })).rejects.toEqual(new LockAcquisitionTimeoutError("job"));
  });

  it.each([false, true])("clamps jittered waits to the deadline and reports timeout (batch=%s)", async (batch) => {
    const adapter = new RecordingAdapter();
    const instrumentation = new RecordingInstrumentation();
    adapter.available = false;
    let nowMs = 1_000;
    const waitTimeoutMs = batch ? 30 : 25;
    const sleep = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
      if (nowMs > 1_000 + waitTimeoutMs) throw new Error("Wait exceeded its budget.");
    });
    const locks = createManager(adapter, {
      instrumentation, now: () => new Date(nowMs), monotonicNow: () => nowMs,
      sleep, random: () => batch ? 1 : 0, retryJitterRatio: 0.25,
    });
    const options = { waitTimeoutMs, retryIntervalMs: 20 };

    await expect(batch ? locks.acquireMany(["job"], options) : locks.acquire("job", options))
      .rejects.toBeInstanceOf(batch ? LockBatchAcquisitionTimeoutError : LockAcquisitionTimeoutError);
    // Jitter adjusts the first wait in both directions; the second stops at the deadline.
    expect(sleep.mock.calls).toEqual(batch ? [[25, undefined], [5, undefined]] : [[15, undefined], [10, undefined]]);
    expect(adapter.acquireRequests).toHaveLength(2);
    expect(instrumentation.events).toEqual([expect.objectContaining({
      type: batch ? "batch-acquisition" : "acquisition", outcome: "failure", durationMs: waitTimeoutMs,
      data: expect.objectContaining({ result: "timeout", attempts: 2, waitTimeoutMs }),
    })]);
  });

  it.each([false, true])("translates sleep cancellation and preserves ordinary sleep failures (batch=%s)", async (batch) => {
    const adapter = new RecordingAdapter();
    const instrumentation = new RecordingInstrumentation();
    adapter.available = false;
    const controller = new AbortController();
    const failure = new Error("Retry scheduler unavailable");
    const attempt = vi.spyOn(adapter, "tryAcquire")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("A failed wait must not retry."));
    const sleep = vi.fn(async (_delayMs: number, signal?: AbortSignal) => {
      if (signal === controller.signal) controller.abort(failure);
      throw failure;
    });
    const locks = createManager(adapter, { sleep, instrumentation, monotonicNow: () => 0 });
    const acquire = (signal?: AbortSignal) => {
      const options = signal === undefined ? {} : { signal };
      return batch ? locks.acquireMany(["job"], options) : locks.acquire("job", options);
    };

    await expect(acquire(controller.signal))
      .rejects.toBeInstanceOf(batch ? LockBatchAcquisitionAbortedError : LockAcquisitionAbortedError);
    await expect(acquire()).rejects.toBe(failure);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[10, controller.signal], [10, undefined]]);
    expect(instrumentation.events.map(({ type, outcome, data }) => ({ type, outcome, ...data }))).toMatchObject([
      { type: batch ? "batch-acquisition" : "acquisition", outcome: "failure", result: "aborted", attempts: 1 },
      { type: batch ? "batch-acquisition" : "acquisition", outcome: "failure", result: "error", attempts: 1 },
    ]);
    if (!batch) expect(instrumentation.events[1]!.data).toHaveProperty("mode", "wait");
  });

  it("passes cancellation into the default retry timer", async () => {
    const adapter = new RecordingAdapter();
    const controller = new AbortController();
    const acquire = vi.spyOn(adapter, "tryAcquire").mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("A blocked retry should not acquire again."));
    const operation = createManager(adapter).acquire("job", {
      signal: controller.signal, retryIntervalMs: 100, waitTimeoutMs: 100,
    });
    // Observe the settled result on the next turn after abort, before the timer's normal expiry.
    let rejected: unknown;
    const settled = operation.catch((error: unknown) => { rejected = error; });
    try {
      await nextTurn();
      controller.abort();
      await nextTurn();
      expect(rejected).toBeInstanceOf(LockAcquisitionAbortedError);
      expect(acquire).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await settled;
    }
  });

  it("does not retry when the wait timeout is zero", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    const sleep = vi.fn(async () => { throw new Error("A zero wait must not schedule a retry."); });
    const locks = createManager(adapter, { sleep });

    await expect(locks.acquire("job", { waitTimeoutMs: 0 }))
      .rejects.toBeInstanceOf(LockAcquisitionTimeoutError);
    expect(sleep).not.toHaveBeenCalled();
    expect(adapter.acquireRequests).toHaveLength(1);
  });

  it("honors an aborted acquisition signal", async () => {
    const locks = createManager(new RecordingAdapter());
    const controller = new AbortController();
    controller.abort();

    await expect(locks.acquire("job", { signal: controller.signal }))
      .rejects.toEqual(new LockAcquisitionAbortedError("job"));
  });

  it.each(["deadline", "abort"] as const)("releases a single lease returned after %s", async (interruption) => {
    const adapter = new RecordingAdapter();
    const acquire = adapter.tryAcquire.bind(adapter);
    const controller = new AbortController();
    let nowMs = 0;
    const handler = vi.fn();
    vi.spyOn(adapter, "tryAcquire").mockImplementation(async (request) => {
      const lease = await acquire(request);
      // Simulate a committed backend write whose response arrives after the caller's limit.
      if (interruption === "deadline") nowMs = 100;
      else controller.abort();
      return lease;
    });
    const locks = createManager(adapter, { now: () => new Date(nowMs) });
    const expected = interruption === "deadline" ? LockAcquisitionTimeoutError : LockAcquisitionAbortedError;

    await expect(locks.runExclusive("job", handler, {
      waitTimeoutMs: 100, signal: controller.signal,
    })).rejects.toBeInstanceOf(expected);
    expect(handler).not.toHaveBeenCalled();
    expect(adapter.releaseRequests).toEqual([{ key: "test:job", ownerId: "owner-1" }]);
  });

  it("preserves both the late acquisition and release failure", async () => {
    const adapter = new RecordingAdapter();
    const acquire = adapter.tryAcquire.bind(adapter);
    let nowMs = 0;
    adapter.releaseError = new Error("release failed");
    vi.spyOn(adapter, "tryAcquire").mockImplementation(async (request) => {
      const lease = await acquire(request);
      nowMs = 100;
      return lease;
    });
    const locks = createManager(adapter, { now: () => new Date(nowMs) });

    await expect(locks.acquire("job", { waitTimeoutMs: 100 })).rejects.toMatchObject({
      name: "AggregateError", errors: [expect.any(LockAcquisitionTimeoutError), adapter.releaseError],
    });
    expect(adapter.releaseRequests).toEqual([{ key: "test:job", ownerId: "owner-1" }]);
  });

  it("allows the one immediate attempt to succeed with a zero wait timeout", async () => {
    const adapter = new RecordingAdapter();
    const acquire = adapter.tryAcquire.bind(adapter);
    let nowMs = 0;
    vi.spyOn(adapter, "tryAcquire").mockImplementation(async (request) => {
      const lease = await acquire(request);
      nowMs = 100;
      return lease;
    });
    const locks = createManager(adapter, { now: () => new Date(nowMs) });

    await expect(locks.runExclusive("job", () => "ok", { waitTimeoutMs: 0 })).resolves.toBe("ok");
    expect(adapter.acquireRequests).toHaveLength(1);
    expect(adapter.releaseRequests).toHaveLength(1);
  });

  it("keeps a successor's lease when cleaning up a late acquisition", async () => {
    let nowMs = 0;
    const now = () => new Date(nowMs);
    const storage = new MemoryLockAdapter({ now });
    const acquire = storage.tryAcquire.bind(storage);
    vi.spyOn(storage, "tryAcquire").mockImplementationOnce(async (request) => {
      const lease = await acquire(request);
      // A different owner takes over before the first reply reaches the manager.
      nowMs = 100;
      await acquire({ ...request, ownerId: "successor", ttlMs: 500 });
      return lease;
    });
    const locks = createManager(storage, { now });

    await expect(locks.acquire("job", { ttlMs: 10, waitTimeoutMs: 100 }))
      .rejects.toBeInstanceOf(LockAcquisitionTimeoutError);
    await expect(acquire({ key: "test:job", ownerId: "contender", ttlMs: 500 }))
      .resolves.toBeUndefined();
    await expect(storage.release({ key: "test:job", ownerId: "successor" })).resolves.toBe(true);
  });

  it.each([false, true])("reports an aborted contended attempt without releasing another owner (batch=%s)", async (batch) => {
    const adapter = new BatchRecordingAdapter();
    const controller = new AbortController();
    const sleep = vi.fn(async () => undefined);
    const denied = async () => {
      controller.abort();
      return undefined;
    };
    vi.spyOn(adapter, "tryAcquire").mockImplementation(denied);
    vi.spyOn(adapter, "tryAcquireMany").mockImplementation(denied);
    const locks = createManager(adapter, { sleep });
    const options = { signal: controller.signal, waitTimeoutMs: 0 };

    if (batch) {
      await expect(locks.acquireMany(["job"], options)).rejects.toBeInstanceOf(LockBatchAcquisitionAbortedError);
    } else {
      await expect(locks.acquire("job", options)).rejects.toBeInstanceOf(LockAcquisitionAbortedError);
    }
    expect(sleep).not.toHaveBeenCalled();
    expect(adapter.releaseRequests).toEqual([]);
  });

  it.each(["immediate", "waiting"] as const)("rejects a mismatched %s lease without releasing its claimed owner", async (mode) => {
    const storage = new MemoryLockAdapter({ now: () => new Date(0) });
    const acquire = storage.tryAcquire.bind(storage);
    const foreign = (await acquire({ key: "test:other", ownerId: "foreign", ttlMs: 1_000 }))!;
    vi.spyOn(storage, "tryAcquire").mockImplementationOnce(async (request) => {
      await acquire(request);
      return foreign;
    });
    const locks = createManager(storage);

    const result = mode === "immediate" ? locks.tryAcquire("job") : locks.acquire("job");
    await expect(result).rejects.toThrow("Lock adapter returned a mismatched acquisition.");
    await expect(acquire({ key: "test:other", ownerId: "contender", ttlMs: 1_000 })).resolves.toBeUndefined();
    await expect(acquire({ key: "test:job", ownerId: "next", ttlMs: 1_000 })).resolves.toBeDefined();
  });

  it("acquires many locks in input order through the adapter fallback", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);

    const handles = await locks.acquireMany(["second", "first"], { waitTimeoutMs: 0 });

    expect(handles.map((handle) => handle.key)).toEqual(["second", "first"]);
    expect(adapter.acquireRequests.map((request) => request.key)).toEqual([
      "test:first",
      "test:second",
    ]);
  });

  it.each([["a", "b", "B"], ["B", "b", "a"]])(
    "uses code-unit acquisition order for input %s, %s, %s", async (...keys) => {
      const adapter = new RecordingAdapter();
      const handles = await createManager(adapter).acquireMany(keys, { waitTimeoutMs: 0 });
      expect(adapter.acquireRequests.map(({ key }) => key)).toEqual(["test:B", "test:a", "test:b"]);
      expect(handles.map(({ key }) => key)).toEqual(keys);
      await Promise.all(handles.map((handle) => handle.release()));
    },
  );

  it("releases a partial fallback batch before retrying", async () => {
    const adapter = new RecordingAdapter();
    adapter.contendedKeys.add("test:second");
    let nowMs = 0;
    const locks = createManager(adapter, {
      now: () => new Date(nowMs),
      sleep: async (delayMs) => {
        nowMs += delayMs;
        adapter.contendedKeys.clear();
      },
    });

    await expect(locks.acquireMany(["first", "second"], {
      waitTimeoutMs: 100,
      retryIntervalMs: 10,
    })).resolves.toHaveLength(2);
    expect(adapter.releaseRequests[0]).toMatchObject({ key: "test:first" });
  });

  it("uses an adapter batch operation when one is available", async () => {
    const adapter = new BatchRecordingAdapter();
    const locks = createManager(adapter);

    await locks.acquireMany(["second", "first"], { waitTimeoutMs: 0 });

    expect(adapter.batchRequests).toHaveLength(1);
    expect(adapter.acquireRequests).toHaveLength(0);
  });

  it("releases all leases returned by a native batch after cancellation", async () => {
    const adapter = new BatchRecordingAdapter();
    const acquire = adapter.tryAcquireMany.bind(adapter);
    const controller = new AbortController();
    const handler = vi.fn();
    vi.spyOn(adapter, "tryAcquireMany").mockImplementation(async (requests) => {
      const leases = await acquire(requests);
      controller.abort();
      return leases;
    });

    await expect(createManager(adapter).runExclusiveMany(["second", "first"], handler, {
      signal: controller.signal,
    })).rejects.toEqual(new LockBatchAcquisitionAbortedError(["second", "first"]));
    expect(handler).not.toHaveBeenCalled();
    expect(adapter.releaseRequests).toEqual([
      { key: "test:second", ownerId: "owner-1" },
      { key: "test:first", ownerId: "owner-2" },
    ]);
  });

  it("stops a fallback batch at the deadline and returns its partial lease", async () => {
    const adapter = new RecordingAdapter();
    const acquire = adapter.tryAcquire.bind(adapter);
    let nowMs = 0;
    vi.spyOn(adapter, "tryAcquire").mockImplementation(async (request) => {
      const lease = await acquire(request);
      nowMs = 100;
      return lease;
    });
    const locks = createManager(adapter, { now: () => new Date(nowMs) });

    await expect(locks.acquireMany(["second", "first"], {
      waitTimeoutMs: 100,
    })).rejects.toEqual(new LockBatchAcquisitionTimeoutError(["second", "first"]));
    expect(adapter.acquireRequests.map((request) => request.key)).toEqual(["test:first"]);
    expect(adapter.releaseRequests).toEqual([{ key: "test:first", ownerId: "owner-2" }]);
  });

  it.each(["incomplete", "foreign"] as const)("cleans up requested owners after a %s batch result", async (variant) => {
    const storage = new MemoryLockAdapter({ now: () => new Date(0) });
    const foreign = (await storage.tryAcquire({ key: "test:other", ownerId: "foreign", ttlMs: 1_000 }))!;
    const acquireMany = storage.tryAcquireMany.bind(storage);
    vi.spyOn(storage, "tryAcquireMany").mockImplementationOnce(async (requests) => {
      const leases = (await acquireMany(requests))!;
      // The backend wrote every requested owner before returning a malformed response.
      return variant === "incomplete" ? leases.slice(0, 1) : [leases[0]!, foreign];
    });

    await expect(createManager(storage).acquireMany(["first", "second"], { waitTimeoutMs: 0 })).rejects.toMatchObject({
      name: "AggregateError", errors: [expect.objectContaining({ message: expect.stringContaining("acquisition batch") })],
    });
    await expect(storage.tryAcquire({ key: "test:other", ownerId: "contender", ttlMs: 1_000 })).resolves.toBeUndefined();
    await expect(acquireMany([
      { key: "test:first", ownerId: "next", ttlMs: 1_000 },
      { key: "test:second", ownerId: "next", ttlMs: 1_000 },
    ])).resolves.toHaveLength(2);
  });

  it("acquires an empty batch without calling the adapter", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);

    await expect(locks.acquireMany([])).resolves.toEqual([]);
    expect(adapter.acquireRequests).toHaveLength(0);
  });

  it("records a successful zero-attempt batch without touching storage", async () => {
    const adapter = new BatchRecordingAdapter();
    const instrumentation = new RecordingInstrumentation();
    const locks = createManager(adapter, { instrumentation, monotonicNow: () => 0 });
    await expect(locks.acquireMany([])).resolves.toEqual([]);
    expect(adapter.batchRequests).toEqual([]);
    expect(instrumentation.events).toEqual([{
      type: "batch-acquisition", outcome: "success", durationMs: 0,
      data: { keys: [], result: "acquired", attempts: 0, ttlMs: 1_000, waitTimeoutMs: 100, fencingTokens: [] },
    }]);
  });

  it("does not start a native batch after cancellation", async () => {
    const adapter = new BatchRecordingAdapter();
    const controller = new AbortController();
    controller.abort();

    await expect(createManager(adapter).acquireMany(["first"], { signal: controller.signal }))
      .rejects.toBeInstanceOf(LockBatchAcquisitionAbortedError);
    expect(adapter.batchRequests).toEqual([]);
  });

  it("runs an empty exclusive batch without starting a heartbeat", async () => {
    vi.useFakeTimers();
    const adapter = new BatchRecordingAdapter();
    const locks = createManager(adapter);

    await expect(locks.runExclusiveMany([], (handles, { signal }) => {
      expect(handles).toEqual([]);
      expect(signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      return "completed";
    })).resolves.toBe("completed");
    expect(adapter.batchRequests).toEqual([]);
    expect(adapter.extensionBatchRequests).toEqual([]);
    expect(adapter.releaseRequests).toEqual([]);
  });

  it("retains ownership of every handle when callback code modifies its batch array", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);

    await locks.runExclusiveMany(["first", "second"], (handles) => {
      // JavaScript callers can mutate the runtime array despite the readonly TypeScript type.
      Reflect.apply(Array.prototype.pop, handles, []);
    });

    expect(adapter.releaseRequests).toEqual([
      { key: "test:first", ownerId: "owner-1" },
      { key: "test:second", ownerId: "owner-2" },
    ]);
  });

  it("propagates partial fallback cleanup failures", async () => {
    const adapter = new RecordingAdapter();
    adapter.contendedKeys.add("test:second");
    adapter.releaseError = new Error("cleanup failed");
    const locks = createManager(adapter);

    const acquisition = locks.acquireMany(["first", "second"], {
      waitTimeoutMs: 0,
    });

    await expect(acquisition).rejects.toBeInstanceOf(AggregateError);
    await expect(acquisition).rejects.toMatchObject({
      errors: [adapter.releaseError],
    });
  });

  it("preserves both fallback acquisition and rollback failures", async () => {
    const adapter = new RecordingAdapter();
    const acquire = adapter.tryAcquire.bind(adapter);
    const backendFailure = new Error("acquisition unavailable");
    const cleanupFailure = new Error("cleanup unavailable");
    vi.spyOn(adapter, "tryAcquire").mockImplementationOnce(acquire).mockRejectedValueOnce(backendFailure);
    adapter.releaseError = cleanupFailure;

    await expect(createManager(adapter).acquireMany(["first", "second"])).rejects.toMatchObject({
      name: "AggregateError", errors: [backendFailure, cleanupFailure],
    });
    expect(adapter.releaseRequests).toEqual([{ key: "test:first", ownerId: "owner-1" }]);
  });

  it("uses the original owner when a fallback adapter later changes its lease reply", async () => {
    const adapter = new RecordingAdapter();
    const acquire = adapter.tryAcquire.bind(adapter);
    let reply: LockLease;
    vi.spyOn(adapter, "tryAcquire")
      .mockImplementationOnce(async (request) => {
        reply = (await acquire(request))!;
        return reply;
      })
      .mockImplementationOnce(async () => {
        // A reused reply object must never redirect the rollback to a different owner.
        reply.ownerId = "unrelated";
        return undefined;
      });

    await expect(createManager(adapter).acquireMany(["first", "second"], { waitTimeoutMs: 0 }))
      .rejects.toBeInstanceOf(LockBatchAcquisitionTimeoutError);
    expect(adapter.releaseRequests).toEqual([{ key: "test:first", ownerId: "owner-1" }]);
  });

  it("rolls back original requests when a successful fallback batch contains a changed reply", async () => {
    const adapter = new RecordingAdapter();
    const acquire = adapter.tryAcquire.bind(adapter);
    let firstReply: LockLease;
    vi.spyOn(adapter, "tryAcquire")
      .mockImplementationOnce(async (request) => {
        firstReply = (await acquire(request))!;
        return firstReply;
      })
      .mockImplementationOnce(async (request) => {
        firstReply.ownerId = "successor";
        return acquire(request);
      });

    await expect(createManager(adapter).acquireMany(["first", "second"]))
      .rejects.toMatchObject({
        message: "Lock adapter returned an invalid acquisition batch.",
        errors: [expect.objectContaining({ message: "Lock adapter returned a mismatched acquisition batch." })],
      });
    expect(adapter.releaseRequests).toEqual([
      { key: "test:first", ownerId: "owner-1" },
      { key: "test:second", ownerId: "owner-2" },
    ]);
  });

  it.each([
    [{ namespace: "" }, "Lock namespaces cannot be empty"],
    [{ namespace: "other:scope" }, "Lock namespaces cannot contain a colon"],
    [{ maxTtlMs: 999 }, "defaultTtlMs cannot exceed maxTtlMs"],
    [{ defaultTtlMs: 0 }, "defaultTtlMs must be a positive finite number"],
    [{ maxTtlMs: Infinity }, "maxTtlMs must be a positive finite number"],
    [{ defaultWaitTimeoutMs: -1 }, "defaultWaitTimeoutMs must be a non-negative finite number"],
    [{ retryIntervalMs: 0 }, "retryIntervalMs must be a positive finite number"],
    [{ retryJitterRatio: -0.1 }, "retryJitterRatio must be between 0 and 1"],
    [{ retryJitterRatio: 2 }, "retryJitterRatio must be between 0 and 1"],
    [{ retryJitterRatio: NaN }, "retryJitterRatio must be between 0 and 1"],
  ] as const)("rejects inconsistent manager configuration (%j)", (overrides, message) => {
    const adapter = new RecordingAdapter();
    expect(() => createManager(adapter, overrides)).toThrow(message);
    expect(adapter.acquireRequests).toEqual([]);
  });

  it("accepts maximum jitter and equal default and maximum TTL", () => {
    expect(() => createManager(new RecordingAdapter(), {
      retryJitterRatio: 1, maxTtlMs: 1_000,
    })).not.toThrow();
  });

  it("times out, aborts and rejects duplicate lock batches", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    const locks = createManager(adapter, {
      now: () => new Date(0),
    });

    await expect(locks.acquireMany(["first", "second"], {
      waitTimeoutMs: 0,
    })).rejects.toBeInstanceOf(LockBatchAcquisitionTimeoutError);

    const controller = new AbortController();
    controller.abort();
    await expect(locks.acquireMany(["first", "second"], {
      signal: controller.signal,
    })).rejects.toBeInstanceOf(LockBatchAcquisitionAbortedError);
    await expect(locks.acquireMany(["same", "same"], { waitTimeoutMs: 0 }))
      .rejects.toThrow("duplicate keys");
  });

  it("extends a handle and updates it only after adapter confirmation", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);
    const lock = await locks.acquire("job");
    const originalExpiration = lock.expiresAt;
    adapter.extendResult = undefined;

    await expect(lock.extend(2_000)).rejects.toEqual(
      new LockLostError("job"),
    );
    expect(lock.expiresAt).toEqual(originalExpiration);
  });

  it("rejects a renewal for another owner and keeps the handle's release identity", async () => {
    const adapter = new RecordingAdapter();
    const lock = await createManager(adapter).acquire("job");
    const originalExpiration = lock.expiresAt;
    adapter.extendResult = {
      key: "test:job", ownerId: "another-owner", expiresAt: new Date(10_000), fencingToken: 8n,
    };

    await expect(lock.extend()).rejects.toThrow("Lock adapter returned a mismatched extension.");
    expect(lock.expiresAt).toEqual(originalExpiration);
    expect(lock.fencingToken).toBe(1n);
    await lock.release();
    expect(adapter.releaseRequests).toEqual([{ key: "test:job", ownerId: "owner-1" }]);
  });

  it("keeps handle expiration detached from callers and the store", async () => {
    let nowMs = 0;
    const now = () => new Date(nowMs);
    const storage = new MemoryLockAdapter({ now });
    const locks = createManager(storage, { now });
    const first = await locks.acquire("job", { ttlMs: 100 });
    first.expiresAt.setTime(100_000);

    expect(first.expiresAt).toEqual(new Date(100));
    nowMs = 100;
    const successor = await locks.tryAcquire("job");
    expect(successor!.fencingToken).toBeGreaterThan(first.fencingToken);
    await first.release();
    await expect(locks.tryAcquire("job")).resolves.toBeUndefined();
    await successor!.release();
  });

  it("makes release idempotent and prevents later extension", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);
    const lock = await locks.acquire("job");

    await lock.release();
    await lock.release();

    expect(adapter.releaseRequests).toHaveLength(1);
    await expect(lock.extend()).rejects.toEqual(
      new LockReleasedError("job"),
    );
  });

  it("detaches a handle from adapter-owned acquisition and renewal replies", async () => {
    class ExternalLease {
      public constructor(private readonly lease: LockLease) {}

      public get key(): string { return this.lease.key; }
      public get ownerId(): string { return this.lease.ownerId; }
      public get expiresAt(): Date { return this.lease.expiresAt; }
      public get fencingToken(): bigint { return this.lease.fencingToken; }
    }

    const adapter = new RecordingAdapter();
    const acquired = { key: "test:job", ownerId: "owner-1", expiresAt: new Date(1_000), fencingToken: 1n };
    const renewed = { ...acquired, expiresAt: new Date(2_000) };
    vi.spyOn(adapter, "tryAcquire").mockResolvedValue(new ExternalLease(acquired));
    vi.spyOn(adapter, "extend").mockResolvedValue(new ExternalLease(renewed));
    const handle = await createManager(adapter, { maxTtlMs: 1_000 }).acquire("job");

    // An external adapter can reuse a mutable response after ownership moves to a new lease.
    acquired.ownerId = "successor";
    acquired.expiresAt.setTime(5_000);
    acquired.fencingToken = 2n;
    expect(handle.expiresAt).toEqual(new Date(1_000));
    expect(handle.fencingToken).toBe(1n);
    await handle.extend(2_000);
    expect(adapter.extend).toHaveBeenCalledExactlyOnceWith({ key: "test:job", ownerId: "owner-1", ttlMs: 1_000 });
    renewed.ownerId = "successor";
    renewed.expiresAt.setTime(5_000);
    expect(handle.expiresAt).toEqual(new Date(2_000));
    await handle.release();
    expect(adapter.releaseRequests).toEqual([{ key: "test:job", ownerId: "owner-1" }]);
  });

  it.each([false, true])("shares a concurrent release result and allows retry after failure (%s)", async (fails) => {
    const adapter = new RecordingAdapter();
    const pending = Promise.withResolvers<boolean>();
    const release = vi.spyOn(adapter, "release").mockImplementation(() => pending.promise);
    const handle = await createManager(adapter).acquire("job");
    const calls = Promise.allSettled([handle.release(), handle.release()]);
    const failure = new Error("Release unavailable");
    try {
      await Promise.resolve();
      expect(release).toHaveBeenCalledExactlyOnceWith({ key: "test:job", ownerId: "owner-1" });
    } finally {
      if (fails) pending.reject(failure);
      else pending.resolve(true);
      await calls;
    }

    if (fails) {
      expect(await calls).toEqual([
        { status: "rejected", reason: failure }, { status: "rejected", reason: failure },
      ]);
      release.mockResolvedValue(true);
      await expect(handle.release()).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledTimes(2);
    } else {
      expect(await calls).toEqual([
        { status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined },
      ]);
      await handle.release();
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it("releases after successful and failed exclusive operations", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);

    await expect(locks.runExclusive("success", async () => "result"))
      .resolves.toBe("result");
    await expect(locks.runExclusive("failure", async () => {
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");

    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("extends a lock automatically while an exclusive handler runs", async () => {
    vi.useFakeTimers();
    const adapter = new RecordingAdapter();
    adapter.extendResult = {
      key: "test:job",
      ownerId: "owner-1",
      expiresAt: new Date(2_000),
      fencingToken: 1n,
    };
    const locks = createManager(adapter);
    const started = deferred();
    const finish = deferred();
    let handlerSignal: AbortSignal | undefined;
    const operation = locks.runExclusive("job", async (_lock, context) => {
      handlerSignal = context.signal;
      started.resolve();
      await finish.promise;
      return "result";
    });
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    expect(adapter.extendRequests).toHaveLength(1);
    expect(handlerSignal?.aborted).toBe(false);
    finish.resolve();
    await expect(operation).resolves.toBe("result");
    expect(adapter.releaseRequests).toHaveLength(1);
  });

  it("aborts the handler signal and reports a lost heartbeat lease", async () => {
    vi.useFakeTimers();
    const adapter = new RecordingAdapter();
    adapter.extendResult = undefined;
    const locks = createManager(adapter);
    const finish = deferred();
    let handlerSignal: AbortSignal | undefined;
    const operation = locks.runExclusive("job", async (_lock, { signal }) => {
      handlerSignal = signal;
      await finish.promise;
    }, { waitTimeoutMs: 0 });
    const outcome = Promise.allSettled([operation]);
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(handlerSignal?.aborted).toBe(true);
      expect(handlerSignal?.reason).toBeInstanceOf(LockLostError);
    } finally {
      finish.resolve();
      await outcome;
    }
    expect(await outcome).toEqual([{ status: "rejected", reason: handlerSignal?.reason }]);
    expect(adapter.releaseRequests).toHaveLength(1);
  });

  it("preserves operation and release failures in an AggregateError", async () => {
    const adapter = new RecordingAdapter();
    adapter.releaseError = new Error("release failed");
    const locks = createManager(adapter);

    const result = locks.runExclusive("job", async () => {
      throw new Error("operation failed");
    });

    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({
      message: 'Exclusive lock operation failed for "job".',
      errors: [
        expect.objectContaining({ message: "operation failed" }),
        adapter.releaseError,
      ],
    });
  });

  it("runs with many locks and releases all handles after failure", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);
    const operation = locks.runExclusiveMany(
      ["second", "first"],
      async (handles) => {
        expect(handles.map((handle) => handle.key)).toEqual([
          "second",
          "first",
        ]);
        throw new Error("operation failed");
      },
    );

    await expect(operation).rejects.toThrow("operation failed");
    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("uses adapter batch extension for a running lock batch", async () => {
    vi.useFakeTimers();
    const adapter = new BatchRecordingAdapter();
    const locks = createManager(adapter);
    const started = deferred();
    const finish = deferred();
    const operation = locks.runExclusiveMany(
      ["second", "first"],
      async (_handles, { signal }) => {
        expect(signal.aborted).toBe(false);
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    expect(adapter.extensionBatchRequests).toHaveLength(1);
    expect(adapter.extendRequests).toHaveLength(0);
    finish.resolve();
    await expect(operation).resolves.toBeUndefined();
  });

  it("aborts a batch handler when adapter batch extension loses ownership", async () => {
    vi.useFakeTimers();
    const adapter = new BatchRecordingAdapter();
    adapter.extensionBatchAvailable = false;
    const locks = createManager(adapter);
    const started = deferred();
    let abortReason: unknown;
    const operation = locks.runExclusiveMany(
      ["first", "second"],
      async (_handles, { signal }) => {
        started.resolve();
        await new Promise<void>((resolve) => signal.addEventListener(
          "abort",
          () => {
            abortReason = signal.reason;
            resolve();
          },
          { once: true },
        ));
      },
    );
    const outcome = expect(operation).rejects.toBeInstanceOf(AggregateError);
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    await outcome;
    expect(abortReason).toBeInstanceOf(AggregateError);
    expect(adapter.extensionBatchRequests).toHaveLength(1);
    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("falls back to all individual extensions for a lock batch", async () => {
    vi.useFakeTimers();
    const adapter = new RecordingAdapter();
    adapter.extendResults.set("test:first", {
      key: "test:first",
      ownerId: "owner-1",
      expiresAt: new Date(2_000),
      fencingToken: 1n,
    });
    adapter.extendResults.set("test:second", undefined);
    const locks = createManager(adapter);
    const started = deferred();
    const finish = deferred();
    let handlerSignal: AbortSignal | undefined;
    const operation = locks.runExclusiveMany(
      ["first", "second"],
      async (_handles, { signal }) => {
        handlerSignal = signal;
        started.resolve();
        await finish.promise;
      },
    ).then(() => undefined, (error: unknown) => error);
    await started.promise;

    try {
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      // Close the handler independently of cancellation so lost error propagation fails directly.
      finish.resolve();
    }

    const error = await operation;
    expect(handlerSignal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(LockLostError);
    expect(error).toBe(handlerSignal?.reason);
    expect(adapter.extendRequests).toHaveLength(2);
    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("aggregates a handler error with every batch release failure", async () => {
    const adapter = new RecordingAdapter();
    adapter.releaseError = new Error("release failed");
    const locks = createManager(adapter);

    const operation = locks.runExclusiveMany(
      ["first", "second"],
      async () => {
        throw new Error("operation failed");
      },
    );

    await expect(operation).rejects.toBeInstanceOf(AggregateError);
    await expect(operation).rejects.toMatchObject({
      message: "Exclusive lock batch operation failed.",
      errors: [
        expect.objectContaining({ message: "operation failed" }),
        adapter.releaseError,
        adapter.releaseError,
      ],
    });
    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("aggregates handler, heartbeat and release failures", async () => {
    vi.useFakeTimers();
    const adapter = new RecordingAdapter();
    adapter.extendResult = undefined;
    adapter.releaseError = new Error("release failed");
    const locks = createManager(adapter);
    const started = deferred();
    const operation = locks.runExclusive("job", async (_lock, { signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener(
        "abort",
        () => resolve(),
        { once: true },
      ));
      throw new Error("handler aborted");
    });
    const outcome = expect(operation).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "handler aborted" }),
        expect.any(LockLostError),
        adapter.releaseError,
      ],
    });
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    await outcome;
  });

  it("rejects invalid keys and timing options", async () => {
    const locks = createManager(new RecordingAdapter());

    await expect(locks.tryAcquire(""))
      .rejects.toThrow("Lock keys cannot be empty");
    await expect(locks.tryAcquire("job", { ttlMs: 0 }))
      .rejects.toThrow("ttlMs must be a positive finite number");
    await expect(locks.acquire("job", { waitTimeoutMs: -1 }))
      .rejects.toThrow("waitTimeoutMs must be a non-negative finite number");
    await expect(locks.acquire("job", { retryIntervalMs: 0 }))
      .rejects.toThrow("retryIntervalMs must be a positive finite number");
    await expect(locks.acquireMany(["job"], { waitTimeoutMs: -1 }))
      .rejects.toThrow("waitTimeoutMs must be a non-negative finite number");
    await expect(locks.acquireMany(["job"], { retryIntervalMs: 0 }))
      .rejects.toThrow("retryIntervalMs must be a positive finite number");
  });

  it("exports stable typed observation definitions", () => {
    expect(lockAcquisitionObservation).toMatchObject({
      name: "lock.acquisition",
      category: "lock",
      schemaVersion: 1,
    });
    expect(lockBatchAcquisitionObservation).toMatchObject({ name: "lock.batch-acquisition", category: "lock" });
    expect(lockExtensionObservation).toMatchObject({ name: "lock.extension", category: "lock" });
    expect(lockReleaseObservation).toMatchObject({ name: "lock.release", category: "lock" });
  });

  it.each([
    [new LockAcquisitionTimeoutError("one"), "LockAcquisitionTimeoutError", 'Lock "one" could not be acquired before the timeout.'],
    [new LockAcquisitionAbortedError("one"), "LockAcquisitionAbortedError", 'Lock acquisition for "one" was aborted.'],
    [new LockBatchAcquisitionTimeoutError(["one", "two"]), "LockBatchAcquisitionTimeoutError", 'Locks ["one", "two"] could not be acquired before the timeout.'],
    [new LockBatchAcquisitionAbortedError(["one", "two"]), "LockBatchAcquisitionAbortedError", 'Lock acquisition for ["one", "two"] was aborted.'],
    [new LockLostError("one"), "LockLostError", 'Lock "one" is no longer owned by this handle.'],
    [new LockReleasedError("one"), "LockReleasedError", 'Lock "one" has already been released.'],
  ])("exports the public error name and diagnostic for %s", (error, name, message) => {
    expect(error).toMatchObject({ name, message });
  });

  it("records immediate acquisition and contention outcomes", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    let time = 10;
    const locks = createManager(adapter, {
      instrumentation,
      formatObservationKey: (key) => `redacted:${key}`,
      monotonicNow: () => {
        time += 5;
        return time;
      },
    });

    await locks.tryAcquire("available", { ttlMs: 2_000 });
    adapter.available = false;
    await locks.tryAcquire("busy");

    expect(instrumentation.events).toEqual([
      {
        type: "acquisition",
        outcome: "success",
        durationMs: 5,
        data: {
          key: "redacted:available",
          mode: "immediate",
          result: "acquired",
          attempts: 1,
          ttlMs: 2_000,
          fencingToken: "1",
        },
      },
      {
        type: "acquisition",
        outcome: "success",
        durationMs: 5,
        data: {
          key: "redacted:busy",
          mode: "immediate",
          result: "contended",
          attempts: 1,
          ttlMs: 1_000,
        },
      },
    ]);
    expect(JSON.stringify(instrumentation.events)).not.toContain("owner-");
  });

  it("records retry count and total wait duration on acquisition", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    adapter.available = false;
    let nowMs = 0;
    const locks = createManager(adapter, {
      instrumentation,
      monotonicNow: () => nowMs,
      now: () => new Date(nowMs),
      sleep: async (delayMs) => {
        nowMs += delayMs;
        adapter.available = true;
      },
    });

    await locks.acquire("job", {
      ttlMs: 3_000,
      waitTimeoutMs: 100,
      retryIntervalMs: 20,
    });

    expect(instrumentation.events).toEqual([{
      type: "acquisition",
      outcome: "success",
      durationMs: 20,
      data: {
        key: "job",
        mode: "wait",
        result: "acquired",
        attempts: 2,
        ttlMs: 3_000,
        waitTimeoutMs: 100,
        fencingToken: "1",
      },
    }]);
  });

  it("records one formatted observation for a batch acquisition", async () => {
    const instrumentation = new RecordingInstrumentation();
    const locks = createManager(new RecordingAdapter(), {
      instrumentation,
      formatObservationKey: (key) => `formatted:${key}`,
      monotonicNow: () => 0,
    });

    await locks.acquireMany(["second", "first"]);

    expect(instrumentation.events).toContainEqual({
      type: "batch-acquisition",
      outcome: "success",
      durationMs: 0,
      data: {
        keys: ["formatted:second", "formatted:first"],
        result: "acquired",
        attempts: 1,
        ttlMs: 1_000,
        waitTimeoutMs: 100,
        fencingTokens: ["1", "1"],
      },
    });
  });

  it("classifies timeout, cancellation and storage acquisition errors", async () => {
    const timeoutInstrumentation = new RecordingInstrumentation();
    const timeoutAdapter = new RecordingAdapter();
    timeoutAdapter.available = false;
    let nowMs = 0;
    const timeoutLocks = createManager(timeoutAdapter, {
      instrumentation: timeoutInstrumentation,
      monotonicNow: () => nowMs,
      now: () => new Date(nowMs),
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
    });

    await expect(timeoutLocks.acquire("timeout", {
      waitTimeoutMs: 10,
      retryIntervalMs: 10,
    })).rejects.toBeInstanceOf(LockAcquisitionTimeoutError);

    const abortedInstrumentation = new RecordingInstrumentation();
    const abortedLocks = createManager(new RecordingAdapter(), {
      instrumentation: abortedInstrumentation,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(abortedLocks.acquire("aborted", {
      signal: controller.signal,
    })).rejects.toBeInstanceOf(LockAcquisitionAbortedError);

    const errorInstrumentation = new RecordingInstrumentation();
    const errorAdapter = new RecordingAdapter();
    errorAdapter.acquireError = new Error("storage failed");
    const errorLocks = createManager(errorAdapter, {
      instrumentation: errorInstrumentation,
    });
    await expect(errorLocks.tryAcquire("error"))
      .rejects.toBe(errorAdapter.acquireError);

    expect(timeoutInstrumentation.events[0]).toMatchObject({
      type: "acquisition",
      outcome: "failure",
      durationMs: 10,
      data: { result: "timeout", attempts: 1 },
    });
    expect(abortedInstrumentation.events[0]).toMatchObject({
      type: "acquisition",
      outcome: "failure",
      data: { result: "aborted", attempts: 0 },
    });
    expect(errorInstrumentation.events[0]).toMatchObject({
      type: "acquisition",
      outcome: "failure",
      data: { mode: "immediate", result: "error", attempts: 1 },
    });
  });

  it("records successful, lost and rejected lease extensions", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter, { instrumentation });
    const extended = await locks.acquire("extended");
    adapter.extendResult = {
      key: "test:extended",
      ownerId: "owner-1",
      expiresAt: new Date(2_000),
      fencingToken: 1n,
    };
    await extended.extend(2_000);

    const lost = await locks.acquire("lost");
    adapter.extendResult = undefined;
    await expect(lost.extend()).rejects.toBeInstanceOf(LockLostError);

    await extended.release();
    await expect(extended.extend()).rejects.toBeInstanceOf(
      LockReleasedError,
    );

    const extensionEvents = instrumentation.events.filter(
      (event) => event.type === "extension",
    );
    expect(extensionEvents.map((event) => event.data.result)).toEqual([
      "extended",
      "lost",
      "already-released",
    ]);
    expect(extensionEvents.map((event) => event.outcome)).toEqual([
      "success",
      "failure",
      "failure",
    ]);
  });

  it("records release ownership and total held duration", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    let time = 0;
    const locks = createManager(adapter, {
      instrumentation,
      monotonicNow: () => time,
    });
    const released = await locks.acquire("released");
    time = 50;
    await released.release();
    time = 60;
    await released.release();

    const missing = await locks.acquire("missing");
    adapter.releaseResult = false;
    time = 100;
    await missing.release();

    const releaseEvents = instrumentation.events.filter(
      (event) => event.type === "release",
    );
    expect(releaseEvents).toMatchObject([
      {
        outcome: "success",
        data: { result: "released", heldDurationMs: 50 },
      },
      {
        outcome: "success",
        data: { result: "already-released", heldDurationMs: 60 },
      },
      {
        outcome: "failure",
        data: { result: "not-owned", heldDurationMs: 40 },
      },
    ]);
  });

  it("records extension and release storage errors", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter, { instrumentation });
    const lock = await locks.acquire("job");
    adapter.extendError = new Error("extend failed");

    await expect(lock.extend()).rejects.toBe(adapter.extendError);

    adapter.releaseError = new Error("release failed");
    await expect(lock.release()).rejects.toBe(adapter.releaseError);

    expect(instrumentation.events.slice(1).map((event) => ({
      type: event.type,
      outcome: event.outcome,
      result: event.data.result,
    }))).toEqual([
      { type: "extension", outcome: "failure", result: "error" },
      { type: "release", outcome: "failure", result: "error" },
    ]);
  });

  it("ignores instrumentation and key formatting failures", async () => {
    const adapter = new RecordingAdapter();
    const instrumentation = {
      record: vi.fn(() => {
        throw new Error("instrumentation failed");
      }),
    };
    const locks = createManager(adapter, { instrumentation });
    const lock = await locks.acquire("job");

    await expect(lock.release()).resolves.toBeUndefined();
    expect(instrumentation.record).toHaveBeenCalledTimes(2);

    const formattingInstrumentation = new RecordingInstrumentation();
    const formattingFailure = createManager(adapter, {
      instrumentation: formattingInstrumentation,
      formatObservationKey: () => {
        throw new Error("formatting failed");
      },
    });
    const formattedLock = await formattingFailure.acquire("formatted");
    await expect(formattedLock.release()).resolves.toBeUndefined();
    expect(formattingInstrumentation.events).toHaveLength(0);

    const clockInstrumentation = new RecordingInstrumentation();
    const clockFailure = createManager(adapter, {
      instrumentation: clockInstrumentation,
      monotonicNow: () => {
        throw new Error("clock failed");
      },
    });
    const measuredLock = await clockFailure.acquire("measured");
    await expect(measuredLock.release()).resolves.toBeUndefined();
    expect(clockInstrumentation.events).toHaveLength(2);
    expect(clockInstrumentation.events.every(
      (event) => Number.isFinite(event.durationMs),
    )).toBe(true);

    const invalidClockInstrumentation = new RecordingInstrumentation();
    const invalidClock = createManager(adapter, {
      instrumentation: invalidClockInstrumentation,
      monotonicNow: () => Infinity,
    });
    await invalidClock.runExclusive("invalid-clock", () => undefined);
    expect(invalidClockInstrumentation.events.every((event) => Number.isFinite(event.durationMs))).toBe(true);
  });
});

class RecordingAdapter implements LockAdapter {
  public readonly acquireRequests: LockAcquireRequest[] = [];

  public readonly releaseRequests: LockReleaseRequest[] = [];

  public readonly extendRequests: LockExtendRequest[] = [];

  public readonly extendResults = new Map<
    string,
    LockLease | undefined
  >();

  public available = true;

  public readonly contendedKeys = new Set<string>();

  public extendResult: LockLease | undefined;

  public acquireError?: Error;

  public extendError?: Error;

  public releaseError?: Error;

  public releaseResult = true;

  public async tryAcquire(
    request: Parameters<LockAdapter["tryAcquire"]>[0],
  ): Promise<LockLease | undefined> {
    this.acquireRequests.push(request);

    if (this.acquireError !== undefined) {
      throw this.acquireError;
    }

    if (!this.available || this.contendedKeys.has(request.key)) {
      return undefined;
    }

    return {
      ...request,
      expiresAt: new Date(request.ttlMs),
      fencingToken: 1n,
    };
  }

  public async extend(
    request: Parameters<LockAdapter["extend"]>[0],
  ): Promise<LockLease | undefined> {
    this.extendRequests.push(request);

    if (this.extendError !== undefined) {
      throw this.extendError;
    }

    if (this.extendResults.has(request.key)) {
      return this.extendResults.get(request.key);
    }

    return this.extendResult;
  }

  public async release(request: LockReleaseRequest): Promise<boolean> {
    this.releaseRequests.push(request);

    if (this.releaseError !== undefined) {
      throw this.releaseError;
    }

    return this.releaseResult;
  }
}

class BatchRecordingAdapter extends RecordingAdapter {
  public readonly batchRequests: Array<readonly object[]> = [];

  public readonly extensionBatchRequests: Array<readonly object[]> = [];

  public extensionBatchAvailable = true;

  public async tryAcquireMany(
    requests: Parameters<NonNullable<LockAdapter["tryAcquireMany"]>>[0],
  ): Promise<readonly LockLease[] | undefined> {
    this.batchRequests.push(requests);

    return requests.map((request) => ({
      ...request,
      expiresAt: new Date(request.ttlMs),
      fencingToken: 1n,
    }));
  }

  public async extendMany(
    requests: Parameters<NonNullable<LockAdapter["extendMany"]>>[0],
  ): Promise<readonly LockLease[] | undefined> {
    this.extensionBatchRequests.push(requests);

    if (!this.extensionBatchAvailable) {
      return undefined;
    }

    return requests.map((request) => ({
      ...request,
      expiresAt: new Date(request.ttlMs * 2),
      fencingToken: 1n,
    }));
  }
}

class RecordingInstrumentation {
  public readonly events: LockInstrumentationEvent[] = [];

  public record(event: LockInstrumentationEvent): void {
    this.events.push(event);
  }
}

function createManager(
  adapter: LockAdapter,
  overrides: Partial<ConstructorParameters<typeof LockManager>[1]> = {},
): LockManager {
  let owner = 0;

  return new LockManager(adapter, {
    namespace: "test",
    defaultTtlMs: 1_000,
    maxTtlMs: 10_000,
    defaultWaitTimeoutMs: 100,
    retryIntervalMs: 10,
    retryJitterRatio: 0,
    now: () => new Date(0),
    createOwnerId: () => `owner-${++owner}`,
    random: () => 0.5,
    ...overrides,
  });
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}
