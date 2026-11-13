import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, type ExecutionScope } from "../app/index.js";
import type { LockHandle, Locks } from "../lock/index.js";
import { MemoryScheduledTaskAdapter } from "./adapters/memory/index.js";
import { every, loop, type ScheduledTaskSchedule } from "./schedule.js";
import { ScheduledTaskScheduler } from "./scheduler.js";
import { defineScheduledTask, type AnyScheduledTask, type ScheduledTaskOverlap } from "./task.js";

const epoch = new Date("2026-01-01T00:00:00.000Z");
const owned: Array<{ app: App<Record<string, never>>; scheduler: ScheduledTaskScheduler<Record<string, never>> }> = [];
const activeScopes = new WeakMap<App<Record<string, never>>, Set<ExecutionScope<Record<string, never>>>>();
afterEach(async () => {
  let openScopeCount = 0;
  try {
    for (const { app, scheduler } of owned.splice(0)) {
      try { await scheduler.stop(); } finally {
        const openScopes = [...(activeScopes.get(app) ?? [])];
        openScopeCount += openScopes.length;
        // Close scopes stranded by a failed scheduler before application disposal waits for them.
        try { await Promise.all(openScopes.map((scope) => scope.dispose("failure"))); }
        finally { await app.dispose(); }
      }
    }
    expect(openScopeCount, "execution scopes left open by the scheduler").toBe(0);
  } finally { vi.useRealTimers(); }
});

