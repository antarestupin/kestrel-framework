import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { App, executionCompletedEvent, executionCompletedObservation, type ExecutionScope, type ShutdownOptions } from "../app/index.js";
import { dep } from "../di/index.js";
import {
  defineAdmissionPolicy,
  defineRateLimit,
  localResourcePressure,
  rateLimit,
  seconds,
  ThrottlingAcquisitionAbortedError,
  ThrottlingAcquisitionTimeoutError,
  ThrottlingBackendUnavailableError,
  ThrottlingClosedError,
  ThrottlingQueueFullError,
  ThrottlingRejectedError,
  type AdmissionAvailability,
  type Throttling,
} from "../throttling/index.js";
import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { WorkerRetryError } from "./errors.js";
import { WorkerScheduler, type WorkerSchedulerOptions } from "./scheduler.js";
import type { ReservedJob } from "./types.js";
import { defineWorker, jobFail, jobSuccess, type AnyWorker, type WorkerThrottlingRequirement } from "./worker.js";

const pressure = defineAdmissionPolicy({
  id: "scheduler-pressure",
  limits: [localResourcePressure({ id: "cpu-pressure", signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } } })],
});
const rate = defineRateLimit({ id: "worker-rate", requests: 1, per: seconds(1) });
const advancedRate = defineAdmissionPolicy({
  id: "worker-advanced-rate",
  limits: [rateLimit({ id: "worker-rate-constraint", unit: "requests", limit: 1, per: seconds(1) })],
});
const mixedAdmission = defineAdmissionPolicy({
  id: "worker-mixed-admission",
  limits: [...pressure.limits, ...advancedRate.limits],
});

/** Supply only the throttling operations selected by each scheduler contract. */
function throttlingFacade(operations: Partial<Pick<Throttling, "acquire" | "inspect">>): Throttling {
  async function unexpected(): Promise<never> { throw new Error("Unexpected throttling operation."); }
  return { acquire: unexpected, inspect: unexpected, run: unexpected, close: async () => undefined, ...operations };
}

