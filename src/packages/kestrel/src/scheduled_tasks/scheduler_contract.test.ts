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
  schedule?: ScheduledTaskSchedule;
  overlap?: ScheduledTaskOverlap;
  now?: () => Date;
} = {}) {
  const app = new App<Record<string, never>>({});
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
    slots: options.slots ?? 1, leaseMs: 1_000, now: options.now ?? (() => epoch), reportError,
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

  it("does not admit an invocation after stop while loading states", async () => {
    const state = await setup({ handler: () => undefined });
    const proceed = Promise.withResolvers<void>();
    const original = state.adapter.listStates.bind(state.adapter);
    const list = vi.spyOn(state.adapter, "listStates").mockImplementation(async (ids) => {
      await proceed.promise;
      return original(ids);
    });
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    try {
      await setImmediate();
      expect(list).toHaveBeenCalledOnce();
      const stopping = state.scheduler.stop();
      proceed.resolve();
      await stopping;
      expect(await running).toBe(0);
      expect(state.handler).not.toHaveBeenCalled();
    } finally { proceed.resolve(); await running; }
  });

  it("returns a reservation instead of starting work when stop races with reserve", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
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
      expect(release).toHaveBeenCalledOnce();
      expect(state.lock.release).toHaveBeenCalledOnce();
      expect((await state.adapter.listStates([state.task.id]))[0]).toMatchObject({ activeRuns: 0, nextScheduledAt: epoch });
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
    } finally { state.finish(); await running; }
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure", error: expect.objectContaining({ name: "Error" }) }));
    expect(state.reportError).toHaveBeenCalledExactlyOnceWith(signal.reason);
    const completed = record.mock.calls.find(([definition]) => definition.name === "execution.completed");
    expect(completed?.[2]).toMatchObject({ outcome: "failure" });
    expect(completed?.[1].error).toMatchObject({ name: "Error", message: signal.reason.message });
    expect(vi.getTimerCount()).toBe(0);
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
        })).toThrow(TypeError);
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
    const running = state.scheduler.runOnce();
    void running.catch(() => undefined);
    let second: Promise<number> | undefined;
    try {
      await startedSignal(state);
      second = state.scheduler.runOnce();
      const secondOutcome = observeSettlement(second);
      await setImmediate();
      expect(secondOutcome()).toEqual({ status: "fulfilled", value: 0 });
      const stopping = state.scheduler.stop();
      let drained = false;
      void stopping.then(() => { drained = true; });
      await setImmediate();
      expect(drained).toBe(false);
      state.finish();
      await stopping;
    } finally { state.finish(); await Promise.all([running, second]); }
    expect(await state.scheduler.runOnce()).toBe(0);
  });

  it("releases the overlap lock when adapter reservation rejects", async () => {
    const state = await setup({ distributed: true, handler: () => undefined });
    const failure = new Error("reservation unavailable");
    vi.spyOn(state.adapter, "reserve").mockRejectedValue(failure);
    await expect(state.scheduler.runOnce()).rejects.toBe(failure);
    expect(state.handler).not.toHaveBeenCalled();
    expect(state.lock.release).toHaveBeenCalledOnce();
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
        })).toThrow(TypeError);
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