/** Fixed clocks and explicit gates make lifecycle races observable without wall-clock sleeps. */
async function setup(options: {
  distributed?: boolean;
  handler?: Parameters<typeof defineScheduledTask>[0]["handler"];
  sleep?: (delay: number, signal: AbortSignal) => Promise<void>;
  slots?: number;
  extraTasks?: readonly AnyScheduledTask[];
  pollIntervalMs?: number;
  reportErrors?: boolean;
  schedule?: ScheduledTaskSchedule;
  overlap?: ScheduledTaskOverlap;
  now?: () => Date;
  drainMs?: number;
} = {}) {
  const app = new App<Record<string, never>>({}, options.drainMs === undefined
    ? {}
    : { shutdown: { drainMs: options.drainMs } });
  const scopes = new Set<ExecutionScope<Record<string, never>>>();
  activeScopes.set(app, scopes);
  const create = app.createExecutionScope.bind(app);
  vi.spyOn(app, "createExecutionScope").mockImplementation(async (id) => {
    const scope = await create(id);
    scopes.add(scope);
    void scope.whenDisposed.then(() => scopes.delete(scope));
    return scope;
  });
  await app.start();
  const adapter = new MemoryScheduledTaskAdapter({ now: options.now ?? (() => epoch) });
  const lock: LockHandle = {
    key: "scheduled-task:contract.task", expiresAt: new Date(epoch.getTime() + 1_000), fencingToken: 1n,
    extend: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
  };
  // The scheduler consumes only tryAcquire; keep the provided capability controllable.
  const locks = { tryAcquire: vi.fn(async () => lock) } as unknown as Locks;
  const finish = Promise.withResolvers<void>();
  const handler = vi.fn(options.handler ?? (() => finish.promise));
  const task = defineScheduledTask({
    id: "contract.task", schedule: options.schedule ?? every({ milliseconds: 1_000, start: "immediate" }), overlap: options.overlap ?? "wait",
    runtime: { state: "memory", coordination: options.distributed ? "distributed" : "local" }, handler,
  });
  const reportError = vi.fn();
  const scheduler = new ScheduledTaskScheduler(app, { memory: adapter }, options.distributed ? locks : undefined, [task, ...options.extraTasks ?? []], {
    slots: options.slots ?? 1, leaseMs: 1_000, now: options.now ?? (() => epoch),
    ...(options.reportErrors === false ? {} : { reportError }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  owned.push({ app, scheduler });
  return { app, adapter, scheduler, task, handler, lock, locks, reportError, finish: () => finish.resolve() };
}

/** In-memory admission reaches a deliberately blocked handler within one event-loop turn. */
async function startedSignal(state: Awaited<ReturnType<typeof setup>>): Promise<AbortSignal> {
  await setImmediate();
  expect(state.handler).toHaveBeenCalledOnce();
  return state.handler.mock.calls[0]![1].signal;
}

/** Inspect completion without waiting for a callback that may have been removed. */
function observeSettlement<T>(work: Promise<T>): () => PromiseSettledResult<T> | undefined {
  let outcome: PromiseSettledResult<T> | undefined;
  void Promise.resolve(work).then(
    (value) => { outcome = { status: "fulfilled", value }; },
    (reason: unknown) => { outcome = { status: "rejected", reason }; },
  );
  return () => outcome;
}

describe("scheduled task lifecycle and ownership contracts", () => {
  it("rejects a concurrent start before reconciliation finishes", async () => {
    const sleeps: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
    const state = await setup({ handler: () => undefined, sleep: () => {
      const gate = Promise.withResolvers<void>(); sleeps.push(gate); return gate.promise;
    } });
    const reconcile = Promise.withResolvers<void>();
    vi.spyOn(state.adapter, "reconcile").mockReturnValue(reconcile.promise);
    const first = state.scheduler.start();
    const second = state.scheduler.start();
    const outcomes = Promise.allSettled([first, second]);
    try {
      reconcile.resolve();
      const results = await outcomes;
      await setImmediate();
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(sleeps).toHaveLength(1);
    } finally {
      reconcile.resolve();
      const stopping = state.scheduler.stop();
      // Also stop an orphaned original loop when testing the unfixed implementation.
      for (const gate of sleeps) gate.reject(new Error("test polling cleanup"));
      await outcomes;
      await stopping;
    }
  });

  it("rejects a second start during polling and accepts a delay rejection caused by stop", async () => {
    const proceed = Promise.withResolvers<void>();
    const sleep = vi.fn(async (_delay: number, signal: AbortSignal) => {
      await proceed.promise;
      // Fail independently even if a mutated start leaves a polling loop orphaned.
      throw signal.reason ?? new Error("test polling cleanup");
    });
    const state = await setup({ handler: () => undefined, sleep });
    try {
      await state.scheduler.start();
      await setImmediate();
      const completion = state.scheduler.completion;
      expect(sleep).toHaveBeenCalledOnce();
      await expect(state.scheduler.start()).rejects.toThrow("The scheduled task scheduler is already running.");
      expect(state.scheduler.completion).toBe(completion);
      const stopping = state.scheduler.stop();
      proceed.resolve();
      await expect(stopping).resolves.toBeUndefined();
      await expect(completion).resolves.toBeUndefined();
      expect(state.reportError).not.toHaveBeenCalled();
    } finally {
      const stopping = state.scheduler.stop();
      proceed.resolve();
      await Promise.allSettled([stopping, state.scheduler.completion]);
    }
  });

  it("can start fresh polling after a previous polling loop terminates", async () => {
    const first = new Error("first polling failure");
    const second = new Error("second polling failure");
    const sleep = vi.fn(async () => { throw second; }).mockRejectedValueOnce(first);
    const state = await setup({ handler: () => undefined, sleep });
    await state.scheduler.start();
    await expect(state.scheduler.completion).rejects.toBe(first);
    await state.scheduler.start();
    await expect(state.scheduler.completion).rejects.toBe(second);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not reconcile when admission is invoked after a stop before startup", async () => {
    const state = await setup({ handler: () => undefined });
    const reconcile = vi.spyOn(state.adapter, "reconcile");

    await state.scheduler.stop();
    await expect(state.scheduler.start()).resolves.toBeUndefined();
    await expect(state.scheduler.runOnce()).resolves.toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does not read state when a one-shot cycle stops during initialization", async () => {
    const state = await setup({ handler: () => undefined });
    const proceed = Promise.withResolvers<void>();
    const reconcile = vi.spyOn(state.adapter, "reconcile").mockReturnValue(proceed.promise);
    const list = vi.spyOn(state.adapter, "listStates");
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    let stopping: Promise<void> | undefined;
    try {
      await setImmediate();
      expect(reconcile).toHaveBeenCalledOnce();
      stopping = state.scheduler.stop();
      proceed.resolve();
      await expect(running).resolves.toBe(0);
      expect(list).not.toHaveBeenCalled();
      expect(state.handler).not.toHaveBeenCalled();
    } finally {
      proceed.resolve();
      await Promise.allSettled([running, stopping]);
    }
  });

  it("keeps a one-shot handler cancellable when polling starts while it is active", async () => {
    const state = await setup();
    const running = state.scheduler.runOnce();
    let stopping: Promise<void> | undefined;
    try {
      const signal = await startedSignal(state);
      await state.scheduler.start();
      expect(signal.aborted).toBe(false);
      stopping = state.scheduler.stop();
      expect(signal.aborted).toBe(true);
    } finally { state.finish(); await Promise.allSettled([running, stopping]); }
  });

  it("forwards the application drain budget reason to an independently active invocation", async () => {
    vi.useFakeTimers();
    const state = await setup({ drainMs: 20 });
    const running = state.scheduler.runOnce();
    try {
      const signal = await startedSignal(state);
      await state.app.stop();
      await vi.advanceTimersByTimeAsync(19);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(state.app.shutdown.signal.reason);
    } finally { state.finish(); await running; }
  });

  it("waits for startup reconciliation when stop races with start", async () => {
    const exitPolling = Promise.withResolvers<void>();
    const state = await setup({ handler: () => undefined, sleep: async () => {
      await exitPolling.promise;
      throw new Error("test polling cleanup");
    } });
    const reconcile = Promise.withResolvers<void>();
    vi.spyOn(state.adapter, "reconcile").mockReturnValue(reconcile.promise);
    const starting = state.scheduler.start();
    const stopping = state.scheduler.stop();
    const startOutcome = observeSettlement(starting);
    const stopOutcome = observeSettlement(stopping);
    try {
      await setImmediate();
      expect(stopOutcome()).toBeUndefined();
      reconcile.resolve();
      await setImmediate();
      expect(startOutcome()).toEqual({ status: "fulfilled", value: undefined });
      expect(stopOutcome()).toEqual({ status: "fulfilled", value: undefined });
      expect(state.handler).not.toHaveBeenCalled();
      expect(state.scheduler.completion).toBeUndefined();
    } finally {
      reconcile.resolve();
      // Terminate a loop that incorrectly starts after the stop call.
      exitPolling.resolve();
      await Promise.allSettled([starting, stopping]);
    }
  });

  it.each(["reconcile", "listStates"] as const)("drains a failed %s operation during stop", async (method) => {
    const state = await setup({ handler: () => undefined });
    const entered = Promise.withResolvers<void>();
    const rejected = Promise.withResolvers<never>();
    const failure = new Error(`Could not ${method}`);
    vi.spyOn(state.adapter, method).mockImplementation(() => {
      entered.resolve();
      return rejected.promise;
    });
    const running = observeSettlement(state.scheduler.runOnce());
    await entered.promise;
    const stopping = state.scheduler.stop();
    const stopped = observeSettlement(stopping);

    try {
      await setImmediate();
      expect(stopped()).toBeUndefined();
    } finally {
      rejected.reject(failure);
      await stopping;
    }
    expect(running()).toEqual({ status: "rejected", reason: failure });
    expect(state.handler).not.toHaveBeenCalled();
  });

  it("does not admit an invocation after stop while loading states", async () => {
    const clock = vi.fn(() => epoch);
    const state = await setup({ handler: () => undefined, now: clock });
    const proceed = Promise.withResolvers<void>();
    const original = state.adapter.listStates.bind(state.adapter);
    const list = vi.spyOn(state.adapter, "listStates").mockImplementation(async (ids) => {
      const states = await original(ids);
      await proceed.promise;
      return states;
    });
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    try {
      await setImmediate();
      expect(list).toHaveBeenCalledOnce();
      clock.mockClear();
      const stopping = state.scheduler.stop();
      proceed.resolve();
      await stopping;
      expect(await running).toBe(0);
      expect(state.handler).not.toHaveBeenCalled();
      expect(clock).not.toHaveBeenCalled();
    } finally { proceed.resolve(); await running; }
  });

  it("returns a reservation instead of starting work when stop races with reserve", async () => {
    const laterTask = defineScheduledTask({
      id: "later.task", schedule: every({ seconds: 1, start: "immediate" }),
      runtime: { state: "memory", coordination: "distributed" }, handler: vi.fn(),
    });
    const state = await setup({ distributed: true, handler: () => undefined, slots: 2, extraTasks: [laterTask] });
    const proceed = Promise.withResolvers<void>();
    const original = state.adapter.reserve.bind(state.adapter);
    let reserved: Awaited<ReturnType<typeof original>> | undefined;
    vi.spyOn(state.adapter, "reserve").mockImplementation(async (request) => {
      const result = await original(request);
      reserved = result;
      await proceed.promise;
      return result;
    });
    const release = vi.spyOn(state.adapter, "release");
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    try {
      await setImmediate();
      expect(reserved).toMatchObject({ status: "reserved" });
      const stopping = state.scheduler.stop();
      const stopOutcome = observeSettlement(stopping);
      await setImmediate();
      expect(stopOutcome()).toBeUndefined();
      proceed.resolve();
      await stopping;
      expect(await running).toBe(0);
      expect(state.handler).not.toHaveBeenCalled();
      expect(laterTask.handler).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(state.lock.release).toHaveBeenCalledOnce();
      expect(state.locks.tryAcquire).toHaveBeenCalledOnce();
      expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({ activeRuns: 0, nextScheduledAt: epoch });
    } finally { proceed.resolve(); await running; }
  });

  it("releases late reservations when the application drain expires independently of scheduler stop", async () => {
    vi.useFakeTimers();
    const state = await setup({ distributed: true, handler: () => undefined, drainMs: 20 });
    const proceed = Promise.withResolvers<void>();
    const reserve = state.adapter.reserve.bind(state.adapter);
    const pendingReserve = vi.spyOn(state.adapter, "reserve").mockImplementation(async (request) => {
      const result = await reserve(request);
      await proceed.promise;
      return result;
    });
    const release = vi.spyOn(state.adapter, "release");
    const running = state.scheduler.runOnce();
    try {
      await setImmediate();
      expect(pendingReserve).toHaveBeenCalledOnce();
      await state.app.stop();
      await vi.advanceTimersByTimeAsync(20);
      expect(state.app.shutdown.signal.aborted).toBe(true);
      proceed.resolve();
      expect(await running).toBe(0);
      expect(state.app.createExecutionScope).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(state.lock.release).toHaveBeenCalledOnce();
      expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({ activeRuns: 0, nextScheduledAt: epoch });
      expect(await state.scheduler.runOnce()).toBe(0);
      expect(pendingReserve).toHaveBeenCalledOnce();
    } finally { proceed.resolve(); await running; }
  });

  it("aborts the owned invocation and records failure when its reservation renewal is refused", async () => {
    vi.useFakeTimers();
    const state = await setup();
    vi.spyOn(state.adapter, "extendLease").mockResolvedValue(false);
    const record = vi.fn();
    state.app.container.registerValue("observer", { record });
    const complete = vi.spyOn(state.adapter, "complete");
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    let signal: AbortSignal;
    try {
      signal = await startedSignal(state);
      await vi.advanceTimersByTimeAsync(500);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(Error);
      expect(signal.reason.message).toBe(`Scheduled task reservation ownership was lost for "${state.task.id}".`);
    } finally { state.finish(); await running; }
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure", error: expect.objectContaining({ name: "Error" }) }));
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(signal.reason);
    const completed = record.mock.calls.find(([definition]) => definition.name === "execution.completed");
    expect(completed?.[2]).toMatchObject({ outcome: "failure" });
    expect(completed?.[1].error).toMatchObject({ name: "Error", message: signal.reason.message });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never enters a handler if reservation ownership is lost while creating its scope", async () => {
    vi.useFakeTimers();
    const state = await setup({ handler: () => undefined });
    const releaseScope = Promise.withResolvers<void>();
    const create = state.app.createExecutionScope.bind(state.app);
    const createScope = vi.mocked(state.app.createExecutionScope).mockImplementationOnce(async (id) => {
      await releaseScope.promise;
      return create(id);
    });
    const ownershipFailure = new Error("reservation backend denied renewal");
    const renew = vi.spyOn(state.adapter, "extendLease").mockRejectedValue(ownershipFailure);
    const complete = vi.spyOn(state.adapter, "complete");
    const running = state.scheduler.runOnce();
    try {
      await setImmediate();
      expect(createScope).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(500);
      expect(renew).toHaveBeenCalledOnce();
      releaseScope.resolve();
      expect(await running).toBe(1);
      expect(state.handler).not.toHaveBeenCalled();
      expect(state.reportError).toHaveBeenCalledExactlyOnceWith(ownershipFailure);
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
    } finally { releaseScope.resolve(); await running; }
  });

  it("waits for a pending lock renewal after the reservation renewal fails", async () => {
    vi.useFakeTimers();
    const state = await setup({ distributed: true });
    const failure = new Error("reservation backend unavailable");
    vi.spyOn(state.adapter, "extendLease").mockRejectedValue(failure);
    const lockRenewal = Promise.withResolvers<void>();
    vi.mocked(state.lock.extend).mockReturnValue(lockRenewal.promise);
    const complete = vi.spyOn(state.adapter, "complete");
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    try {
      const signal = await startedSignal(state);
      await vi.advanceTimersByTimeAsync(500);
      state.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(failure);
      expect(complete).not.toHaveBeenCalled();
      expect(state.lock.release).not.toHaveBeenCalled();
    } finally { lockRenewal.resolve(); state.finish(); await running; }
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
    expect(state.lock.release).toHaveBeenCalledOnce();
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
  });
});

// Configuration and adapter failure tests keep their work synchronous or explicitly gated.
describe("scheduled task admission and error boundaries", () => {
  for (const option of ["slots", "leaseMs", "pollIntervalMs"] as const) {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      it(`rejects invalid ${option} ${String(value)}`, async () => {
        const state = await setup({ handler: () => undefined });
        expect(() => new ScheduledTaskScheduler(state.app, { memory: state.adapter }, undefined, [state.task], {
          slots: 1, leaseMs: 1_000, [option]: value,
        })).toThrow(new TypeError(`${option} must be a positive integer.`));
      });
    }
  }

  it("publishes one initialization before a synchronous adapter callback reenters runOnce", async () => {
    const state = await setup({ handler: () => undefined });
    let reentered: Promise<number> | undefined;
    let requested = false;
    const reconcile = state.adapter.reconcile.bind(state.adapter);
    vi.spyOn(state.adapter, "reconcile").mockImplementation((registrations) => {
      if (!requested) {
        requested = true;
        reentered = state.scheduler.runOnce();
        void reentered.catch(() => undefined);
      }
      return reconcile(registrations);
    });
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(await reentered).toBe(1);
    expect(state.adapter.reconcile).toHaveBeenCalledOnce();
    expect(state.handler).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent admission while a state read is pending", async () => {
    const state = await setup({ handler: () => undefined });
    const proceed = Promise.withResolvers<void>();
    const original = state.adapter.listStates.bind(state.adapter);
    const list = vi.spyOn(state.adapter, "listStates").mockImplementation(async (ids) => {
      await proceed.promise;
      return original(ids);
    });
    const first = state.scheduler.runOnce();
    void first.catch(() => undefined);
    let second: Promise<number> | undefined;
    try {
      await setImmediate();
      expect(list).toHaveBeenCalledOnce();
      second = state.scheduler.runOnce();
      proceed.resolve();
      expect(await Promise.all([first, second])).toEqual([1, 1]);
      expect(list).toHaveBeenCalledOnce();
      expect(state.handler).toHaveBeenCalledOnce();
    } finally { proceed.resolve(); await Promise.allSettled([first, second]); }
  });

  it("does not reserve beyond capacity and drains the active invocation", async () => {
    const state = await setup();
    const list = vi.spyOn(state.adapter, "listStates");
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    let second: Promise<number> | undefined;
    try {
      await startedSignal(state);
      second = state.scheduler.runOnce();
      const secondOutcome = observeSettlement(second);
      await setImmediate();
      expect(secondOutcome()).toEqual({ status: "fulfilled", value: 0 });
      expect(list).toHaveBeenCalledOnce();
      const stopping = state.scheduler.stop();
      let drained = false;
      void stopping.then(() => { drained = true; });
      await setImmediate();
      expect(drained).toBe(false);
      state.finish();
      await stopping;
    } finally { state.finish(); await Promise.all([running, second]); }
    expect(await state.scheduler.runOnce()).toBe(0);
    expect(list).toHaveBeenCalledOnce();
  });

  it("releases the overlap lock when adapter reservation rejects", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    const failure = new Error("reservation unavailable");
    vi.spyOn(state.adapter, "reserve").mockRejectedValue(failure);
    await expect(state.scheduler.runOnce()).rejects.toBe(failure);
    expect(state.handler).not.toHaveBeenCalled();
    expect(state.lock.release).toHaveBeenCalledOnce();
  });

  it("reports a failed early lock release without attempting it a second time", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    const failure = new Error("lock release failed");
    vi.mocked(state.lock.release).mockRejectedValue(failure);
    vi.spyOn(state.adapter, "reserve").mockResolvedValue({ status: "stale" });
    await expect(state.scheduler.runOnce()).rejects.toBe(failure);
    expect(state.lock.release).toHaveBeenCalledOnce();
    expect(state.handler).not.toHaveBeenCalled();
  });

  it("preserves both admission and lock cleanup failures", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    const admission = new Error("reservation backend unavailable");
    const cleanup = new Error("overlap lock backend unavailable");
    vi.spyOn(state.adapter, "reserve").mockRejectedValue(admission);
    vi.mocked(state.lock.release).mockRejectedValue(cleanup);
    await expect(state.scheduler.runOnce()).rejects.toMatchObject({
      name: "AggregateError",
      message: "Scheduled task admission and overlap lock release failed.",
      errors: [admission, cleanup],
    });
    expect(state.lock.release).toHaveBeenCalledOnce();
    expect(state.handler).not.toHaveBeenCalled();
  });

  for (const status of ["contended", "paused", "stale", "skipped"] as const) {
    it(`releases the overlap lock for a ${status} reservation`, async () => {
      const state = await setup({ distributed: true, handler: () => undefined });
      vi.spyOn(state.adapter, "reserve").mockResolvedValue({ status });
      expect(await state.scheduler.runOnce()).toBe(0);
      expect(state.handler).not.toHaveBeenCalled();
      expect(state.lock.release).toHaveBeenCalledOnce();
    });
  }

  it("does not reserve when a distributed overlap lock is busy", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    vi.mocked(state.locks.tryAcquire).mockResolvedValue(undefined);
    const reserve = vi.spyOn(state.adapter, "reserve");
    expect(await state.scheduler.runOnce()).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(state.handler).not.toHaveBeenCalled();
  });

  it("uses a free slot for an unrelated due task when an earlier lock is busy", async () => {
    const later = vi.fn();
    const independent = defineScheduledTask({
      id: "later.task",
      schedule: every({ milliseconds: 1_000, start: "immediate" }),
      runtime: { state: "memory", coordination: "local" },
      handler: later,
    });
    const state = await setup({
      distributed: true,
      handler: () => undefined,
      extraTasks: [independent],
    });
    vi.mocked(state.locks.tryAcquire).mockResolvedValue(undefined);

    // The blocked occurrence remains due and must not monopolize the only slot.
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(state.handler).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledOnce();
    const states = await state.adapter.listStates([state.task.id, independent.id]);
    expect(states).toMatchObject([
      { nextScheduledAt: epoch, activeRuns: 0 },
      { nextScheduledAt: new Date(epoch.getTime() + 1_000), activeRuns: 0 },
    ]);
  });

  it.each(["local", "distributed"] as const)("retains a %s wait occurrence under contention and runs it later", async (coordination) => {
    const distributed = coordination === "distributed";
    const state = await setup({ distributed, overlap: "wait", slots: 2 });
    const skip = vi.spyOn(state.adapter, "skip");
    const first = state.scheduler.runOnce();
    let second: Promise<number> | undefined;
    try {
      await startedSignal(state);
      await state.adapter.requestRun(state.task.id);
      if (distributed) vi.mocked(state.locks.tryAcquire).mockResolvedValueOnce(undefined);
      second = state.scheduler.runOnce();
      const outcome = observeSettlement(second);
      await setImmediate();
      expect(outcome()).toEqual({ status: "fulfilled", value: 0 });
      expect(skip).not.toHaveBeenCalled();
      expect(state.locks.tryAcquire).toHaveBeenCalledTimes(distributed ? 2 : 0);
      expect((await state.adapter.listStates([state.task.id]))[0]!.manualRunRequestedAt).toEqual(epoch);
    } finally { state.finish(); await Promise.allSettled([first, second]); }
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(state.handler.mock.calls.map(([, context]) => context.trigger)).toEqual(["scheduled", "manual"]);
  });

  it("records an ordinary handler failure and keeps admission usable", async () => {
    const failure = new Error("handler failed");
    const state = await setup({ distributed: true, handler: () => { throw failure; } });
    const complete = vi.spyOn(state.adapter, "complete");
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure", error: expect.objectContaining({ name: "Error", message: failure.message }) }));
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(state.lock.release).toHaveBeenCalledOnce();
    expect(await state.scheduler.runOnce()).toBe(0);
  });

  it("persists a failure when no error reporter is configured", async () => {
    const state = await setup({
      reportErrors: false,
      handler: () => { throw new Error("handler failed"); },
    });

    expect(await state.scheduler.runOnce()).toBe(1);
    expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({
      activeRuns: 0,
      lastOutcome: "failure",
      lastError: { message: "handler failed" },
    });
  });

  it("persists an unprintable handler failure and releases its reservation", async () => {
    const failure: unknown = Object.create(null);
    const state = await setup({ distributed: true, handler: () => { throw failure; } });

    expect(await state.scheduler.runOnce()).toBe(1);
    expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({
      activeRuns: 0,
      lastOutcome: "failure",
      lastError: { message: "The thrown value could not be converted to a string." },
    });
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(state.lock.release).toHaveBeenCalledOnce();
  });

  it.each(["reconcile", "listStates"] as const)("drains a sibling adapter's %s when another adapter fails first", async (method) => {
    const state = await setup({ handler: () => undefined });
    const other = new MemoryScheduledTaskAdapter({ now: () => epoch });
    const sibling = defineScheduledTask({
      ...state.task, id: "sibling.task", runtime: { state: "persistent", coordination: "local" },
    });
    const scheduler = new ScheduledTaskScheduler(state.app, { memory: state.adapter, persistent: other }, undefined, [state.task, sibling], {
      slots: 2, leaseMs: 1_000, now: () => epoch,
    });
    owned.push({ app: state.app, scheduler });
    const failure = new Error(`first ${method} failed`);
    const pending = Promise.withResolvers<never>();
    vi.spyOn(state.adapter, method).mockRejectedValue(failure);
    const siblingCall = vi.spyOn(other, method).mockReturnValue(pending.promise);
    const running = observeSettlement(scheduler.runOnce());

    try {
      await setImmediate();
      expect(siblingCall).toHaveBeenCalledOnce();
      const stopping = scheduler.stop();
      const stopped = observeSettlement(stopping);
      await setImmediate();
      expect(running()).toBeUndefined();
      expect(stopped()).toBeUndefined();
      pending.reject(new Error(`sibling ${method} failed`));
      await stopping;
      expect(running()).toEqual({ status: "rejected", reason: failure });
      expect(state.handler).not.toHaveBeenCalled();
    } finally { pending.reject(new Error("test cleanup")); }
  });

  it("reports each task failure once even when the injected reporter itself throws", async () => {
    const failure = new Error("handler failed");
    const reporterFailure = new Error("diagnostic sink unavailable");
    const state = await setup({ distributed: true, handler: () => { throw failure; } });
    state.reportError.mockImplementationOnce(() => { throw reporterFailure; });
    await expect(state.scheduler.runOnce()).rejects.toBe(reporterFailure);
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(state.lock.release).toHaveBeenCalledOnce();
    expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({ activeRuns: 0, lastOutcome: "failure" });
    // Even a failed reporter must release the admission slot for another occurrence.
    await state.adapter.requestRun(state.task.id);
    expect(await state.scheduler.runOnce()).toBe(1);
  });

  it("waits for every one-shot invocation even if error reporting fails first", async () => {
    const pending = Promise.withResolvers<void>();
    const sibling = defineScheduledTask({
      id: "sibling.task", schedule: every({ seconds: 1, start: "immediate" }),
      runtime: { state: "memory", coordination: "local" }, handler: vi.fn(() => pending.promise),
    });
    const failure = new Error("task failed");
    const reporterFailure = new Error("diagnostic sink unavailable");
    const state = await setup({ slots: 2, extraTasks: [sibling], handler: () => { throw failure; } });
    state.reportError.mockImplementationOnce(() => { throw reporterFailure; });
    const running = observeSettlement(state.scheduler.runOnce());

    try {
      await setImmediate();
      expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(sibling.handler).toHaveBeenCalledOnce();
      expect(running()).toBeUndefined();
      pending.resolve();
      await setImmediate();
      expect(running()).toEqual({ status: "rejected", reason: reporterFailure });
    } finally { pending.resolve(); }
  });

  it("continues releasing the overlap lock after completion storage fails", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    const failure = new Error("completion unavailable");
    vi.spyOn(state.adapter, "complete").mockRejectedValue(failure);
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(state.lock.release).toHaveBeenCalledOnce();
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("reports overlap lock release failure after successful task completion", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    const failure = new Error("lock release unavailable");
    vi.mocked(state.lock.release).mockRejectedValue(failure);
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({ activeRuns: 0, lastOutcome: "success" });
  });

  it("reports execution-scope creation failure and releases its reservation ownership", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    const failure = new Error("scope unavailable");
    vi.spyOn(state.app, "createExecutionScope").mockRejectedValue(failure);
    const complete = vi.spyOn(state.adapter, "complete");
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(state.handler).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
    expect(state.lock.release).toHaveBeenCalledOnce();
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
  });
});