/** Exercise real queue ownership while advancing storage time explicitly. */
async function fixture(
  workers: readonly AnyWorker[],
  options: Partial<WorkerSchedulerOptions> = {},
  shutdown: ShutdownOptions = {},
) {
  let now = new Date("2026-01-01T00:00:00.000Z");
  let nextJob = 0;
  let nextToken = 0;
  const adapter = new MemoryWorkerAdapter({
    now: () => now,
    createId: () => `job-${++nextJob}`,
    createReservationToken: () => `token-${++nextToken}`,
  });
  const app = new App({}, { shutdown });
  await app.start();
  const scheduler = new WorkerScheduler(app, adapter, workers, {
    slots: 1,
    leaseMs: 100,
    now: () => now,
    // A test that unexpectedly polls again should fail without waiting on a timer.
    sleep: async () => { throw new Error("Unexpected idle poll."); },
    ...options,
  });
  return { app, adapter, scheduler, advanceStorage: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

/** Assert progress after a controlled turn even if a mutation strands a waiter. */
async function expectCycle<Config>(scheduler: WorkerScheduler<Config>, expected: number, turn: () => Promise<void> = setImmediate): Promise<void> {
  const outcomes: PromiseSettledResult<number>[] = [];
  void scheduler.runOnce().then(
    (value) => outcomes.push({ status: "fulfilled", value }),
    (reason: unknown) => outcomes.push({ status: "rejected", reason }),
  );
  await turn();
  expect(outcomes).toEqual([{ status: "fulfilled", value: expected }]);
}

/** A fixture can still close execution scopes after a disposal mutation. */
function trackScopes<Config>(app: App<Config>): () => Promise<void> {
  const opened: ExecutionScope<Config>[] = [];
  const create = app.createExecutionScope.bind(app);
  vi.spyOn(app, "createExecutionScope").mockImplementation(async (id) => {
    const scope = await create(id);
    opened.push(scope);
    return scope;
  });
  return async () => { await Promise.allSettled(opened.map((scope) => scope.dispose("cancelled"))); };
}

describe("worker scheduler ownership", () => {
  it.each([
    "slots", "leaseMs", "reservationLimit", "pollIntervalMs", "readyQueueRefreshMs",
    "ackBufferSize", "ackFlushIntervalMs", "deferBufferSize", "deferFlushIntervalMs",
  ] as const)("rejects invalid %s on direct scheduler construction", async (name) => {
    const { app, adapter } = await fixture([]);
    try {
      for (const value of [0, -1, 1.5, NaN, Infinity]) {
        expect(() => new WorkerScheduler(app, adapter, [], { slots: 1, leaseMs: 100, [name]: value })).toThrow(
          new TypeError(`${name} must be a positive integer.`),
        );
      }
    } finally {
      await app.dispose();
    }
  });

  it("validates reservation pressure and worker identities before polling", async () => {
    const { app, adapter } = await fixture([]);
    const worker = defineWorker({ name: "unique", queue: "unique", input: z.null(), handler: vi.fn() });
    const options = { slots: 1, leaseMs: 100 };
    try {
      expect(() => new WorkerScheduler(app, adapter, [], { ...options, reservationPressure: pressure }))
        .toThrow("Worker reservation pressure requires a throttling facade.");
      for (const invalidPressure of [advancedRate, mixedAdmission]) {
        expect(() => new WorkerScheduler(app, adapter, [], { ...options, reservationPressure: invalidPressure, throttling: throttlingFacade({}) }))
          .toThrow("Worker reservation pressure may only contain local resource pressure constraints.");
      }
      expect(() => new WorkerScheduler(app, adapter, [worker, { ...worker, queue: "distinct" }], options))
        .toThrow('Worker names must be unique: "unique".');
      expect(() => new WorkerScheduler(app, adapter, [worker, { ...worker, name: "distinct" }], options))
        .toThrow('Only one worker can consume queue "unique".');
    } finally {
      await app.dispose();
    }
  });

  it.each([
    new ThrottlingRejectedError(pressure.id),
    new ThrottlingAcquisitionTimeoutError(pressure.id),
    new ThrottlingQueueFullError(pressure.id),
    new ThrottlingBackendUnavailableError({ cause: new Error("storage unavailable") }),
    new ThrottlingClosedError(),
  ])("returns work after %s without spending a handler attempt", async (unavailable) => {
    const handler = vi.fn();
    const worker = defineWorker({
      name: "unavailable-admission", queue: "unavailable-admission", input: z.null(), maxAttempts: 1, handler,
      throttling: { requirements: () => ({ admission: pressure }), buffering: { fallbackDelayMs: 25 } },
    });
    const acquire = vi.fn<Throttling["acquire"]>().mockRejectedValueOnce(unavailable);
    const complete = vi.fn(async () => undefined);
    acquire.mockResolvedValue({ definitionId: pressure.id, complete });
    const recordThrottlingDecision = vi.fn(() => { throw new Error("diagnostic sink unavailable"); });
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker], {
      throttling: throttlingFacade({ acquire }), recordThrottlingDecision,
    });
    const disposeScopes = trackScopes(app);
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const retryAt = new Date("2026-01-01T00:00:00.025Z");
    try {
      await expectCycle(scheduler, 1);
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toMatchObject([{ id: "job-1", attempt: 0, availableAt: retryAt }]);
      expect(adapter.inspectJobs()[0]?.reservationToken).toBeUndefined();
      expect(recordThrottlingDecision).toHaveBeenCalledExactlyOnceWith({ worker: worker.name, jobIds: ["job-1"], result: "deferred", retryAt });

      advanceStorage(25);
      await expectCycle(scheduler, 1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }), expect.anything(), expect.anything());
      expect(complete).toHaveBeenCalledExactlyOnceWith({ outcome: "success" });
      expect(recordThrottlingDecision).toHaveBeenLastCalledWith({ worker: worker.name, jobIds: ["job-1"], result: "admitted" });
      expect(adapter.inspectJobs()).toEqual([]);
      expect(adapter.inspectDeadLetters()).toEqual([]);
    } finally {
      await Promise.allSettled([scheduler.stop("expire"), disposeScopes()]);
      await app.dispose();
    }
  });

  it.each([
    { initial: 55, held: 90, expected: 90 },
    { initial: 55, held: undefined, expected: 55 },
    { initial: undefined, held: undefined, expected: 25 },
  ])("uses the final admission deadline, initial deadline or fallback in that order ($expected ms)", async ({ initial, held, expected }) => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const retryAt = new Date(now.getTime() + expected);
    const initialRetryAt = initial === undefined ? undefined : new Date(now.getTime() + initial);
    const heldError = held === undefined
      ? new ThrottlingAcquisitionTimeoutError(pressure.id)
      : new ThrottlingRejectedError(pressure.id, new Date(now.getTime() + held));
    const acquire = vi.fn<Throttling["acquire"]>()
      .mockRejectedValueOnce(new ThrottlingRejectedError(pressure.id, initialRetryAt))
      .mockRejectedValueOnce(heldError);
    const handler = vi.fn();
    const worker = defineWorker({
      name: "held-admission", queue: "held-admission", input: z.null(), handler,
      throttling: {
        requirements: () => ({ admission: pressure }),
        buffering: { strategy: "hold", maxHoldMs: 12, fallbackDelayMs: 25 },
      },
    });
    const recordThrottlingDecision = vi.fn();
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ acquire }), recordThrottlingDecision });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    try {
      expect(await scheduler.runOnce()).toBe(1);
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(acquire).toHaveBeenLastCalledWith(pressure, expect.objectContaining({ estimatedCost: {}, maxWaitMs: 12 }));
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toMatchObject([{ attempt: 0, availableAt: retryAt }]);
      expect(recordThrottlingDecision).toHaveBeenNthCalledWith(1, {
        worker: worker.name, jobIds: ["job-1"], result: "held", ...(initialRetryAt === undefined ? {} : { retryAt: initialRetryAt }),
      });
      expect(recordThrottlingDecision).toHaveBeenNthCalledWith(2, { worker: worker.name, jobIds: ["job-1"], result: "deferred", retryAt });
    } finally {
      await app.dispose();
    }
  });

  it.each([false, true])("records unexpected admission failures as job failures (after hold=%s)", async (held) => {
    const unexpected = new ThrottlingAcquisitionAbortedError(pressure.id);
    const acquire = vi.fn<Throttling["acquire"]>().mockRejectedValue(unexpected);
    if (held) acquire.mockRejectedValueOnce(new ThrottlingRejectedError(pressure.id));
    const handler = vi.fn();
    const worker = defineWorker({
      name: "unexpected-admission", queue: "unexpected-admission", input: z.null(), maxAttempts: 1, handler,
      throttling: { requirements: () => ({ admission: pressure }), buffering: { strategy: "hold", maxHoldMs: 12 } },
    });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    const disposeScopes = trackScopes(app);
    const completed = vi.fn();
    app.eventBus.listen(executionCompletedEvent, (event) => completed(event.outcome), { scope: "descendants" });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    try {
      expect(await scheduler.runOnce()).toBe(1);
      expect(acquire).toHaveBeenCalledTimes(held ? 2 : 1);
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toEqual([]);
      expect(adapter.inspectDeadLetters()).toMatchObject([{ error: { name: unexpected.name, message: unexpected.message } }]);
      expect(completed).toHaveBeenCalledExactlyOnceWith("failure");
    } finally {
      await disposeScopes();
      await app.dispose();
    }
  });

  it.each([
    { name: "null requirement", requirements: [null, { admission: rate }], message: "returned an invalid throttling requirement." },
    { name: "primitive requirement", requirements: [true, { admission: rate }], message: "returned an invalid throttling requirement." },
    { name: "missing policy kind", requirements: [{ admission: {} }, { admission: rate }], message: "returned an invalid throttling requirement." },
    { name: "primitive policy", requirements: [{ admission: "invalid" }, { admission: rate }], message: "returned an invalid throttling requirement." },
    { name: "unsupported policy kind", requirements: [
      { admission: { kind: "custom" }, estimatedCost: {} },
      { admission: { kind: "custom" }, estimatedCost: {} },
    ], message: "returned an invalid throttling requirement." },
    { name: "invalid second requirement", requirements: [{ admission: rate }, { admission: null }], message: "returned an invalid throttling requirement." },
    { name: "missing advanced cost", requirements: [{ admission: advancedRate }, { admission: advancedRate }], message: "must declare estimatedCost for an advanced admission policy." },
    { name: "missing mixed policy cost", requirements: [{ admission: mixedAdmission }, { admission: mixedAdmission }], message: "must declare estimatedCost for an advanced admission policy." },
    { name: "different cost widths", requirements: [{ admission: rate, estimatedCost: {} }, { admission: rate }], message: "must use the same cost dimensions." },
    { name: "missing cost dimension", requirements: [
      { admission: rate, estimatedCost: { requests: 1, bytes: 1 } },
      { admission: rate, estimatedCost: { requests: 1 } },
    ], message: "must use the same cost dimensions." },
    { name: "different cost dimensions", requirements: [{ admission: rate, estimatedCost: { requests: 1 } }, { admission: rate, estimatedCost: { bytes: 1 } }], message: "must use the same cost dimensions." },
    { name: "negative cost", requirements: [{ admission: rate }, { admission: rate, estimatedCost: { requests: -1 } }], message: 'Worker throttling cost "requests" must be non-negative and finite.' },
    { name: "nonfinite cost", requirements: [{ admission: rate }, { admission: rate, estimatedCost: { requests: Infinity } }], message: 'Worker throttling cost "requests" must be non-negative and finite.' },
    { name: "overflowing combined cost", requirements: [
      { admission: rate, estimatedCost: { requests: Number.MAX_VALUE } },
      { admission: rate, estimatedCost: { requests: Number.MAX_VALUE } },
    ], message: 'Combined worker throttling cost "requests" must be finite.' },
  ])("rejects $name before spending admission or running the batch", async ({ requirements, message }) => {
    const acquire = vi.fn<Throttling["acquire"]>();
    const handler = vi.fn();
    const worker = defineWorker({
      name: "invalid-requirements", queue: "invalid-requirements", input: z.number(), maxAttempts: 1, batch: { size: 2 }, handler,
      // User callbacks can return malformed input from JavaScript or runtime data.
      throttling: { requirements: ({ payload }) => requirements[payload] as WorkerThrottlingRequirement },
    });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    await adapter.enqueue([0, 1].map((payload) => ({ queue: worker.queue, payload })));
    try {
      expect(await scheduler.runOnce()).toBe(2);
      expect(acquire).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.inspectDeadLetters()).toMatchObject([
        { originalJobId: "job-1", error: { name: "TypeError", message: expect.stringContaining(message) } },
        { originalJobId: "job-2", error: { name: "TypeError", message: expect.stringContaining(message) } },
      ]);
    } finally {
      await app.dispose();
    }
  });

  it.each(["cost", "feedback"] as const)("rejects an unconfigured %s report as a job failure", async (report) => {
    const worker = defineWorker({ name: "unconfigured-reporter", queue: "unconfigured-reporter", input: z.null(), maxAttempts: 1,
      handler: (_job, _dependencies, context) => {
        if (report === "cost") context.reportActualCost({ requests: 1 });
        else context.reportFeedback({ kind: "timeout" });
      },
    });
    const { app, adapter, scheduler } = await fixture([worker]);
    try {
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      await expectCycle(scheduler, 1);
      expect(adapter.inspectDeadLetters()).toMatchObject([{
        error: {
          name: "TypeError",
          message: `Worker "unconfigured-reporter" cannot report throttling ${report} without declaring throttling requirements.`,
        },
      }]);
    } finally {
      await app.dispose();
    }
  });

  it.each(["cost", "feedback"] as const)("rejects duplicate %s reports and reconciles the first report", async (duplicate) => {
    const complete = vi.fn(async () => undefined);
    const acquire = vi.fn<Throttling["acquire"]>().mockResolvedValue({ definitionId: rate.id, complete });
    const worker = defineWorker({ name: "duplicate-reporter", queue: "duplicate-reporter", input: z.null(), maxAttempts: 1,
      throttling: { requirements: () => ({ admission: rate }) },
      handler: (_job, _dependencies, context) => {
        context.reportActualCost({ requests: 2 });
        context.reportFeedback({ kind: "timeout" });
        if (duplicate === "cost") context.reportActualCost({ requests: 10 });
        else context.reportFeedback({ kind: "timeout" });
      },
    });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    try {
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      await expectCycle(scheduler, 1);
      expect(acquire).toHaveBeenCalledExactlyOnceWith(rate, expect.objectContaining({ estimatedCost: { requests: 1 } }));
      expect(complete).toHaveBeenCalledExactlyOnceWith({ outcome: "failure", actualCost: { requests: 2 }, feedback: { kind: "timeout" } });
      expect(adapter.inspectDeadLetters()).toMatchObject([{
        error: {
          name: "TypeError",
          message: `Worker ${duplicate === "cost" ? "actual throttling cost" : "throttling feedback"} can only be reported once per invocation.`,
        },
      }]);
    } finally {
      await app.dispose();
    }
  });

  it("combines reordered cost dimensions with zero contributions and snapshots reported usage", async () => {
    const complete = vi.fn(async () => undefined);
    const acquire = vi.fn<Throttling["acquire"]>().mockResolvedValue({ definitionId: rate.id, complete });
    const retryAt = new Date("2026-01-01T00:00:00Z");
    const worker = defineWorker({
      name: "reported-usage", queue: "reported-usage", input: z.number(), batch: { size: 2 }, maxAttempts: 1,
      throttling: { requirements: ({ payload }) => ({
        admission: rate,
        estimatedCost: payload === 0 ? { requests: 0, bytes: 2 } : { bytes: 3, requests: 4 },
      }) },
      *handler([first, second], _dependencies, { reportActualCost, reportFeedback }) {
        const cost = { requests: 4, bytes: 5 };
        const feedback = { kind: "throttled" as const, retryAt };
        reportActualCost(cost);
        reportFeedback(feedback);
        cost.requests = 99;
        retryAt.setUTCFullYear(2030);
        yield jobSuccess(first!.id);
        yield jobFail(second!.id, { cause: "remote limit" });
      },
    });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    await adapter.enqueue([
      { queue: worker.queue, payload: 0, correlation: { namespace: "test", id: "successful-peer" } },
      { queue: worker.queue, payload: 1 },
    ]);
    try {
      await expect(scheduler.runOnce()).resolves.toBe(2);
      expect(acquire).toHaveBeenCalledExactlyOnceWith(rate, expect.objectContaining({ estimatedCost: { requests: 4, bytes: 5 } }));
      expect(complete.mock.calls).toStrictEqual([[{
        outcome: "failure",
        actualCost: { requests: 4, bytes: 5 },
        feedback: { kind: "throttled", retryAt: new Date("2026-01-01T00:00:00Z") },
      }]]);
      expect(adapter.inspectDeadLetters()).toMatchObject([{ originalJobId: "job-2", error: { message: "remote limit" } }]);
    } finally { await app.dispose(); }
  });

  it("uses the scheduler's wall clock for retry when no test clock is supplied", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-01-02T00:00:00Z");
    vi.setSystemTime(now);
    const worker = defineWorker({
      name: "wall-clock-retry", queue: "wall-clock-retry", input: z.null(),
      handler: () => { throw new WorkerRetryError("retry later", 25); },
    });
    const { app, adapter } = await fixture([worker]);
    const scheduler = new WorkerScheduler(app, adapter, [worker], { slots: 1, leaseMs: 100 });
    try {
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      await expect(scheduler.runOnce()).resolves.toBe(1);
      expect(adapter.inspectJobs()[0]?.availableAt).toEqual(new Date(now.getTime() + 25));
    } finally {
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it("holds a full batch within the default blocked budget and reports its eventual admission", async () => {
    const complete = vi.fn(async () => undefined);
    const acquire = vi.fn<Throttling["acquire"]>()
      .mockRejectedValueOnce(new ThrottlingRejectedError(rate.id))
      .mockResolvedValueOnce({ definitionId: rate.id, complete });
    const handler = vi.fn();
    const recordThrottlingDecision = vi.fn();
    const worker = defineWorker({
      name: "full-held-batch", queue: "full-held-batch", input: z.null(), batch: { size: 2 }, handler,
      throttling: { requirements: () => ({ admission: rate }), buffering: { strategy: "hold", maxHoldMs: 40 } },
    });
    const { app, adapter, scheduler } = await fixture([worker], {
      throttling: throttlingFacade({ acquire }), recordThrottlingDecision,
    });
    try {
      await adapter.enqueue([null, null].map((payload) => ({ queue: worker.queue, payload })));
      await expect(scheduler.runOnce()).resolves.toBe(2);
      expect(acquire).toHaveBeenNthCalledWith(2, rate, expect.objectContaining({ maxWaitMs: 40, estimatedCost: { requests: 2 } }));
      expect(handler).toHaveBeenCalledOnce();
      const metadata = { worker: worker.name, jobIds: ["job-1", "job-2"] };
      expect(recordThrottlingDecision.mock.calls).toStrictEqual([
        [{ ...metadata, result: "held" }], [{ ...metadata, result: "admitted" }],
      ]);
      expect(complete.mock.calls).toStrictEqual([[{ outcome: "success" }]]);
      expect(adapter.inspectJobs()).toEqual([]);
    } finally { await app.dispose(); }
  });

  it.each([false, true])("stops admission when shutdown closes a pending facade request (held=%s)", async (held) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<Throttling["acquire"]>>>();
    void pending.promise.catch(() => undefined);
    const acquire = vi.fn<Throttling["acquire"]>().mockReturnValue(pending.promise);
    if (held) acquire.mockRejectedValueOnce(new ThrottlingRejectedError(rate.id));
    const handler = vi.fn();
    const recordThrottlingDecision = vi.fn();
    const worker = defineWorker({
      name: "closing-admission", queue: "closing-admission", input: z.null(), handler,
      throttling: { requirements: () => ({ admission: rate }), buffering: { strategy: "hold" } },
    });
    const { app, adapter, scheduler } = await fixture([worker], {
      throttling: throttlingFacade({ acquire }), recordThrottlingDecision,
    });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    let stop: Promise<void> | undefined;
    try {
      await setImmediate();
      expect(acquire).toHaveBeenCalledTimes(held ? 2 : 1);
      let stopped = false;
      stop = scheduler.stop("expire").then(() => { stopped = true; });
      void stop.catch(() => undefined);
      // A non-waiting stop must finish before the still-pending facade does.
      await setImmediate();
      expect(stopped).toBe(true);
      pending.reject(new ThrottlingClosedError());
      await expect(cycle).resolves.toEqual([{ status: "fulfilled", value: 1 }]);
      expect(acquire).toHaveBeenCalledTimes(held ? 2 : 1);
      expect(handler).not.toHaveBeenCalled();
      expect(recordThrottlingDecision.mock.calls).toStrictEqual(held ? [[{
        worker: worker.name, jobIds: ["job-1"], result: "held",
      }]] : []);
    } finally {
      pending.reject(new ThrottlingClosedError());
      await Promise.allSettled([cycle, stop]);
      await app.dispose();
    }
  });

  it("records elapsed handler time without attaching an error to a successful invocation", async () => {
    const record = vi.fn();
    const elapsed = vi.spyOn(performance, "now").mockReturnValue(50);
    const worker = defineWorker({
      name: "timed-observation", queue: "timed-observation", input: z.null(),
      handler: () => { elapsed.mockReturnValue(75); },
    });
    const { app, adapter, scheduler } = await fixture([worker]);
    app.container.registerFactory("observer", () => ({ record }), { lifetime: "scoped" });
    try {
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      await expect(scheduler.runOnce()).resolves.toBe(1);
      expect(record).toHaveBeenLastCalledWith(executionCompletedObservation, expect.objectContaining({
        operation: worker.name, transport: "worker",
      }), { outcome: "success", durationMs: 25 });
      expect(Object.hasOwn(record.mock.lastCall?.[1], "error")).toBe(false);
    } finally {
      elapsed.mockRestore();
      await app.dispose();
    }
  });

  it("closes a permit when opening the admitted job's execution scope fails", async () => {
    const complete = vi.fn(async () => undefined);
    const acquire = vi.fn<Throttling["acquire"]>().mockResolvedValue({ definitionId: rate.id, complete });
    const handler = vi.fn();
    const worker = defineWorker({ name: "unopened-scope", queue: "unopened-scope", input: z.null(), handler,
      throttling: { requirements: () => ({ admission: rate }) },
    });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    const failure = new Error("execution scope unavailable");
    vi.spyOn(app, "createExecutionScope").mockRejectedValueOnce(failure);
    try {
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      await expect(scheduler.runOnce()).rejects.toBe(failure);
      expect(handler).not.toHaveBeenCalled();
      expect(complete.mock.calls).toStrictEqual([[{ outcome: "failure" }]]);
      expect(adapter.inspectJobs()).toMatchObject([{ attempt: 1, reservationToken: "token-1" }]);
    } finally {
      await app.dispose();
    }
  });

  it("preserves permit feedback and cost when the execution cannot finish cleanup", async () => {
    const complete = vi.fn(async () => undefined);
    const acquire = vi.fn<Throttling["acquire"]>().mockResolvedValue({ definitionId: rate.id, complete });
    const failure = new Error("scope cleanup failed");
    const worker = defineWorker({
      name: "failed-cleanup", queue: "failed-cleanup", input: z.null(),
      throttling: { requirements: () => ({ admission: rate }) },
      handler: (_job, _dependencies, context) => {
        context.reportActualCost({ requests: 2 });
        context.reportFeedback({ kind: "timeout" });
      },
    });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    app.eventBus.listen(executionCompletedEvent, () => { throw failure; }, { scope: "descendants" });

    try {
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      await expect(scheduler.runOnce()).rejects.toBe(failure);
      // The storage transition never committed, but the permit must settle with its observed use.
      expect(complete).toHaveBeenCalledExactlyOnceWith({
        outcome: "failure", actualCost: { requests: 2 }, feedback: { kind: "timeout" },
      });
      expect(adapter.inspectJobs()).toMatchObject([{ attempt: 1, reservationToken: "token-1" }]);
    } finally {
      await app.dispose();
    }
  });

  it("fails a job whose definition declares admission without a configured facade", async () => {
    const handler = vi.fn();
    const worker = defineWorker({ name: "unconfigured-admission", queue: "unconfigured-admission", input: z.null(), maxAttempts: 1, handler,
      throttling: { requirements: () => ({ admission: rate }) },
    });
    const { app, adapter, scheduler } = await fixture([worker]);
    try {
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      await expectCycle(scheduler, 1);
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.inspectDeadLetters()).toMatchObject([{ error: { name: "Error", message: expect.stringContaining("throttling facade") } }]);
    } finally {
      await app.dispose();
    }
  });

  it("records invalid stored input as a failure without attempting admission", async () => {
    const handler = vi.fn();
    const acquire = vi.fn<Throttling["acquire"]>();
    const worker = defineWorker({ name: "invalid-stored-input", queue: "invalid-stored-input", input: z.string(), maxAttempts: 1, handler,
      throttling: { requirements: () => ({ admission: rate }) },
    });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    try {
      await adapter.enqueue([{ queue: worker.queue, payload: 42 }]);
      await expectCycle(scheduler, 1);
      expect(acquire).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.inspectDeadLetters()).toMatchObject([{ originalJobId: "job-1", attempt: 1, error: { name: "ZodError" } }]);
    } finally {
      await app.dispose();
    }
  });

  it.each(["available", "degraded", "limited", "unknown"] as const)("applies the %s process pressure state before touching queue storage", async (state) => {
    const inspect = vi.fn(async (): Promise<AdmissionAvailability> => ({ state, reasons: [] }));
    const worker = defineWorker({ name: "pressure", queue: "pressure", input: z.null(), handler: vi.fn() });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ inspect }), reservationPressure: pressure });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const list = vi.spyOn(adapter, "listReadyQueues");
    const reserve = vi.spyOn(adapter, "reserve");
    const admitted = state === "available" || state === "degraded";
    try {
      await expect(scheduler.runOnce()).resolves.toBe(admitted ? 1 : 0);
      expect(inspect).toHaveBeenCalledExactlyOnceWith(pressure);
      expect(list).toHaveBeenCalledTimes(admitted ? 1 : 0);
      expect(reserve).toHaveBeenCalledTimes(admitted ? 1 : 0);
      expect(adapter.inspectJobs()).toHaveLength(admitted ? 0 : 1);
    } finally { await app.dispose(); }
  });

  it("publishes a cycle before a pressure callback can synchronously reenter", async () => {
    const worker = defineWorker({ name: "reentrant", queue: "reentrant", input: z.null(), handler: vi.fn() });
    let reenter: (() => Promise<number>) | undefined;
    let nested: Promise<number> | undefined;
    let inspected = false;
    const inspect = vi.fn(async (): Promise<AdmissionAvailability> => {
      if (!inspected) {
        inspected = true;
        nested = reenter!();
      }
      return { state: "available", reasons: [] };
    });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ inspect }), reservationPressure: pressure });
    reenter = () => scheduler.runOnce();
    const reserve = vi.spyOn(adapter, "reserve");
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    try {
      const cycle = scheduler.runOnce();
      await expect(cycle).resolves.toBe(1);
      expect(nested).toBe(cycle);
      expect(inspect).toHaveBeenCalledOnce();
      expect(reserve).toHaveBeenCalledOnce();
    } finally { await Promise.allSettled([nested]); await app.dispose(); }
  });

  it("refreshes cached readiness at the monotonic deadline", async () => {
    const worker = defineWorker({ name: "readiness-cache", queue: "readiness-cache", input: z.null(), handler: vi.fn() });
    let tick = 10;
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker], { monotonicNow: () => tick, readyQueueRefreshMs: 20 });
    const list = vi.spyOn(adapter, "listReadyQueues");
    const reserve = vi.spyOn(adapter, "reserve");
    try {
      await expect(scheduler.runOnce()).resolves.toBe(0);
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      // Storage time and the monotonic refresh clock can advance independently.
      advanceStorage(1_000);
      tick = 29;
      await expect(scheduler.runOnce()).resolves.toBe(0);
      expect(list).toHaveBeenCalledOnce();
      expect(reserve).not.toHaveBeenCalled();
      tick = 30;
      await expect(scheduler.runOnce()).resolves.toBe(1);
      expect(list).toHaveBeenCalledTimes(2);
      expect(reserve).toHaveBeenCalledOnce();
    } finally { await app.dispose(); }
  });

  it("computes separate job and invocation limits for weighted queues and batches", async () => {
    const workers = [
      defineWorker({ name: "individual", queue: "individual", input: z.null(), weight: 2, handler: vi.fn() }),
      defineWorker({ name: "batch", queue: "batch", input: z.null(), weight: 3, batch: { size: 4, allowOverflow: false }, handler: vi.fn() }),
    ];
    const { app, adapter, scheduler } = await fixture(workers, { slots: 2, leaseMs: 111 });
    await adapter.enqueue(workers.map(({ queue }) => ({ queue, payload: null })));
    const reserve = vi.spyOn(adapter, "reserve");
    try {
      await expect(scheduler.runOnce()).resolves.toBe(2);
      expect(reserve).toHaveBeenCalledExactlyOnceWith({
        queues: [
          { queue: "individual", reservationLimit: 4, allowOverflow: true },
          { queue: "batch", reservationLimit: 24, allowOverflow: false },
        ],
        totalLimit: 8,
        leaseMs: 111,
      });
    } finally { await app.dispose(); }
  });

  it("splits an overflow reservation into full batches and one final partial batch", async () => {
    const received: number[][] = [];
    const worker = defineWorker({ name: "overflow-partition", queue: "overflow-partition", input: z.number(),
      batch: { size: 2, allowOverflow: true },
      handler: (jobs) => { received.push(jobs.map(({ payload }) => payload)); },
    });
    const { app, adapter, scheduler } = await fixture([worker], { reservationLimit: 5 });
    try {
      await adapter.enqueue([0, 1, 2, 3, 4].map((payload) => ({ queue: worker.queue, payload })));
      await expectCycle(scheduler, 5);
      expect(received).toEqual([[0, 1], [2, 3], [4]]);
      expect(adapter.inspectJobs()).toEqual([]);
    } finally {
      await scheduler.stop("expire");
      await app.dispose();
    }
  });

  it("hands a freed handler slot to a waiting job while another handler remains active", async () => {
    vi.useFakeTimers();
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    const entered: number[] = [];
    const worker = defineWorker({
      name: "slots", queue: "slots", input: z.number(),
      handler: async ({ payload }) => {
        entered.push(payload);
        await gates[payload]!.promise;
      },
    });
    const { app, adapter, scheduler } = await fixture([worker], { slots: 2, reservationLimit: 3 });
    await adapter.enqueue([0, 1, 2].map((payload) => ({ queue: worker.queue, payload })));
    let handled: number | undefined;
    void scheduler.runOnce().then((count) => { handled = count; }, () => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(entered).toEqual([0, 1]);
      gates[1]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(entered).toEqual([0, 1, 2]);
      gates[0]!.resolve();
      gates[2]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(handled).toBe(3);
      expect(adapter.inspectJobs()).toEqual([]);
    } finally {
      for (const gate of gates) gate.resolve();
      // Cleanup owns the cancellation signal even if a mutation loses a slot waiter.
      await scheduler.stop("expire");
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["handoff", "stopped propagation"] as const)("cancels a waiting job during handler-slot %s", async (timing) => {
    vi.useFakeTimers();
    const finish = Promise.withResolvers<void>();
    const complete = vi.fn(async () => undefined);
    const acquire = vi.fn<Throttling["acquire"]>().mockImplementation(async (_definition, options) => {
      if (timing === "stopped propagation") {
        options?.signal?.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
      }
      return { definitionId: pressure.id, complete };
    });
    const first = defineWorker({
      name: "releasing-slot", queue: "releasing-slot", input: z.null(), handler: vi.fn(() => finish.promise),
    });
    const second = defineWorker({
      name: "handoff-slot", queue: "handoff-slot", input: z.null(), handler: vi.fn(),
      throttling: { requirements: () => ({ admission: pressure }) },
    });
    const { app, adapter, scheduler } = await fixture([first, second], { reservationLimit: 2, throttling: throttlingFacade({ acquire }) });
    const createScope = vi.spyOn(app, "createExecutionScope");
    await adapter.enqueue([first, second].map(({ queue }) => ({ queue, payload: null })));
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    let outcomes: Awaited<typeof cycle> | undefined;
    void cycle.then((result) => { outcomes = result; });
    let stop: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(first.handler).toHaveBeenCalledOnce();
      expect(second.handler).not.toHaveBeenCalled();
      const signal = acquire.mock.calls[0]![1]!.signal!;
      if (timing === "handoff") {
        const remove = signal.removeEventListener.bind(signal);
        vi.spyOn(signal, "removeEventListener").mockImplementation((...args) => {
          remove(...args);
          // The waiter is dequeued here, and its continuation has not run yet.
          stop = scheduler.stop("expire");
        });
      } else {
        await scheduler.stop("expire");
      }
      finish.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(signal.aborted).toBe(true);
      expect(outcomes).toEqual([{ status: "fulfilled", value: 2 }]);
      expect(createScope).toHaveBeenCalledOnce();
      expect(second.handler).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledExactlyOnceWith({ outcome: "failure" });
    } finally {
      finish.resolve();
      await Promise.allSettled([stop, scheduler.stop("expire")]);
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it("defers jobs beyond the hold budget and restores that budget after admission settles", async () => {
    vi.useFakeTimers();
    const firstHold = Promise.withResolvers<Awaited<ReturnType<Throttling["acquire"]>>>();
    const permit = { definitionId: pressure.id, complete: vi.fn(async () => undefined) };
    const held: number[] = [];
    const acquire: Throttling["acquire"] = async (_definition, options) => {
      if (options?.maxWaitMs === undefined) throw new ThrottlingRejectedError(pressure.id);
      held.push(options.maxWaitMs);
      return held.length === 1 ? firstHold.promise : permit;
    };
    const handled: string[] = [];
    const worker = defineWorker({
      name: "hold", queue: "hold", input: z.string(),
      throttling: { requirements: () => ({ admission: pressure }), buffering: { strategy: "hold", maxHoldMs: 17, maxBlockedJobs: 1, fallbackDelayMs: 250 } },
      handler: ({ payload }) => { handled.push(payload); },
    });
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker], { slots: 2, deferBufferSize: 1, throttling: throttlingFacade({ acquire }) });
    const disposeScopes = trackScopes(app);
    await adapter.enqueue(["held", "deferred"].map((payload) => ({ queue: worker.queue, payload })));
    const cycle = scheduler.runOnce();
    void cycle.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(held).toEqual([17]);
      expect(handled).toEqual([]);
      const deferred = adapter.inspectJobs().find(({ payload }) => payload === "deferred");
      expect(deferred?.attempt).toBe(0);
      expect(deferred?.availableAt).toEqual(new Date("2026-01-01T00:00:00.250Z"));
      firstHold.resolve(permit);
      await expect(cycle).resolves.toBe(2);
      expect(handled).toEqual(["held"]);
      advanceStorage(250);
      await expectCycle(scheduler, 1, () => vi.advanceTimersByTimeAsync(0).then(() => undefined));
      expect(held).toEqual([17, 17]);
      expect(handled).toEqual(["held", "deferred"]);
      expect(permit.complete).toHaveBeenCalledTimes(2);
    } finally {
      firstHold.resolve(permit);
      await Promise.allSettled([scheduler.stop("expire"), cycle, disposeScopes()]);
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it("retains a held peer in the default budget when another held job settles", async () => {
    vi.useFakeTimers();
    const opened = [Promise.withResolvers<Awaited<ReturnType<Throttling["acquire"]>>>(), Promise.withResolvers<Awaited<ReturnType<Throttling["acquire"]>>>()];
    const inspectLater = Promise.withResolvers<void>();
    const permit = { definitionId: rate.id, complete: vi.fn(async () => undefined) };
    const held: number[] = [];
    const admitted: number[] = [];
    const acquire: Throttling["acquire"] = async (_policy, options) => {
      const job = options?.estimatedCost?.requests ?? 0;
      if (options?.maxWaitMs === undefined) {
        if (job > 2) await inspectLater.promise;
        throw new ThrottlingRejectedError(rate.id);
      }
      held.push(job);
      return opened[job - 1]?.promise ?? permit;
    };
    const worker = defineWorker({ name: "partially-drained-hold", queue: "partially-drained-hold", input: z.number(),
      throttling: { requirements: ({ payload }) => ({ admission: rate, estimatedCost: { requests: payload } }), buffering: { strategy: "hold", maxHoldMs: 12 } },
      handler: ({ payload }) => { admitted.push(payload); },
    });
    const { app, adapter, scheduler } = await fixture([worker], { slots: 2, reservationLimit: 4, deferBufferSize: 1, throttling: throttlingFacade({ acquire }) });
    const disposeScopes = trackScopes(app);
    await adapter.enqueue([1, 2, 3, 4].map((payload) => ({ queue: worker.queue, payload })));
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(held).toEqual([1, 2]);
      opened[0]!.resolve(permit);
      await vi.advanceTimersByTimeAsync(0);
      expect(admitted).toEqual([1]);
      // Two more admissions fail while one earlier hold still owns the budget.
      inspectLater.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(held).toEqual([1, 2, 3]);
      expect(admitted).toEqual([1, 3]);
      expect(adapter.inspectJobs().find(({ payload }) => payload === 2)).toMatchObject({ attempt: 1, reservationToken: "token-2" });
      expect(adapter.inspectJobs().find(({ payload }) => payload === 4)).toMatchObject({ attempt: 0 });
      opened[1]!.resolve(permit);
      expect(await cycle).toEqual([{ status: "fulfilled", value: 4 }]);
      expect(adapter.inspectJobs()).toMatchObject([{ payload: 4, attempt: 0 }]);
    } finally {
      inspectLater.resolve();
      for (const gate of opened) gate.resolve(permit);
      await Promise.allSettled([scheduler.stop("expire"), disposeScopes()]);
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it("rejects duplicate starts and keeps the completion of each polling lifetime", async () => {
    const pending = Promise.withResolvers<void>();
    const sleep = vi.fn(async (_delay: number, signal: AbortSignal) => {
      if (signal.aborted) return;
      await pending.promise;
      // A mutant can start an orphan loop. Give that loop a fixture-owned exit.
      if (!signal.aborted) throw new Error("Polling continued past the idle gate.");
    });
    const { app, scheduler } = await fixture([], { sleep, pollIntervalMs: 37 });
    try {
      expect(scheduler.completion).toBeUndefined();
      scheduler.start();
      const first = scheduler.completion;
      await setImmediate();
      expect(sleep).toHaveBeenCalledExactlyOnceWith(37, expect.any(AbortSignal));
      expect(() => scheduler.start()).toThrow("The worker scheduler is already running.");
      const stopping = scheduler.stop();
      const signal = sleep.mock.calls[0]![1];
      expect(signal.aborted).toBe(true);
      pending.resolve();
      await stopping;
      expect(scheduler.completion).toBe(first);
      scheduler.start();
      expect(scheduler.completion).not.toBe(first);
      await scheduler.stop();
    } finally {
      const stopping = scheduler.stop();
      pending.resolve();
      await Promise.allSettled([stopping]);
      await app.dispose();
    }
  });

  it("keeps a one-shot handler cancellable when polling starts during its cycle", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const finish = Promise.withResolvers<void>();
    const worker = defineWorker({
      name: "one-shot-before-polling", queue: "one-shot-before-polling", input: z.null(),
      async handler(_job, _dependencies, { signal }) {
        entered.resolve(signal);
        await finish.promise;
      },
    });
    const { app, adapter, scheduler } = await fixture([worker]);
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const cycle = scheduler.runOnce();
    try {
      // Await a turn before reading the gate so a mutant that never starts the
      // handler cannot stall the test's cleanup.
      await setImmediate();
      const signal = await Promise.race([entered.promise, setImmediate()]);
      expect(signal).toBeInstanceOf(AbortSignal);
      scheduler.start();
      await scheduler.stop("release");
      expect(signal?.aborted).toBe(true);
      expect(adapter.inspectJobs()[0]?.reservationToken).toBeUndefined();
    } finally {
      finish.resolve();
      await Promise.allSettled([cycle, scheduler.completion, scheduler.stop("expire")]);
      await app.dispose();
    }
  });

  it("uses a fresh handler signal when restarting after an expiry stop", async () => {
    const handler = vi.fn();
    const worker = defineWorker({
      name: "restart-after-expire", queue: "restart-after-expire", input: z.null(), handler,
    });
    const { app, adapter, scheduler } = await fixture([worker]);
    try {
      await scheduler.stop("expire");
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      scheduler.start();
      await setImmediate();
      expect(handler).toHaveBeenCalledOnce();
      expect(adapter.inspectJobs()).toEqual([]);
    } finally {
      await Promise.allSettled([scheduler.stop("expire"), scheduler.completion]);
      await app.dispose();
    }
  });

  it("keeps queue-scoped acknowledgements separate in a mixed reservation cycle", async () => {
    const app = new App({});
    const adapter = new MemoryWorkerAdapter({ acknowledgementGrouping: "queue" });
    const workers = ["first-ack", "second-ack"].map((queue) => defineWorker({
      name: queue, queue, input: z.null(), handler: () => undefined,
    }));
    const scheduler = new WorkerScheduler(app, adapter, workers, { slots: 2, leaseMs: 100 });
    const ack = vi.spyOn(adapter, "ack");
    try {
      await app.start();
      const ids = await adapter.enqueue(workers.map(({ queue }) => ({ queue, payload: null })));
      await expect(scheduler.runOnce()).resolves.toBe(2);
      expect(ack.mock.calls.map(([jobs]) => jobs.map(({ jobId }) => jobId))).toEqual(ids.map((id) => [id]));
      expect(adapter.inspectJobs()).toEqual([]);
    } finally { await app.dispose(); }
  });

  it("stops admission while the process pressure check is pending", async () => {
    const pressureResult = Promise.withResolvers<AdmissionAvailability>();
    const inspect = vi.fn(() => pressureResult.promise);
    const worker = defineWorker({ name: "pressure-stop", queue: "pressure-stop", input: z.null(), handler: vi.fn() });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ inspect }), reservationPressure: pressure });
    const ready = vi.spyOn(adapter, "listReadyQueues");
    let stop: Promise<void> | undefined;
    try {
      const cycle = scheduler.runOnce();
      await setImmediate();
      expect(inspect).toHaveBeenCalledOnce();
      let stopped = false;
      stop = scheduler.stop().then(() => { stopped = true; });
      await setImmediate();
      expect(stopped).toBe(false);
      pressureResult.resolve({ state: "available", reasons: [] });
      await expect(cycle).resolves.toBe(0);
      await stop;
      expect(ready).not.toHaveBeenCalled();
    } finally {
      pressureResult.resolve({ state: "unknown", reasons: [] });
      await Promise.allSettled([stop, scheduler.stop()]);
      await app.dispose();
    }
  });

  it("stops admission while a readiness read is pending", async () => {
    const handler = vi.fn();
    const worker = defineWorker({ name: "readiness", queue: "readiness", input: z.null(), handler });
    const sleep = vi.fn(async () => { throw new Error("Unexpected sleep after stop."); });
    const { app, adapter, scheduler } = await fixture([worker], { sleep });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const readiness = Promise.withResolvers<readonly string[]>();
    const list = vi.spyOn(adapter, "listReadyQueues").mockReturnValue(readiness.promise);
    const reserve = vi.spyOn(adapter, "reserve");
    let stop: Promise<void> | undefined;
    try {
      scheduler.start();
      await setImmediate();
      expect(list).toHaveBeenCalledOnce();
      let stopped = false;
      stop = scheduler.stop().then(() => { stopped = true; });
      await setImmediate();
      expect(stopped).toBe(false);
      readiness.resolve([worker.queue]);
      await stop;
      expect(reserve).not.toHaveBeenCalled();
      expect(handler.mock.calls.length).toBe(0);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      readiness.resolve([]);
      await Promise.allSettled([stop, scheduler.stop("expire"), scheduler.completion]);
      await app.dispose();
    }
  });

  it.each(["wait", "release", "expire"] as const)("applies %s to a reservation returned after stop", async (mode) => {
    const handler = vi.fn();
    const reportError = vi.fn();
    const worker = defineWorker({ name: "late-reservation", queue: "late-reservation", input: z.null(), handler });
    const { app, adapter, scheduler } = await fixture([worker], { reportError });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const releaseResponse = Promise.withResolvers<void>();
    const reserve = adapter.reserve.bind(adapter);
    let reserved: readonly ReservedJob[] | undefined;
    vi.spyOn(adapter, "reserve").mockImplementation(async (request) => {
      reserved = await reserve(request);
      await releaseResponse.promise;
      return reserved;
    });
    let stop: Promise<void> | undefined;
    try {
      scheduler.start();
      await setImmediate();
      expect(reserved).toHaveLength(1);
      let stopped = false;
      stop = scheduler.stop(mode).then(() => { stopped = true; });
      await setImmediate();
      expect(stopped).toBe(mode !== "wait");
      releaseResponse.resolve();
      await stop;
      await scheduler.completion;
      expect(handler.mock.calls.length).toBe(0);
      expect(reportError).not.toHaveBeenCalled();
      const [job] = adapter.inspectJobs();
      expect(job?.id).toBe(reserved![0]!.id);
      expect(job?.reservationToken).toBe(mode === "expire" ? reserved![0]!.reservationToken : undefined);
    } finally {
      releaseResponse.resolve();
      await Promise.allSettled([stop, scheduler.stop("expire"), scheduler.completion]);
      await app.dispose();
    }
  });

  it.each(["acknowledgement", "all transitions"] as const)("drains both buffers before reporting shutdown failure in %s", async (scenario) => {
    vi.useFakeTimers();
    const failAck = Promise.withResolvers<void>();
    const finishDefer = Promise.withResolvers<void>();
    const finishHandler = Promise.withResolvers<void>();
    const failure = new Error("Acknowledgement failed during shutdown.");
    const deferralFailure = new Error("Deferral failed during shutdown.");
    const releaseFailure = new Error("Release failed during shutdown.");
    const failAll = scenario === "all transitions";
    const retryAt = new Date("2026-01-01T00:00:01.000Z");
    const workers = [
      defineWorker({
        name: "draining-ack", queue: "draining-ack", input: z.null(), batch: { size: 1 },
        handler: async function* (jobs) {
          yield jobSuccess(jobs[0]!.id);
          await finishHandler.promise;
        },
      }),
      defineWorker({
        name: "draining-defer", queue: "draining-defer", input: z.null(), handler: vi.fn(),
        throttling: { requirements: () => ({ admission: pressure }) },
      }),
    ];
    const { app, adapter, scheduler } = await fixture(workers, {
      slots: 2, ackBufferSize: 1, deferBufferSize: 1,
      throttling: throttlingFacade({ acquire: async () => { throw new ThrottlingRejectedError(pressure.id, retryAt); } }),
    });
    await adapter.enqueue(workers.map(({ queue }) => ({ queue, payload: null })));
    const ack = vi.spyOn(adapter, "ack").mockImplementation(async () => { await failAck.promise; throw failure; });
    const originalDefer = adapter.defer.bind(adapter);
    const defer = vi.spyOn(adapter, "defer").mockImplementation(async (requests) => {
      await finishDefer.promise;
      if (failAll) throw deferralFailure;
      return originalDefer(requests);
    });
    const release = vi.spyOn(adapter, "release");
    if (failAll) release.mockRejectedValue(releaseFailure);
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    let stop: Promise<unknown> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(ack).toHaveBeenCalledOnce();
      expect(defer).toHaveBeenCalledOnce();
      let stopped = false;
      stop = scheduler.stop("release").catch((error: unknown) => error).finally(() => { stopped = true; });
      failAck.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      expect(release).not.toHaveBeenCalled();
      finishDefer.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
      const error = await stop;
      if (failAll) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toBe("Several worker shutdown transitions failed.");
        expect((error as AggregateError).errors).toEqual([failure, deferralFailure, releaseFailure]);
        expect(release).toHaveBeenCalledExactlyOnceWith([
          { jobId: "job-1", reservationToken: "token-1" },
          { jobId: "job-2", reservationToken: "token-2" },
        ]);
        expect(adapter.inspectJobs()).toMatchObject([
          { id: "job-1", reservationToken: "token-1" },
          { id: "job-2", reservationToken: "token-2" },
        ]);
      } else {
        expect(error).toBe(failure);
        expect(release).toHaveBeenCalledExactlyOnceWith([{ jobId: "job-1", reservationToken: "token-1" }]);
        const [returned, deferred] = adapter.inspectJobs();
        expect(returned?.id).toBe("job-1");
        expect(returned?.reservationToken).toBeUndefined();
        expect(deferred?.id).toBe("job-2");
        expect(deferred?.availableAt).toEqual(retryAt);
        expect(deferred?.reservationToken).toBeUndefined();
      }
    } finally {
      failAck.resolve();
      finishDefer.resolve();
      finishHandler.resolve();
      await Promise.allSettled([stop, cycle]);
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["release", "expire", "application"] as const)("cancels an active handler when %s shutdown aborts its signal", async (source) => {
    vi.useFakeTimers();
    const drainMs = 20;
    const finish = Promise.withResolvers<void>();
    const aborted = vi.fn();
    let signal: AbortSignal | undefined;
    const worker = defineWorker({
      name: "active-shutdown", queue: "active-shutdown", input: z.null(),
      handler: async (_job, _dependencies, context) => {
        signal = context.signal;
        context.signal.addEventListener("abort", aborted, { once: true });
        try { await finish.promise; }
        finally { context.signal.removeEventListener("abort", aborted); }
      },
    });
    // Keep the lease heartbeat outside the application drain interval.
    const { app, adapter, scheduler } = await fixture([worker], {}, { drainMs });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    let stop: Promise<void> | undefined;
    let stopped = false;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(false);
      if (source === "application") {
        await app.stop();
        await vi.advanceTimersByTimeAsync(drainMs - 1);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(app.shutdown.signal.aborted).toBe(true);
        expect(signal?.reason).toBe(app.shutdown.signal.reason);
      } else {
        stop = scheduler.stop(source);
        void stop.then(() => { stopped = true; }, () => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(true);
        expect(app.shutdown.signal.aborted).toBe(false);
        const jobs = adapter.inspectJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.reservationToken).toBe(source === "expire" ? "token-1" : undefined);
      }
      expect(signal?.aborted).toBe(true);
      expect(aborted).toHaveBeenCalledOnce();
      finish.resolve();
      expect(await cycle).toEqual([{ status: "fulfilled", value: 1 }]);
    } finally {
      finish.resolve();
      await Promise.allSettled([stop, cycle]);
      try { await app.dispose(); }
      finally { vi.useRealTimers(); }
    }
  });

  it.each([false, true])("cancels only the reclaimed invocation and never persists its stale outcome (failure=%s)", async (failure) => {
    vi.useFakeTimers();
    const finish = Promise.withResolvers<void>();
    const signals = new Map<string, AbortSignal>();
    const complete = vi.fn(async () => undefined);
    const workers = ["reclaimed", "owned"].map((queue) => defineWorker({
      name: queue,
      queue,
      input: z.null(),
      handler: async (_job, _dependencies, context) => {
        signals.set(queue, context.signal);
        await finish.promise;
        if (queue === "reclaimed" && failure) throw new WorkerRetryError("stale retry", 15);
        context.setResult(queue);
      },
    }));
    const { app, adapter, scheduler, advanceStorage } = await fixture(workers, { slots: 2, completeCorrelatedJob: complete });
    await adapter.enqueue(workers.map(({ queue }) => ({ queue, payload: null, correlation: { namespace: "test", id: queue } })));
    const extend = vi.spyOn(adapter, "extendLease");
    const retry = vi.spyOn(adapter, "retry");
    const cycle = scheduler.runOnce();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect([...signals.keys()]).toEqual(["reclaimed", "owned"]);
      advanceStorage(100);
      // A competing poller obtains a new token for one job while both handlers run.
      const [newLease] = await adapter.reserve({ queues: [{ queue: "reclaimed", reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
      expect(newLease?.attempt).toBe(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(signals.get("reclaimed")?.aborted).toBe(true);
      expect(signals.get("reclaimed")?.reason).toMatchObject({ message: 'Worker reservation lost for job "job-1".' });
      expect(signals.get("owned")?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(extend).toHaveBeenCalledTimes(2);
      expect(extend.mock.calls[1]![0]).toEqual([{ jobId: "job-2", reservationToken: "token-2", leaseMs: 100 }]);
      finish.resolve();
      await expect(cycle).resolves.toBe(2);
      expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId: "job-2", result: "owned" }));
      expect(retry).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toMatchObject([{ id: "job-1", reservationToken: newLease!.reservationToken }]);
    } finally {
      finish.resolve();
      await Promise.allSettled([cycle]);
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it("hands a slot past a reclaimed waiter to the next owned job", async () => {
    vi.useFakeTimers();
    const finishFirst = Promise.withResolvers<void>();
    const entered = vi.fn();
    const workers = ["first", "reclaimed", "last"].map((queue) => defineWorker({
      name: queue, queue, input: z.null(),
      async handler() {
        entered(queue);
        if (queue === "first") await finishFirst.promise;
      },
    }));
    const { app, adapter, scheduler, advanceStorage } = await fixture(workers, { reservationLimit: 3 });
    await adapter.enqueue(workers.map(({ queue }) => ({ queue, payload: null })));
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(entered.mock.calls).toEqual([["first"]]);
      advanceStorage(100);
      await expect(adapter.reserve({
        queues: [{ queue: "reclaimed", reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100,
      })).resolves.toMatchObject([{ attempt: 2 }]);
      await vi.advanceTimersByTimeAsync(50);
      finishFirst.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(entered.mock.calls).toEqual([["first"], ["last"]]);
      await expect(cycle).resolves.toEqual([{ status: "fulfilled", value: 3 }]);
    } finally {
      finishFirst.resolve();
      await scheduler.stop("expire").catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it("drops progressively acknowledged leases before the next heartbeat", async () => {
    vi.useFakeTimers();
    const finish = Promise.withResolvers<void>();
    const worker = defineWorker({
      name: "settled-leases", queue: "settled-leases", input: z.null(), batch: { size: 1 },
      async *handler(jobs) {
        yield jobSuccess(jobs[0]!.id);
        await finish.promise;
      },
    });
    const { app, adapter, scheduler } = await fixture([worker], { ackBufferSize: 1 });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const extendLease = vi.spyOn(adapter, "extendLease");
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.inspectJobs()).toEqual([]);
      await vi.advanceTimersByTimeAsync(50);
      expect(extendLease).not.toHaveBeenCalled();
      finish.resolve();
      await expect(cycle).resolves.toEqual([{ status: "fulfilled", value: 1 }]);
    } finally {
      finish.resolve();
      await cycle;
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it("ignores a yielded stale batch job and still delivers its owned peer's next result", async () => {
    vi.useFakeTimers();
    const finish = Promise.withResolvers<void>();
    const complete = vi.fn(async () => undefined);
    let signal: AbortSignal | undefined;
    const worker = defineWorker({ name: "late-batch-result", queue: "late-batch-result", input: z.null(), batch: { size: 2 },
      handler: async function* ([stale, owned], _dependencies, context) {
        signal = context.signal;
        await finish.promise;
        yield jobSuccess(stale!.id, "stale");
        yield jobSuccess(owned!.id, "owned");
      },
    });
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker], { completeCorrelatedJob: complete });
    const ack = vi.spyOn(adapter, "ack");
    await adapter.enqueue([
      { queue: worker.queue, payload: null },
      { queue: worker.queue, payload: null, correlation: { namespace: "test", id: "owned" } },
    ]);
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(false);
      advanceStorage(100);
      const [replacement] = await adapter.reserve({ queues: [{ queue: worker.queue, reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
      await vi.advanceTimersByTimeAsync(50);
      expect(signal?.aborted).toBe(true);
      finish.resolve();
      expect(await cycle).toEqual([{ status: "fulfilled", value: 2 }]);
      expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId: "job-2", result: "owned" }));
      expect(ack).toHaveBeenCalledExactlyOnceWith([{ jobId: "job-2", reservationToken: "token-2" }]);
      expect(adapter.inspectJobs()).toMatchObject([{ id: "job-1", reservationToken: replacement!.reservationToken }]);
    } finally {
      finish.resolve();
      await cycle;
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    { batch: false, wrapped: false },
    { batch: false, wrapped: true },
    { batch: true, wrapped: false },
  ])("leaves cooperatively interrupted work to expire during shutdown ($batch, $wrapped)", async ({ batch, wrapped }) => {
    const entered = vi.fn();
    const finish = Promise.withResolvers<void>();
    const options = { name: "interrupted", queue: "interrupted", input: z.null(), maxAttempts: 1 };
    const worker = batch
      ? defineWorker({
        ...options,
        batch: { size: 2 },
        async *handler(jobs, _deps, { signal }) {
          yield jobSuccess(jobs[0]!.id, "completed before shutdown");
          entered();
          await finish.promise;
          signal.throwIfAborted();
        },
      })
      : defineWorker({
        ...options,
        async handler(_job, _deps, { signal }) {
          entered();
          await finish.promise;
          // Node's timer API wraps the signal reason in an AbortError.
          if (wrapped) await delay(0, undefined, { signal });
          else signal.throwIfAborted();
        },
      });
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker]);
    const completed = vi.fn();
    const record = vi.fn();
    app.container.registerFactory("observer", () => ({ record }), { lifetime: "scoped" });
    app.eventBus.listen(executionCompletedEvent, (event) => completed(event.outcome), { scope: "descendants" });
    const jobs = Array.from({ length: batch ? 2 : 1 }, () => ({ queue: worker.queue, payload: null }));
    await adapter.enqueue(jobs);
    const ack = vi.spyOn(adapter, "ack");
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await setImmediate();
      expect(entered).toHaveBeenCalledOnce();
      await scheduler.stop("expire");
      finish.resolve();
      expect(await cycle).toEqual([{ status: "fulfilled", value: batch ? 2 : 1 }]);
      expect(completed).toHaveBeenCalledExactlyOnceWith("cancelled");
      expect(record).toHaveBeenLastCalledWith(
        executionCompletedObservation, expect.objectContaining({ error: expect.anything() }),
        expect.objectContaining({ outcome: "failure" }),
      );

      // Shutdown must retain reported success and leave the unfinished job leased.
      if (batch) {
        expect(ack).toHaveBeenCalledExactlyOnceWith([{ jobId: "job-1", reservationToken: "token-1" }]);
      }
      expect(adapter.inspectDeadLetters()).toEqual([]);
      expect(adapter.inspectJobs()).toMatchObject([{
        id: batch ? "job-2" : "job-1", attempt: 1, reservationToken: expect.any(String),
      }]);
      const request = {
        queues: [{ queue: worker.queue, reservationLimit: 1, allowOverflow: false }],
        totalLimit: 1,
        leaseMs: 100,
      };
      await expect(adapter.reserve(request)).resolves.toEqual([]);
      advanceStorage(100);
      await expect(adapter.reserve(request)).resolves.toMatchObject([{ attempt: 2 }]);
    } finally {
      finish.resolve();
      await cycle;
      await app.dispose();
    }
  });

  it("preserves a real batch failure when it coincides with shutdown", async () => {
    const entered = vi.fn();
    const finish = Promise.withResolvers<void>();
    const failure = new Error("handler failed independently of shutdown");
    const worker = defineWorker({
      name: "failed-on-shutdown", queue: "failed-on-shutdown", input: z.null(), maxAttempts: 1,
      batch: { size: 2 },
      async handler() {
        entered();
        await finish.promise;
        throw failure;
      },
    });
    const { app, adapter, scheduler } = await fixture([worker]);
    const completed = vi.fn();
    app.eventBus.listen(executionCompletedEvent, (event) => completed(event.outcome), { scope: "descendants" });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await setImmediate();
      expect(entered).toHaveBeenCalledOnce();
      await scheduler.stop("expire");
      finish.resolve();
      expect(await cycle).toEqual([{ status: "fulfilled", value: 1 }]);
      expect(completed).toHaveBeenCalledExactlyOnceWith("failure");
      expect(adapter.inspectDeadLetters()).toMatchObject([{
        originalJobId: "job-1", error: { message: failure.message },
      }]);
    } finally {
      finish.resolve();
      await cycle;
      await app.dispose();
    }
  });

  it.each([
    { held: false, error: new ThrottlingAcquisitionAbortedError(pressure.id) },
    { held: true, error: new ThrottlingClosedError() },
  ])("leaves pending admission to expire when throttling stops during shutdown ($held)", async ({ held, error }) => {
    const admission = Promise.withResolvers<Awaited<ReturnType<Throttling["acquire"]>>>();
    const complete = vi.fn(async () => undefined);
    const acquire = vi.fn<Throttling["acquire"]>().mockReturnValue(admission.promise);
    if (held) acquire.mockRejectedValueOnce(new ThrottlingRejectedError(pressure.id));
    const handler = vi.fn();
    const worker = defineWorker({
      name: "shutdown-admission", queue: "shutdown-admission", input: z.null(), handler,
      throttling: { requirements: () => ({ admission: pressure }), buffering: { strategy: "hold", maxHoldMs: 20 } },
    });
    const { app, adapter, scheduler } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const defer = vi.spyOn(adapter, "defer");
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await setImmediate();
      expect(acquire).toHaveBeenCalledTimes(held ? 2 : 1);
      const signal = acquire.mock.lastCall?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      await scheduler.stop("expire");
      expect(signal?.aborted).toBe(true);
      admission.reject(error);
      expect(await cycle).toEqual([{ status: "fulfilled", value: 1 }]);
      expect(handler).not.toHaveBeenCalled();
      expect(defer).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toMatchObject([{ attempt: 1, reservationToken: "token-1" }]);
    } finally {
      admission.resolve({ definitionId: pressure.id, complete });
      await cycle;
      await app.dispose();
    }
  });

  it("cancels a reclaimed job while it is waiting for dependency admission", async () => {
    vi.useFakeTimers();
    const admission = Promise.withResolvers<Awaited<ReturnType<Throttling["acquire"]>>>();
    let signal: AbortSignal | undefined;
    const completePermit = vi.fn(async () => undefined);
    const acquire: Throttling["acquire"] = async (_definition, options) => {
      signal = options?.signal;
      const onAbort = () => admission.reject(new ThrottlingAcquisitionAbortedError(pressure.id));
      signal?.addEventListener("abort", onAbort, { once: true });
      try { return await admission.promise; }
      finally { signal?.removeEventListener("abort", onAbort); }
    };
    const handler = vi.fn();
    const worker = defineWorker({ name: "blocked", queue: "blocked", input: z.null(), handler, throttling: { requirements: () => ({ admission: pressure }) } });
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const defer = vi.spyOn(adapter, "defer");
    const cycle = scheduler.runOnce();
    let settled = false;
    void cycle.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(false);
      advanceStorage(100);
      const [replacement] = await adapter.reserve({ queues: [{ queue: worker.queue, reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
      expect(replacement?.attempt).toBe(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(signal?.aborted).toBe(true);
      expect(settled).toBe(true);
      await expect(cycle).resolves.toBe(1);
      expect(handler).not.toHaveBeenCalled();
      expect(defer).not.toHaveBeenCalled();
    } finally {
      admission.resolve({ definitionId: pressure.id, complete: completePermit });
      await Promise.allSettled([cycle]);
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it.each([false, true])("returns a permit granted after lease loss (held=%s)", async (held) => {
    vi.useFakeTimers();
    const admission = Promise.withResolvers<Awaited<ReturnType<Throttling["acquire"]>>>();
    const complete = vi.fn(async () => undefined);
    const permit = { definitionId: pressure.id, complete };
    const acquire = vi.fn<Throttling["acquire"]>().mockReturnValue(admission.promise);
    if (held) acquire.mockRejectedValueOnce(new ThrottlingRejectedError(pressure.id));
    const handler = vi.fn();
    const worker = defineWorker({
      name: "late-permit", queue: "late-permit", input: z.null(), handler,
      throttling: { requirements: () => ({ admission: pressure }), buffering: { strategy: "hold", maxHoldMs: 20 } },
    });
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(acquire).toHaveBeenCalledTimes(held ? 2 : 1);
      const signal = acquire.mock.lastCall?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      advanceStorage(100);
      const [replacement] = await adapter.reserve({ queues: [{ queue: worker.queue, reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
      await vi.advanceTimersByTimeAsync(50);
      expect(signal?.aborted).toBe(true);
      admission.resolve(permit);
      expect(await cycle).toEqual([{ status: "fulfilled", value: 1 }]);
      expect(complete).toHaveBeenCalledExactlyOnceWith({ outcome: "failure" });
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toMatchObject([{ attempt: 2, reservationToken: replacement!.reservationToken }]);
    } finally {
      admission.resolve(permit);
      await cycle;
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it.each([false, true])("skips a reclaimed handler after its scoped dependency resolves (batch=%s)", async (batch) => {
    vi.useFakeTimers();
    const dependency = Promise.withResolvers<object>();
    const create = vi.fn(() => dependency.promise);
    const dispose = vi.fn();
    const handler = vi.fn();
    const definition = { name: "slow-dependency", queue: "slow-dependency", input: z.null(), dependencies: { resource: dep<object>("resource") }, handler };
    const worker = batch ? defineWorker({ ...definition, batch: { size: 2 } }) : defineWorker(definition);
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker]);
    app.container.registerAsyncFactory("resource", {}, create, { lifetime: "scoped", dispose });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(create).toHaveBeenCalledOnce();
      advanceStorage(100);
      const [replacement] = await adapter.reserve({ queues: [{ queue: worker.queue, reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
      await vi.advanceTimersByTimeAsync(50);
      const resource = {};
      dependency.resolve(resource);
      expect(await cycle).toEqual([{ status: "fulfilled", value: 1 }]);
      expect(handler).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
      expect(adapter.inspectJobs()).toMatchObject([{ attempt: 2, reservationToken: replacement!.reservationToken }]);
    } finally {
      dependency.resolve({});
      await cycle;
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it("skips dependency admission after the lease is lost during async input validation", async () => {
    vi.useFakeTimers();
    const validation = Promise.withResolvers<boolean>();
    const refine = vi.fn(() => validation.promise);
    const handler = vi.fn();
    const acquire = vi.fn<Throttling["acquire"]>();
    const worker = defineWorker({ name: "reclaimed-validation", queue: "reclaimed-validation",
      input: z.string().refine(refine), validation: { input: "async" }, handler,
      throttling: { requirements: () => ({ admission: rate }) },
    });
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker], { throttling: throttlingFacade({ acquire }) });
    await adapter.enqueue([{ queue: worker.queue, payload: "valid" }]);
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(refine).toHaveBeenCalledOnce();
      advanceStorage(100);
      const [replacement] = await adapter.reserve({ queues: [{ queue: worker.queue, reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
      await vi.advanceTimersByTimeAsync(50);
      validation.resolve(true);
      expect(await cycle).toEqual([{ status: "fulfilled", value: 1 }]);
      expect(acquire).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toMatchObject([{ attempt: 2, reservationToken: replacement!.reservationToken }]);
    } finally {
      validation.resolve(true);
      await cycle;
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it.each([false, true])("drops a reclaimed slot waiter while the running handler retains its lease (batch=%s)", async (batch) => {
    vi.useFakeTimers();
    const finish = Promise.withResolvers<void>();
    const handlers = [vi.fn(async () => { await finish.promise; }), vi.fn()];
    const active = defineWorker({ name: "active-slot", queue: "active-slot", input: z.null(), handler: handlers[0]! });
    const pending = { name: "pending-slot", queue: "pending-slot", input: z.null(), handler: handlers[1]! };
    const workers = [active, batch ? defineWorker({ ...pending, batch: { size: 2 } }) : defineWorker(pending)];
    const reservationLimit = batch ? 3 : 2;
    const { app, adapter, scheduler, advanceStorage } = await fixture(workers, { reservationLimit });
    const jobs = workers.map(({ queue }) => ({ queue, payload: null }));
    if (batch) jobs.push({ queue: pending.queue, payload: null });
    await adapter.enqueue(jobs);
    const cycle = scheduler.runOnce();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(handlers[0]).toHaveBeenCalledOnce();
      expect(handlers[1]).not.toHaveBeenCalled();
      advanceStorage(100);
      const [replacement] = await adapter.reserve({ queues: [{ queue: "pending-slot", reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
      expect(replacement?.attempt).toBe(2);
      await vi.advanceTimersByTimeAsync(50);
      finish.resolve();
      await expect(cycle).resolves.toBe(reservationLimit);
      expect(handlers[1]).not.toHaveBeenCalled();
      const [reclaimed, peer] = adapter.inspectJobs();
      expect(reclaimed).toMatchObject({ id: replacement!.id, reservationToken: replacement!.reservationToken });
      if (batch) {
        // The peer never entered a handler and must be immediately eligible at attempt zero.
        expect(peer).toMatchObject({ id: "job-3", attempt: 0, availableAt: new Date("2026-01-01T00:00:00.100Z") });
        expect(peer?.reservationToken).toBeUndefined();
      } else {
        expect(peer).toBeUndefined();
      }
    } finally {
      finish.resolve();
      await Promise.allSettled([cycle]);
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it("does not cancel a batch when its progressive acknowledgement has committed but the response is pending", async () => {
    vi.useFakeTimers();
    const finishAcknowledgement = Promise.withResolvers<void>();
    const finishHandler = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const worker = defineWorker({
      name: "eager-ack", queue: "eager-ack", input: z.null(), batch: { size: 2 },
      handler: async function* (jobs, _dependencies, context) {
        signal = context.signal;
        yield jobSuccess(jobs[0]!.id);
        await finishHandler.promise;
        yield jobSuccess(jobs[1]!.id);
      },
    });
    const { app, adapter, scheduler } = await fixture([worker], { ackBufferSize: 1 });
    const ack = adapter.ack.bind(adapter);
    vi.spyOn(adapter, "ack").mockImplementation(async (jobs) => {
      const acknowledged = await ack(jobs);
      if (jobs.some(({ jobId }) => jobId === "job-1")) await finishAcknowledgement.promise;
      return acknowledged;
    });
    await adapter.enqueue([{ queue: worker.queue, payload: null }, { queue: worker.queue, payload: null }]);
    const extend = vi.spyOn(adapter, "extendLease");
    const cycle = scheduler.runOnce();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(false);
      expect(adapter.inspectJobs().map(({ id }) => id)).toEqual(["job-2"]);
      await vi.advanceTimersByTimeAsync(50);
      expect(extend).toHaveBeenCalledOnce();
      expect(signal?.aborted).toBe(false);
      finishHandler.resolve();
      finishAcknowledgement.resolve();
      await expect(cycle).resolves.toBe(2);
      expect(adapter.inspectJobs()).toEqual([]);
    } finally {
      finishHandler.resolve();
      finishAcknowledgement.resolve();
      await Promise.allSettled([cycle]);
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["throw", "return"] as const)("returns untouched peers without counting an attempt when a batch handles lease loss by %s", async (mode) => {
    vi.useFakeTimers();
    const finish = Promise.withResolvers<void>();
    const explicitFailure = new Error("Explicit worker failure.");
    let signal: AbortSignal | undefined;
    const worker = defineWorker({
      name: "batch-lease-loss", queue: "batch-lease-loss", input: z.null(), batch: { size: 4 }, maxAttempts: 1,
      handler: async function* (jobs, _dependencies, context) {
        signal = context.signal;
        yield jobSuccess(jobs[0]!.id);
        yield jobFail(jobs[2]!.id, { cause: explicitFailure });
        await finish.promise;
        if (mode === "throw") signal.throwIfAborted();
      },
    });
    const { app, adapter, scheduler, advanceStorage } = await fixture([worker], { ackBufferSize: 1 });
    await adapter.enqueue(Array.from({ length: 4 }, () => ({ queue: worker.queue, payload: null })));
    const cycle = scheduler.runOnce();
    void cycle.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(false);
      expect(adapter.inspectJobs().map(({ id }) => id)).toEqual(["job-2", "job-3", "job-4"]);
      advanceStorage(100);
      const [replacement] = await adapter.reserve({ queues: [{ queue: worker.queue, reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
      expect(replacement?.id).toBe("job-2");
      await vi.advanceTimersByTimeAsync(50);
      expect(signal?.aborted).toBe(true);
      finish.resolve();
      await expect(cycle).resolves.toBe(4);
      expect(adapter.inspectDeadLetters()).toMatchObject([{ originalJobId: "job-3", error: { message: explicitFailure.message } }]);
      expect(adapter.inspectJobs()).toMatchObject([
        { id: "job-2", reservationToken: replacement!.reservationToken },
        { id: "job-4", attempt: 0 },
      ]);
      const [untouched] = await adapter.reserve({ queues: [{ queue: worker.queue, reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
      expect(untouched).toMatchObject({ id: "job-4", attempt: 1 });
    } finally {
      finish.resolve();
      await Promise.allSettled([cycle]);
      await app.dispose();
      vi.useRealTimers();
    }
  });
});