describe("scheduled task policy and polling contracts", () => {
  it("does not read the clock to admit candidates when no tasks are selected", async () => {
    const state = await setup({ handler: () => undefined });
    const now = vi.fn(() => epoch);
    const scheduler = new ScheduledTaskScheduler(state.app, {}, undefined, [], { slots: 1, leaseMs: 1_000, now });
    owned.push({ app: state.app, scheduler });
    expect(await scheduler.runOnce()).toBe(0);
    expect(now).toHaveBeenCalledOnce(); // Reconciliation owns the initial read.
  });

  it("skips missing adapter state instead of constructing an invalid reservation", async () => {
    const state = await setup({ handler: () => undefined });
    vi.spyOn(state.adapter, "listStates").mockResolvedValue([]);
    expect(await state.scheduler.runOnce()).toBe(0);
    expect(state.handler).not.toHaveBeenCalled();
  });

  it("leaves future occurrences unclaimed", async () => {
    const state = await setup({ handler: () => undefined });
    await state.adapter.reconcile([{ taskId: state.task.id, nextScheduledAt: new Date(epoch.getTime() + 60_000) }]);
    const reserve = vi.spyOn(state.adapter, "reserve");
    expect(await state.scheduler.runOnce()).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
  });

  for (const coordination of ["local", "distributed"] as const) {
    it(`skips an overlapping ${coordination} occurrence without running its handler`, async () => {
      const state = await setup({ distributed: coordination === "distributed", handler: () => undefined });
      const skipTask = defineScheduledTask({ ...state.task, overlap: "skip" });
      const scheduler = new ScheduledTaskScheduler(state.app, { memory: state.adapter }, coordination === "distributed" ? state.locks : undefined, [skipTask], { slots: 2, leaseMs: 1_000, now: () => epoch });
      owned.push({ app: state.app, scheduler });
      const skip = vi.spyOn(state.adapter, "skip");
      if (coordination === "distributed") {
        vi.mocked(state.locks.tryAcquire).mockResolvedValue(undefined);
        expect(await scheduler.runOnce()).toBe(0);
      } else {
        const blocked = Promise.withResolvers<void>();
        const handler = vi.spyOn(skipTask, "handler").mockImplementation(() => blocked.promise);
        const running = scheduler.runOnce();
        void running.catch(() => undefined);
        let second: Promise<number> | undefined;
        try {
          await setImmediate();
          expect(handler).toHaveBeenCalledOnce();
          await state.adapter.requestRun(skipTask.id);
          second = scheduler.runOnce();
          const secondOutcome = observeSettlement(second);
          await setImmediate();
          expect(secondOutcome()).toEqual({ status: "fulfilled", value: 0 });
          expect(handler).toHaveBeenCalledOnce();
        } finally { blocked.resolve(); await Promise.all([running, second]); }
      }
      expect(skip).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ taskId: skipTask.id, overlap: "skip" }));
    });
  }

  for (const variant of ["duplicate", "persistent", "distributed", "state-override", "coordination-override"] as const) {
    it(`rejects an invalid ${variant} task composition`, async () => {
      const state = await setup({ handler: () => undefined });
      const task = defineScheduledTask({ ...state.task, runtime: variant === "persistent" ? { state: "persistent", coordination: "local" }
        : variant === "distributed" ? { state: "memory", coordination: "distributed" }
          : variant === "state-override" ? { state: "memory" }
            : variant === "coordination-override" ? { coordination: "local" }
              : state.task.runtime });
      // Supply unrelated infrastructure so another constructor guard cannot mask this rejection.
      expect(() => new ScheduledTaskScheduler(state.app,
        { memory: state.adapter, ...(variant.endsWith("override") ? { persistent: state.adapter } : {}) },
        variant.endsWith("override") ? state.locks : undefined,
        variant === "duplicate" ? [task, defineScheduledTask({ ...task })] : [task], {
          slots: 1, leaseMs: 1_000,
          ...(variant.endsWith("override") ? { allowTaskRuntimeOverrides: false } : {}),
        })).toThrow(expect.objectContaining({ name: "TypeError", message: expect.stringContaining(task.id) }));
    });
  }

  it("uses persistent distributed defaults when a task declares no overrides", async () => {
    const state = await setup({ handler: () => undefined });
    const task = defineScheduledTask({ ...state.task, runtime: {} });
    const scheduler = new ScheduledTaskScheduler(state.app, { persistent: state.adapter }, state.locks, [task], { slots: 1, leaseMs: 2_000, now: () => epoch });
    owned.push({ app: state.app, scheduler });
    expect(await scheduler.runOnce()).toBe(1);
    expect(state.locks.tryAcquire).toHaveBeenCalledExactlyOnceWith(`scheduled-task:${task.id}`, { ttlMs: 2_000 });
    expect(state.lock.release).toHaveBeenCalledOnce();
  });

  it("respects a memory/local default without explicit task overrides", async () => {
    const state = await setup({ handler: () => undefined });
    const task = defineScheduledTask({ ...state.task, runtime: {} });
    const scheduler = new ScheduledTaskScheduler(state.app, { memory: state.adapter }, undefined, [task], {
      slots: 1, leaseMs: 1_000, now: () => epoch, defaultRuntime: { state: "memory", coordination: "local" }, allowTaskRuntimeOverrides: false,
    });
    owned.push({ app: state.app, scheduler });
    expect(await scheduler.runOnce()).toBe(1);
    expect((await state.adapter.listStates([task.id]))[0]!.lastOutcome).toBe("success");
  });

  it("orders due dates before declaration order and applies the slot bound", async () => {
    const calls: string[] = [];
    const earlier = defineScheduledTask({ id: "earlier.task", schedule: { ...every({ seconds: 1 }), initial: () => new Date(epoch.getTime() - 1) },
      runtime: { state: "memory", coordination: "local" }, handler: () => { calls.push("earlier"); } });
    const state = await setup({ slots: 1, extraTasks: [earlier], handler: () => { calls.push("default"); } });
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(calls).toEqual(["earlier"]);
  });

  it("uses task identity as the deterministic tie-breaker for due work", async () => {
    const calls: string[] = [];
    const alpha = defineScheduledTask({ id: "alpha.task", schedule: every({ seconds: 1, start: "immediate" }),
      runtime: { state: "memory", coordination: "local" }, handler: () => { calls.push("alpha"); } });
    const zulu = defineScheduledTask({ id: "zulu.task", schedule: every({ seconds: 1, start: "immediate" }),
      runtime: { state: "memory", coordination: "local" }, handler: () => { calls.push("zulu"); } });
    const state = await setup({ slots: 2, extraTasks: [zulu, alpha], handler: () => { calls.push("default"); } });
    expect(await state.scheduler.runOnce()).toBe(2);
    expect(calls).toEqual(["alpha", "default"]);
  });

  it("cancels only the invocation whose reservation renewal fails", async () => {
    vi.useFakeTimers();
    const finishSibling = Promise.withResolvers<void>();
    const siblingHandler = vi.fn<Parameters<typeof defineScheduledTask>[0]["handler"]>(() => finishSibling.promise);
    const sibling = defineScheduledTask({ id: "sibling.task", schedule: every({ seconds: 1, start: "immediate" }),
      runtime: { state: "memory", coordination: "local" }, handler: siblingHandler });
    const state = await setup({ slots: 2, extraTasks: [sibling] });
    const renew = state.adapter.extendLease.bind(state.adapter);
    vi.spyOn(state.adapter, "extendLease").mockImplementation((request) => request.taskId === state.task.id ? Promise.resolve(false) : renew(request));
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    let failedSignal: AbortSignal;
    try {
      failedSignal = await startedSignal(state);
      expect(siblingHandler).toHaveBeenCalledOnce();
      const siblingSignal = siblingHandler.mock.calls[0]![1].signal;
      await vi.advanceTimersByTimeAsync(500);
      expect(failedSignal.aborted).toBe(true);
      expect(siblingSignal.aborted).toBe(false);
    } finally { state.finish(); finishSibling.resolve(); await running; }
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failedSignal.reason);
    expect((await state.adapter.listStates([sibling.id]))[0]!.lastOutcome).toBe("success");
  });

  it("does not overlap lease renewals and stops them at cooperative shutdown", async () => {
    vi.useFakeTimers();
    const state = await setup({ distributed: true });
    const pending = Promise.withResolvers<boolean>();
    const renew = vi.spyOn(state.adapter, "extendLease").mockReturnValue(pending.promise);
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    try {
      const signal = await startedSignal(state);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(renew).toHaveBeenCalledOnce();
      expect(state.lock.extend).toHaveBeenCalledOnce();
      const stopping = state.scheduler.stop();
      expect(signal.aborted).toBe(true);
      pending.resolve(true); state.finish();
      await stopping;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renew).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { pending.resolve(true); state.finish(); await running; }
  });

  it("renews repeatedly at half the lease and removes its timer and listener on completion", async () => {
    vi.useFakeTimers();
    const state = await setup({ distributed: true });
    const renew = vi.spyOn(state.adapter, "extendLease");
    const running = state.scheduler.runOnce();
    try {
      const signal = await startedSignal(state);
      for (const count of [1, 2]) {
        await vi.advanceTimersByTimeAsync(499);
        expect(renew).toHaveBeenCalledTimes(count - 1);
        expect(state.lock.extend).toHaveBeenCalledTimes(count - 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(renew).toHaveBeenCalledTimes(count);
        expect(state.lock.extend).toHaveBeenCalledTimes(count);
      }
      expect(state.lock.extend).toHaveBeenLastCalledWith(1_000);
      expect(signal.aborted).toBe(false);
      state.finish();
      expect(await running).toBe(1);
      expect(getEventListeners(signal, "abort")).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renew).toHaveBeenCalledTimes(2);
    } finally { state.finish(); await running; }
  });

  it("stops the heartbeat immediately on abort even if the handler still drains", async () => {
    vi.useFakeTimers();
    const state = await setup();
    const renew = vi.spyOn(state.adapter, "extendLease");
    const running = state.scheduler.runOnce();
    let stopping: Promise<void> | undefined;
    try {
      const signal = await startedSignal(state);
      stopping = state.scheduler.stop();
      expect(signal.aborted).toBe(true);
      expect(getEventListeners(signal, "abort")).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renew).not.toHaveBeenCalled();
    } finally { state.finish(); await Promise.allSettled([running, stopping]); }
  });

  it("does not keep the process alive solely for a lease renewal timer", async () => {
    const state = await setup();
    const intervals = vi.spyOn(globalThis, "setInterval");
    const running = state.scheduler.runOnce();
    try {
      await startedSignal(state);
      expect(intervals).toHaveBeenCalledOnce();
      expect(intervals.mock.results[0]!.value.hasRef()).toBe(false);
    } finally { state.finish(); await running; intervals.mockRestore(); }
  });

  it("retains polling failure on completion and removes the loop during stop", async () => {
    const failure = new Error("poll delay failed");
    const state = await setup({ handler: () => undefined, sleep: async () => { throw failure; } });
    await state.scheduler.start();
    await expect(state.scheduler.completion).rejects.toBe(failure);
    expect(state.handler).toHaveBeenCalledOnce();
    // A settled polling failure is retained on completion, while stop remains cleanup-safe.
    await state.scheduler.stop();
  });

  it("reports a failed admission cycle and can continue polling", async () => {
    const failure = new Error("state read failed");
    const slept = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const state = await setup({ handler: () => undefined, sleep: async (_delay, signal) => {
      slept.resolve();
      if (!signal.aborted) await proceed.promise;
    } });
    vi.spyOn(state.adapter, "listStates").mockRejectedValueOnce(failure);
    try {
      await state.scheduler.start();
      await slept.promise;
      expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(state.handler).not.toHaveBeenCalled();
    } finally { const stopping = state.scheduler.stop(); proceed.resolve(); await stopping; }
  });
});


it("uses the explicitly configured polling interval instead of the default", async () => {
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const sleep = vi.fn(async (_delay: number, signal: AbortSignal) => {
    entered.resolve();
    if (!signal.aborted) await proceed.promise;
  });
  const state = await setup({ handler: () => undefined, sleep, pollIntervalMs: 123 });
  try {
    await state.scheduler.start();
    await entered.promise;
    expect(sleep).toHaveBeenCalledExactlyOnceWith(123, expect.any(AbortSignal));
  } finally { const stopping = state.scheduler.stop(); proceed.resolve(); await stopping; }
});


describe("scheduled task execution policies and observation", () => {
  it("preserves loop cadence for a manual run and ignores manual deferrals", async () => {
    const state = await setup({ schedule: loop({ delay: { seconds: 1 }, start: "after-delay" }), handler: (_deps, context) => {
      expect(context.trigger).toBe("manual");
      context.deferNextRun({ hours: 1 });
    } });
    expect(await state.scheduler.runOnce()).toBe(0);
    await state.adapter.requestRun(state.task.id);
    const reserve = vi.spyOn(state.adapter, "reserve");
    const complete = vi.spyOn(state.adapter, "complete");
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(reserve.mock.calls[0]![0]).not.toHaveProperty("nextScheduledAt");
    expect(complete.mock.calls[0]![0]).not.toHaveProperty("nextScheduledAt");
    expect(complete.mock.calls[0]![0]).not.toHaveProperty("postponeUntil");
    expect((await state.adapter.listStates([state.task.id]))[0]!.nextScheduledAt).toEqual(new Date(epoch.getTime() + 1_000));
  });

  it("schedules a loop from completion and applies a scheduled deferral", async () => {
    const state = await setup({ schedule: loop({ delay: { seconds: 1 } }), handler: (_deps, context) => context.deferNextRun({ seconds: 2 }) });
    const reserve = vi.spyOn(state.adapter, "reserve");
    const complete = vi.spyOn(state.adapter, "complete");
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(reserve.mock.calls[0]![0]).not.toHaveProperty("nextScheduledAt");
    expect(complete.mock.calls[0]![0]).toMatchObject({ nextScheduledAt: new Date(epoch.getTime() + 1_000), postponeUntil: new Date(epoch.getTime() + 2_000) });
    expect((await state.adapter.listStates([state.task.id]))[0]!.nextScheduledAt).toEqual(new Date(epoch.getTime() + 2_000));
  });

  it("does not send a deferral when a scheduled handler supplies none", async () => {
    const state = await setup({ handler: () => undefined });
    const complete = vi.spyOn(state.adapter, "complete");
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(complete.mock.calls[0]![0]).not.toHaveProperty("postponeUntil");
    expect((await state.adapter.listStates([state.task.id]))[0]!.nextScheduledAt).toEqual(new Date(epoch.getTime() + 1_000));
  });

  it("reports a throwing loop schedule and releases its overlap lock", async () => {
    let now = epoch;
    const failure = new Error("loop schedule could not determine its next occurrence");
    const schedule = { ...loop({ delay: { seconds: 1 } }), next: () => { throw failure; } };
    const state = await setup({ distributed: true, handler: () => undefined, now: () => now, schedule });
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(state.handler).toHaveBeenCalledOnce();
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(state.lock.release).toHaveBeenCalledOnce();
    // The uncompleted reservation remains recoverable at its ordinary expiry.
    expect((await state.adapter.listStates([state.task.id]))[0]!.activeRuns).toBe(1);
    now = new Date(epoch.getTime() + 1_000);
    expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({ activeRuns: 0, nextScheduledAt: epoch });
  });

  it.each(["scheduled", "manual"] as const)("admits the earlier %s occurrence while both triggers are due", async (trigger) => {
    const manual = new Date(epoch.getTime() + 500);
    const scheduled = trigger === "scheduled" ? epoch : new Date(epoch.getTime() + 1_000);
    let now = manual;
    const state = await setup({ handler: () => undefined, now: () => now });
    await state.adapter.reconcile([{ taskId: state.task.id, nextScheduledAt: scheduled }]);
    await state.adapter.requestRun(state.task.id);
    now = new Date(epoch.getTime() + 1_000);
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(state.handler.mock.calls[0]![1]).toMatchObject({ trigger, scheduledAt: trigger === "scheduled" ? scheduled : manual });
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(state.handler.mock.calls[1]![1]).toMatchObject({ trigger: trigger === "scheduled" ? "manual" : "scheduled" });
  });

  it.each([false, true])("allows parallel occurrences without overlap locks: distributed=%s", async (distributed) => {
    const state = await setup({ distributed, overlap: "parallel", slots: 2 });
    const first = state.scheduler.runOnce();
    void first.catch(() => undefined);
    let second: Promise<number> | undefined;
    try {
      await startedSignal(state);
      await state.adapter.requestRun(state.task.id);
      second = state.scheduler.runOnce();
      void second.catch(() => undefined);
      await setImmediate();
      expect(state.handler).toHaveBeenCalledTimes(2);
      expect(state.locks.tryAcquire).not.toHaveBeenCalled();
      expect((await state.adapter.listStates([state.task.id]))[0]!.activeRuns).toBe(2);
    } finally { state.finish(); await Promise.all([first, second]); }
  });

  it("releases a late overlap lock without reserving after stop", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    const acquired = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    vi.mocked(state.locks.tryAcquire).mockImplementation(async () => { acquired.resolve(); await proceed.promise; return state.lock; });
    const reserve = vi.spyOn(state.adapter, "reserve");
    const running = state.scheduler.runOnce();
    try {
      await acquired.promise;
      const stopping = state.scheduler.stop();
      proceed.resolve();
      await stopping;
      expect(await running).toBe(0);
      expect(reserve).not.toHaveBeenCalled();
      expect(state.lock.release).toHaveBeenCalledOnce();
    } finally { proceed.resolve(); await running; }
  });

  it("does not try releasing an unowned lock when stop interrupts acquisition", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    const proceed = Promise.withResolvers<void>();
    vi.mocked(state.locks.tryAcquire).mockImplementation(async () => { await proceed.promise; return undefined; });
    const running = state.scheduler.runOnce();
    try {
      await setImmediate();
      expect(state.locks.tryAcquire).toHaveBeenCalledOnce();
      const stopping = state.scheduler.stop();
      proceed.resolve();
      await stopping;
      expect(await running).toBe(0);
      expect(state.handler).not.toHaveBeenCalled();
    } finally { proceed.resolve(); await Promise.allSettled([running]); }
  });

  it("sets scheduled-task metadata in the execution log context", async () => {
    const state = await setup();
    const running = state.scheduler.runOnce();
    try {
      await startedSignal(state);
      const [scope] = activeScopes.get(state.app)!;
      expect(scope?.context.toRecord("log")).toMatchObject({ operation: state.task.id, transport: "scheduled-task", workload: "scheduled-tasks" });
    } finally { state.finish(); await running; }
  });

  it.each([false, true])("records the public observation result and execution metadata: failure=%s", async (failed) => {
    const failure = new Error("observable handler failure");
    const state = await setup({ handler: () => { if (failed) throw failure; } });
    const record = vi.fn();
    state.app.container.registerValue("observer", { record });
    const executionLog = vi.fn();
    state.app.container.registerValue("setExecutionLogEnabled", executionLog);
    // A large fixed monotonic time distinguishes duration subtraction from addition.
    const clock = vi.spyOn(performance, "now").mockReturnValue(100_000);
    try {
      expect(await state.scheduler.runOnce()).toBe(1);
      expect(executionLog).toHaveBeenCalledExactlyOnceWith(true);
      expect(record.mock.calls.map(([definition]) => definition.name)).toEqual(["execution.started", "execution.completed"]);
      expect(record.mock.calls[0]![1]).toEqual({ operation: state.task.id, transport: "scheduled-task" });
      expect(record.mock.calls[1]![1]).toMatchObject({ operation: state.task.id, transport: "scheduled-task" });
      expect(record.mock.calls[1]![2]).toEqual({ outcome: failed ? "failure" : "success", durationMs: 0 });
      if (failed) expect(record.mock.calls[1]![1].error).toMatchObject({ name: "Error", message: failure.message });
      else expect(record.mock.calls[1]![1]).not.toHaveProperty("error");
    } finally { clock.mockRestore(); }
  });

  it("disposes a created execution when its observation callback fails", async () => {
    const state = await setup({ handler: () => undefined });
    const failure = new Error("observer rejected invocation");
    state.app.container.registerValue("observer", { record: () => { throw failure; } });
    const create = state.app.createExecutionScope.bind(state.app);
    const disposed = vi.fn();
    vi.mocked(state.app.createExecutionScope).mockImplementationOnce(async () => {
      const execution = await create();
      const dispose = execution.dispose.bind(execution);
      vi.spyOn(execution, "dispose").mockImplementation(async (outcome) => { disposed(outcome); await dispose(outcome); });
      return execution;
    });
    expect(await state.scheduler.runOnce()).toBe(1);
    expect(state.handler).not.toHaveBeenCalled();
    expect(disposed).toHaveBeenCalledExactlyOnceWith("failure");
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({ activeRuns: 0, lastOutcome: "failure" });
  });
});


it("accepts tasks without overrides when overrides are disabled and creates the default memory store", async () => {
  const state = await setup({ handler: () => undefined });
  const handler = vi.fn();
  const task = defineScheduledTask({ id: "default-memory", schedule: every({ seconds: 1, start: "immediate" }), handler });
  const scheduler = new ScheduledTaskScheduler(state.app, {}, undefined, [task], { slots: 1, leaseMs: 1_000, now: () => epoch, allowTaskRuntimeOverrides: false, defaultRuntime: { state: "memory", coordination: "local" } });
  owned.push({ app: state.app, scheduler });
  expect(await scheduler.runOnce()).toBe(1);
  expect(handler).toHaveBeenCalledOnce();
});

it("runs an explicit manual request while paused without consuming the regular occurrence", async () => {
  const state = await setup({ handler: (_deps, context) => expect(context.trigger).toBe("manual") });
  vi.spyOn(state.adapter, "reconcile").mockImplementation(async (registrations) => {
    // Paused state can be supplied by any conforming persistent backend.
    const original = MemoryScheduledTaskAdapter.prototype.reconcile.bind(state.adapter);
    await original(registrations);
    await state.adapter.setPaused(state.task.id, true);
    await state.adapter.requestRun(state.task.id);
  });
  expect(await state.scheduler.runOnce()).toBe(1);
  expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({ paused: true, nextScheduledAt: epoch, activeRuns: 0 });
});

it.each([undefined, null])("persists and reports an arbitrary thrown handler value: %s", async (failure) => {
  const state = await setup({ distributed: true, handler: () => { throw failure; } });
  // A cleanup failure must not replace the original cause, including nullish causes.
  vi.mocked(state.lock.release).mockRejectedValue(new Error("secondary lock cleanup failure"));
  const record = vi.fn();
  state.app.container.registerValue("observer", { record });
  const complete = vi.spyOn(state.adapter, "complete");
  expect(await state.scheduler.runOnce()).toBe(1);
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure", error: { name: "Error", message: String(failure) } }));
  expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
  const completed = record.mock.calls.find(([definition]) => definition.name === "execution.completed");
  expect(completed?.[2]).toMatchObject({ outcome: "failure" });
  expect(completed?.[1].error).toMatchObject({ name: "UnknownError", message: String(failure) });
  expect(state.lock.release).toHaveBeenCalledOnce();
});

it.each([undefined, null])("retains the first nullish renewal cause across a later sibling failure: %s", async (failure) => {
  vi.useFakeTimers();
  const state = await setup({ distributed: true });
  vi.spyOn(state.adapter, "extendLease").mockRejectedValue(failure);
  const sibling = Promise.withResolvers<void>();
  vi.mocked(state.lock.extend).mockReturnValue(sibling.promise);
  const complete = vi.spyOn(state.adapter, "complete");
  const record = vi.fn();
  state.app.container.registerValue("observer", { record });
  const running = state.scheduler.runOnce();
  void running.catch(() => undefined);
  try {
    const signal = await startedSignal(state);
    await vi.advanceTimersByTimeAsync(500);
    expect(signal.aborted).toBe(true);
    sibling.reject(new Error("secondary lock renewal failure"));
    await vi.advanceTimersByTimeAsync(0);
  } finally { sibling.resolve(); state.finish(); await running; }
  // AbortController normalizes undefined, but persisted and reported causes remain unmodified.
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure", error: { name: "Error", message: String(failure) } }));
  expect(state.reportError).toHaveBeenCalledExactlyOnceWith(failure);
  const completed = record.mock.calls.find(([definition]) => definition.name === "execution.completed");
  expect(completed?.[1].error).toMatchObject({ name: "UnknownError", message: String(failure) });
  expect(completed?.[2]).toMatchObject({ outcome: "failure" });
  expect(vi.getTimerCount()).toBe(0);
});


it("keeps active peers within the global slot budget and releases capacity after completion", async () => {
  const peers = Promise.withResolvers<void>();
  const peerHandler = vi.fn(async () => { await peers.promise; });
  const extraTasks = ["peer.first", "peer.second"].map((id) => defineScheduledTask({ id, schedule: every({ seconds: 1, start: "immediate" }), overlap: "parallel", runtime: { state: "memory", coordination: "local" }, handler: peerHandler }));
  const state = await setup({ slots: 2, extraTasks });
  const first = state.scheduler.runOnce();
  void first.catch(() => undefined);
  let second: Promise<number> | undefined;
  try {
    await startedSignal(state);
    expect(peerHandler).toHaveBeenCalledOnce();
    second = state.scheduler.runOnce();
    void second.catch(() => undefined);
    await setImmediate();
    expect(peerHandler).toHaveBeenCalledOnce();
    expect(state.handler).toHaveBeenCalledOnce();
  } finally { peers.resolve(); state.finish(); await first; await second; }
  expect(await state.scheduler.runOnce()).toBe(1);
  expect(peerHandler).toHaveBeenCalledTimes(2);
});

it("advances interval cadence at reservation and re-admits overdue work after a long handler", async () => {
  let now = new Date(epoch);
  const state = await setup({ now: () => now, handler: () => { now = new Date(epoch.getTime() + 1_500); } });
  const reserve = vi.spyOn(state.adapter, "reserve");
  const complete = vi.spyOn(state.adapter, "complete");
  expect(await state.scheduler.runOnce()).toBe(1);
  expect(reserve.mock.calls[0]![0].nextScheduledAt).toEqual(new Date(epoch.getTime() + 1_000));
  expect(complete.mock.calls[0]![0]).not.toHaveProperty("nextScheduledAt");
  expect((await state.adapter.listStates([state.task.id]))[0]!.nextScheduledAt).toEqual(new Date(epoch.getTime() + 1_000));
  expect(await state.scheduler.runOnce()).toBe(1);
  expect(reserve.mock.calls[1]![0].nextScheduledAt).toEqual(new Date(epoch.getTime() + 2_000));
});
