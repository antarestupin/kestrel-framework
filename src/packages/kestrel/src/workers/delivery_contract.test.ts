import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { WorkerScheduler } from "./scheduler.js";
import { WorkerRetryError } from "./errors.js";
import { defineWorker, jobFail, jobSuccess, type AnyWorker } from "./worker.js";

const epoch = new Date("2026-01-01T00:00:00.000Z");
const owned: Array<{ app: App<Record<string, never>>; scheduler: WorkerScheduler<Record<string, never>> }> = [];
afterEach(async () => {
  try {
    for (const { app, scheduler } of owned.splice(0)) {
      await scheduler.stop();
      await app.dispose();
    }
  } finally { vi.useRealTimers(); }
});

/** Exercise real reservations and public cycles while keeping time and ownership deterministic. */
async function setup(workers: readonly AnyWorker[], options: Partial<ConstructorParameters<typeof WorkerScheduler<Record<string, never>>>[3]> = {}) {
  let clock = epoch;
  let nextId = 0;
  let nextToken = 0;
  const adapter = new MemoryWorkerAdapter({ now: () => clock, createId: () => `job-${++nextId}`, createReservationToken: () => `token-${++nextToken}` });
  const app = new App<Record<string, never>>({});
  await app.start();
  const scheduler = new WorkerScheduler(app, adapter, workers, { slots: 3, leaseMs: 1_000, now: () => clock, ...options });
  owned.push({ app, scheduler });
  return { app, adapter, scheduler, advance: (value: Date) => { clock = value; } };
}

describe("worker delivery contracts", () => {
  it("does not acknowledge an old lease when a correlated write finishes after reclamation", async () => {
    vi.useFakeTimers();
    const finish = Promise.withResolvers<void>();
    const complete = vi.fn(() => finish.promise);
    const worker = defineWorker({
      name: "reclaimed-handoff", queue: "reclaimed-handoff", input: z.null(),
      handler: (_job, _dependencies, context) => context.setResult("completed"),
    });
    const { adapter, scheduler, advance } = await setup([worker], { completeCorrelatedJob: complete });
    await adapter.enqueue([{ queue: worker.queue, payload: null, correlation: { namespace: "test", id: "reclaimed" } }]);
    const ack = vi.spyOn(adapter, "ack");
    const renew = vi.spyOn(adapter, "extendLease");
    const cycle = Promise.allSettled([scheduler.runOnce()]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toHaveBeenCalledOnce();
      // The sink already owns its write, while a competing scheduler can own the queue job.
      advance(new Date(epoch.getTime() + 1_000));
      const [replacement] = await adapter.reserve({
        queues: [{ queue: worker.queue, reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 1_000,
      });
      expect(replacement).toMatchObject({ id: "job-1", attempt: 2, reservationToken: "token-2" });
      await vi.advanceTimersByTimeAsync(500);
      expect(renew).toHaveBeenCalledExactlyOnceWith([{ jobId: "job-1", reservationToken: "token-1", leaseMs: 1_000 }]);
      finish.resolve();
      expect(await cycle).toEqual([{ status: "fulfilled", value: 1 }]);
      expect(ack).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toMatchObject([{ id: "job-1", attempt: 2, reservationToken: "token-2" }]);
    } finally {
      finish.resolve();
      await cycle;
    }
  });

  it.each(["sync", "async"] as const)("keeps sibling result handoffs and their leases alive after another handoff fails (%s)", async (mode) => {
    vi.useFakeTimers();
    const first = new Error("first completion failed");
    const second = new Error("second completion failed");
    let started = false;
    const finish = Promise.withResolvers<void>();
    const worker = defineWorker({ name: "handoffs", queue: "handoffs", input: z.string(), handler: (_job, _dependencies, context) => context.setResult("completed") });
    const { adapter, scheduler } = await setup([worker], { completeCorrelatedJob: (completion) => {
      if (completion.correlation.id === "first") {
        if (mode === "sync") throw first;
        return Promise.reject(first);
      }
      started = true;
      return finish.promise.then(() => { throw second; });
    } });
    await adapter.enqueue([
      { queue: worker.queue, payload: "first", correlation: { namespace: "test", id: "first" } },
      { queue: worker.queue, payload: "second", correlation: { namespace: "test", id: "second" } },
    ]);
    const extend = vi.spyOn(adapter, "extendLease");
    const ack = vi.spyOn(adapter, "ack");
    let settled = false;
    const cycle = scheduler.runOnce().catch((error: unknown) => error).finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe(false);
      expect(extend).toHaveBeenCalledOnce();
      expect(extend.mock.calls[0]![0]).toHaveLength(2);
      expect(ack).not.toHaveBeenCalled();
    } finally { finish.resolve(); await cycle; }
    expect(await cycle).toMatchObject({ errors: [first, second] });
    expect(adapter.inspectJobs()).toHaveLength(2);
    expect(ack).not.toHaveBeenCalled();
  });

  it("waits for independent acknowledgement, retry and dead-letter writes before ending the cycle", async () => {
    vi.useFakeTimers();
    const first = new Error("ack failed");
    const last = new Error("dead letter failed");
    let retryStarted = false;
    const finishRetry = Promise.withResolvers<void>();
    const worker = defineWorker({ name: "mixed-transitions", queue: "mixed-transitions", input: z.enum(["success", "retry", "terminal"]), handler: (job) => {
      if (job.payload === "retry") throw new WorkerRetryError("retry later", 250);
      if (job.payload === "terminal") throw new WorkerRetryError("terminal failure", 0, { maxAttempts: 1 });
    } });
    const { adapter, scheduler } = await setup([worker]);
    await adapter.enqueue(["success", "retry", "terminal"].map((payload) => ({ queue: worker.queue, payload })));
    vi.spyOn(adapter, "ack").mockRejectedValue(first);
    vi.spyOn(adapter, "deadLetter").mockImplementation(() => { throw last; });
    const retry = adapter.retry.bind(adapter);
    vi.spyOn(adapter, "retry").mockImplementation(async (jobs) => { retryStarted = true; await finishRetry.promise; return retry(jobs); });
    const extend = vi.spyOn(adapter, "extendLease");
    let settled = false;
    const cycle = scheduler.runOnce().catch((error: unknown) => error).finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(retryStarted).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe(false);
      expect(extend).toHaveBeenCalledOnce();
    } finally { finishRetry.resolve(); await cycle; }
    expect(await cycle).toMatchObject({ errors: [first, last] });
    const retried = adapter.inspectJobs().find((job) => job.payload === "retry");
    expect(retried?.availableAt).toEqual(new Date(epoch.getTime() + 250));
    expect(retried?.reservedAt).toBeUndefined();
    expect(retried?.reservationToken).toBeUndefined();
  });

  it("shares a gated in-flight cycle rather than reserving the next job concurrently", async () => {
    const finish = Promise.withResolvers<void>();
    const handler = vi.fn(async () => { await finish.promise; });
    const worker = defineWorker({ name: "shared-cycle", queue: "shared-cycle", input: z.null(), handler });
    const { adapter, scheduler } = await setup([worker], { slots: 1, reservationLimit: 1 });
    await adapter.enqueue([{ queue: worker.queue, payload: null }, { queue: worker.queue, payload: null }]);
    const first = scheduler.runOnce();
    let second: Promise<number> | undefined;
    try {
      expect(first).toBeInstanceOf(Promise);
      await setImmediate();
      expect(handler).toHaveBeenCalledOnce();
      second = scheduler.runOnce();
      expect(second).toBe(first);
      expect(handler).toHaveBeenCalledOnce();
    } finally { finish.resolve(); await Promise.allSettled([first, second]); }
    expect(await first).toBe(1);
    expect(adapter.inspectJobs()).toHaveLength(1);
  });

  it("rotates three ready queues fairly across bounded reservation cycles", async () => {
    const order: string[] = [];
    const workers = ["first", "second", "third"].map((name) => defineWorker({
      name, queue: name, input: z.null(), handler: () => { order.push(name); },
    }));
    const { adapter, scheduler } = await setup(workers, { slots: 1, reservationLimit: 1 });
    await adapter.enqueue(workers.flatMap((worker) => [
      { queue: worker.queue, payload: null }, { queue: worker.queue, payload: null },
    ]));
    for (let index = 0; index < 3; index++) expect(await scheduler.runOnce()).toBe(1);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("returns an idle result without acquiring storage when no worker is configured", async () => {
    const { adapter, scheduler } = await setup([]);
    vi.spyOn(adapter, "listReadyQueues").mockRejectedValue(new Error("unused queue storage unavailable"));
    expect(await scheduler.runOnce()).toBe(0);
  });

  it("skips the reservation operation when all configured queues are idle", async () => {
    const worker = defineWorker({ name: "idle-queue", queue: "idle-queue", input: z.null(), handler: vi.fn() });
    const { adapter, scheduler } = await setup([worker]);
    const listReady = vi.spyOn(adapter, "listReadyQueues");
    const reserve = vi.spyOn(adapter, "reserve");
    expect(await scheduler.runOnce()).toBe(0);
    expect(listReady).toHaveBeenCalledExactlyOnceWith([worker.queue]);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("continues polling after a handled job and waits only after a reservation is empty", async () => {
    const handler = vi.fn();
    const worker = defineWorker({ name: "busy-poll", queue: "busy-poll", input: z.null(), handler });
    const emptyPoll = Promise.withResolvers<void>();
    const sleep = vi.fn(async () => { await emptyPoll.promise; });
    const { adapter, scheduler } = await setup([worker], { sleep, pollIntervalMs: 47 });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    const reserve = adapter.reserve.bind(adapter);
    const reservations: number[] = [];
    vi.spyOn(adapter, "reserve").mockImplementation(async (request) => {
      const jobs = await reserve(request);
      reservations.push(jobs.length);
      // Give polling variants that never wait a fixture-owned escape route.
      if (reservations.length > 2) void scheduler.stop("expire");
      return jobs;
    });
    scheduler.start();
    try {
      await setImmediate();
      expect(handler).toHaveBeenCalledOnce();
      expect(reservations).toEqual([1, 0]);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(47, expect.any(AbortSignal));
    } finally {
      const stopping = scheduler.stop();
      emptyPoll.resolve();
      await stopping;
    }
  });

  it("acknowledges an uncorrelated individual job without calling the result sink", async () => {
    const complete = vi.fn(async () => undefined);
    const worker = defineWorker({ name: "uncorrelated", queue: "uncorrelated", input: z.null(),
      handler: (_job, _dependencies, context) => context.setResult("internal result"),
    });
    const { adapter, scheduler } = await setup([worker], { completeCorrelatedJob: complete });
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    expect(await scheduler.runOnce()).toBe(1);
    expect(complete).not.toHaveBeenCalled();
    expect(adapter.inspectJobs()).toEqual([]);
  });

  it("backs off exponentially and respects the retry cap across real reservation attempts", async () => {
    const worker = defineWorker({ name: "backoff", queue: "backoff", input: z.null(), retryDelayMs: 100, maxRetryDelayMs: 250, maxAttempts: 5,
      handler: () => { throw new Error("retryable"); },
    });
    const { adapter, scheduler, advance } = await setup([worker]);
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    let clock = epoch;
    for (const delay of [100, 200, 250, 250]) {
      expect(await scheduler.runOnce()).toBe(1);
      const stored = adapter.inspectJobs()[0]!;
      clock = new Date(clock.getTime() + delay);
      expect(stored.availableAt).toEqual(clock);
      advance(clock);
    }
    expect(adapter.inspectDeadLetters()).toEqual([]);
  });

  for (const mode of ["individual", "batch"] as const) {
    it(`retains a ${mode} terminal override and correlated failure metadata`, async () => {
      const cause = new Error("terminal fixture failure");
      const worker = mode === "individual"
        ? defineWorker({ name: "terminal-individual", queue: "terminal-individual", input: z.null(), maxAttempts: 5,
            handler: () => { throw new WorkerRetryError(cause.message, 0, { maxAttempts: 1 }); } })
        : defineWorker({ name: "terminal-batch", queue: "terminal-batch", input: z.null(), maxAttempts: 5, batch: { size: 1 },
            handler: function* (jobs) { yield jobFail(jobs[0]!.id, { cause, retryDelayMs: 0, maxAttempts: 1 }); } });
      const complete = vi.fn(async () => undefined);
      const { adapter, scheduler } = await setup([worker], { completeCorrelatedJob: complete });
      await adapter.enqueue([{ queue: worker.queue, payload: null, identity: "logical-job", correlation: { namespace: "test", id: "terminal" } }]);
      expect(await scheduler.runOnce()).toBe(1);
      expect(adapter.inspectJobs()).toEqual([]);
      expect(adapter.inspectDeadLetters()).toMatchObject([{ attempt: 1, error: { message: cause.message } }]);
      expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        identity: "logical-job", correlation: { namespace: "test", id: "terminal" }, status: "failed", error: expect.objectContaining({ message: cause.message }),
      }));
    });
  }

  it("rejects duplicate individual result reports instead of acknowledging a success", async () => {
    const worker = defineWorker({ name: "duplicate-result", queue: "duplicate-result", input: z.null(), maxAttempts: 1,
      handler: (_job, _dependencies, context) => { context.setResult("first"); context.setResult("second"); },
    });
    const { adapter, scheduler } = await setup([worker]);
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    await scheduler.runOnce();
    expect(adapter.inspectDeadLetters()).toMatchObject([{ error: { name: "TypeError" } }]);
  });

  it("requires batch results to use per-job outcomes rather than the individual setter", async () => {
    const worker = defineWorker({ name: "batch-setter", queue: "batch-setter", input: z.null(), maxAttempts: 1, batch: { size: 2 },
      handler: (_jobs, _dependencies, context) => { context.setResult("invalid"); },
    });
    const { adapter, scheduler } = await setup([worker]);
    await adapter.enqueue([{ queue: worker.queue, payload: null }, { queue: worker.queue, payload: null }]);
    await scheduler.runOnce();
    expect(adapter.inspectDeadLetters()).toMatchObject([{ error: { name: "TypeError" } }, { error: { name: "TypeError" } }]);
  });

  it("isolates a successful job from a failed job in the same returned batch", async () => {
    const cause = new Error("one batch item failed");
    const worker = defineWorker({ name: "mixed-batch", queue: "mixed-batch", input: z.null(), maxAttempts: 1, batch: { size: 2 },
      handler: function* (jobs) { yield jobSuccess(jobs[0]!.id, "completed"); yield jobFail(jobs[1]!.id, { cause }); },
    });
    const { adapter, scheduler } = await setup([worker]);
    await adapter.enqueue([{ queue: worker.queue, payload: null }, { queue: worker.queue, payload: null }]);
    await scheduler.runOnce();
    expect(adapter.inspectJobs()).toEqual([]);
    expect(adapter.inspectDeadLetters()).toMatchObject([{ originalJobId: "job-2", error: { message: cause.message } }]);
  });

  it("hands off only correlated batch successes and acknowledges every completed job", async () => {
    const worker = defineWorker({ name: "completed-batch", queue: "completed-batch", input: z.null(), batch: { size: 2 },
      handler: function* (jobs) { for (const job of jobs) yield jobSuccess(job.id, `result-${job.id}`); },
    });
    const complete = vi.fn(async () => undefined);
    const { adapter, scheduler } = await setup([worker], { completeCorrelatedJob: complete });
    await adapter.enqueue([
      { queue: worker.queue, payload: null, identity: "correlated-identity", correlation: { namespace: "test", id: "first" } },
      { queue: worker.queue, payload: null },
    ]);
    expect(await scheduler.runOnce()).toBe(2);
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: "completed", result: "result-job-1", identity: "correlated-identity", correlation: { namespace: "test", id: "first" },
    }));
    expect(adapter.inspectJobs()).toEqual([]);
    expect(adapter.inspectDeadLetters()).toEqual([]);
  });

  it("keeps the first correlated result when a batch yields a duplicate job ID", async () => {
    const complete = vi.fn(async () => undefined);
    const worker = defineWorker({
      name: "duplicate-batch-result", queue: "duplicate-batch-result", input: z.null(), maxAttempts: 1, batch: { size: 2 },
      handler: function* ([first]) {
        yield jobSuccess(first!.id, "first result");
        yield jobSuccess(first!.id, "duplicate result");
      },
    });
    const { adapter, scheduler } = await setup([worker], { completeCorrelatedJob: complete });
    await adapter.enqueue([
      { queue: worker.queue, payload: null, correlation: { namespace: "test", id: "first" } },
      { queue: worker.queue, payload: null },
    ]);
    expect(await scheduler.runOnce()).toBe(2);
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId: "job-1", status: "completed", result: "first result" }));
    expect(adapter.inspectDeadLetters()).toMatchObject([{ originalJobId: "job-2", error: { name: "WorkerBatchResultError" } }]);
    expect(adapter.inspectJobs()).toEqual([]);
  });

  it("keeps the failure metadata that was yielded before a batch handler changes its object", async () => {
    const complete = vi.fn(async () => undefined);
    const cause = new Error("first failure");
    const worker = defineWorker({
      name: "yielded-failure", queue: "yielded-failure", input: z.null(), batch: { size: 2 },
      handler: function* ([failed, completed]) {
        const failure = { cause, retryDelayMs: 0, maxAttempts: 1 };
        yield jobFail(failed!.id, failure);
        failure.cause = new Error("later failure");
        failure.maxAttempts = 0;
        yield jobSuccess(completed!.id, "completed peer");
      },
    });
    const { adapter, scheduler } = await setup([worker], { completeCorrelatedJob: complete });
    await adapter.enqueue([
      { queue: worker.queue, payload: null },
      { queue: worker.queue, payload: null, correlation: { namespace: "test", id: "peer" } },
    ]);
    expect(await scheduler.runOnce()).toBe(2);
    expect(adapter.inspectDeadLetters()).toMatchObject([{ originalJobId: "job-1", error: { message: cause.message } }]);
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId: "job-2", result: "completed peer" }));
    expect(adapter.inspectJobs()).toEqual([]);
  });

  it.each([{ retryDelayMs: -1 }, { retryDelayMs: NaN }, { maxAttempts: 0 }, { maxAttempts: 1.5 }])(
    "treats invalid hand-written failure metadata as a batch result error (%j)",
    async (invalid) => {
      const worker = defineWorker({
        name: "invalid-batch-metadata", queue: "invalid-batch-metadata", input: z.null(), maxAttempts: 1, batch: { size: 2 },
        handler: function* ([job]) {
          yield { status: "error", key: job!.id, error: { cause: new Error("reported failure"), ...invalid } };
        },
      });
      const { adapter, scheduler } = await setup([worker]);
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      expect(await scheduler.runOnce()).toBe(1);
      expect(adapter.inspectDeadLetters()).toMatchObject([{ originalJobId: "job-1", error: { name: "WorkerBatchResultError" } }]);
    },
  );

  it("preserves an explicit batch failure when a later generator operation throws", async () => {
    const explicit = new Error("explicit terminal failure");
    const interrupted = new Error("later generator failure");
    const worker = defineWorker({ name: "preserved-failure", queue: "preserved-failure", input: z.null(), batch: { size: 3 }, maxAttempts: 5,
      handler: function* (jobs) {
        yield jobFail(jobs[0]!.id, { cause: explicit, maxAttempts: 1, retryDelayMs: 0 });
        yield jobSuccess(jobs[1]!.id, "completed-peer");
        throw interrupted;
      },
    });
    const complete = vi.fn(async () => undefined);
    const { adapter, scheduler } = await setup([worker], { completeCorrelatedJob: complete });
    const retry = vi.spyOn(adapter, "retry");
    await adapter.enqueue([
      { queue: worker.queue, payload: null },
      { queue: worker.queue, payload: null, correlation: { namespace: "test", id: "success" } },
      { queue: worker.queue, payload: null },
    ]);
    expect(await scheduler.runOnce()).toBe(3);
    expect(adapter.inspectDeadLetters()).toMatchObject([{ originalJobId: "job-1", error: { message: explicit.message } }]);
    expect(adapter.inspectJobs()).toMatchObject([{ id: "job-3", attempt: 1 }]);
    expect(retry).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ jobId: "job-3", error: expect.objectContaining({ message: interrupted.message }) })]);
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "completed", result: "completed-peer" }));
  });

  it("respects disabled batch overflow even when reservation capacity remains", async () => {
    const sizes: number[] = [];
    const worker = defineWorker({ name: "bounded-batch", queue: "bounded-batch", input: z.null(), batch: { size: 2, allowOverflow: false },
      handler: (jobs) => { sizes.push(jobs.length); },
    });
    const { adapter, scheduler } = await setup([worker], { slots: 1, reservationLimit: 4 });
    await adapter.enqueue(Array.from({ length: 4 }, () => ({ queue: worker.queue, payload: null })));
    expect(await scheduler.runOnce()).toBe(2);
    expect(sizes).toEqual([2]);
    expect(adapter.inspectJobs()).toHaveLength(2);
  });

  it("closes heartbeat ownership and forgets completed reservations before release shutdown", async () => {
    vi.useFakeTimers();
    const worker = defineWorker({ name: "finished-lease", queue: "finished-lease", input: z.null(), handler: () => undefined });
    const { adapter, scheduler } = await setup([worker]);
    const release = vi.spyOn(adapter, "release");
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    expect(await scheduler.runOnce()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.stop("release");
    expect(release.mock.calls.flatMap(([jobs]) => jobs)).toEqual([]);
  });

  it("lets a failed handoff's lease expire after its cycle has stopped tracking it", async () => {
    const failure = new Error("handoff failed");
    const complete = vi.fn(async () => { throw failure; });
    const worker = defineWorker({ name: "failed-handoff", queue: "failed-handoff", input: z.null(), handler: vi.fn() });
    const { adapter, scheduler } = await setup([worker], { completeCorrelatedJob: complete });
    const release = vi.spyOn(adapter, "release");
    await adapter.enqueue([{ queue: worker.queue, payload: null, correlation: { namespace: "test", id: "failed" } }]);
    await expect(scheduler.runOnce()).rejects.toBe(failure);
    await scheduler.stop("release");
    expect(release.mock.calls.flatMap(([jobs]) => jobs)).toEqual([]);
    expect(adapter.inspectJobs()).toMatchObject([{ id: "job-1", attempt: 1, reservationToken: "token-1" }]);
  });

  it.each([false, true])("flushes a progressively buffered acknowledgement exactly once (batch throws=%s)", async (throws) => {
    const worker = defineWorker({ name: "progressive-ack", queue: "progressive-ack", input: z.null(), batch: { size: 2 },
      handler: function* ([job]) {
        yield jobSuccess(job!.id);
        if (throws) throw new Error("generator failed after the successful yield");
      },
    });
    // Keep the first result in the buffer until the whole invocation has settled.
    const { adapter, scheduler } = await setup([worker], { ackBufferSize: 100, ackFlushIntervalMs: 1_000 });
    const ack = vi.spyOn(adapter, "ack");
    await adapter.enqueue([{ queue: worker.queue, payload: null }]);
    expect(await scheduler.runOnce()).toBe(1);
    expect(ack).toHaveBeenCalledExactlyOnceWith([{ jobId: "job-1", reservationToken: "token-1" }]);
    expect(adapter.inspectJobs()).toEqual([]);
  });

  for (const invalid of ["unknown", "duplicate"] as const) {
    it(`rejects a ${invalid} yielded job ID while preserving completed peer work`, async () => {
      const worker = defineWorker({ name: `invalid-${invalid}`, queue: `invalid-${invalid}`, input: z.null(), maxAttempts: 1, batch: { size: 2 },
        handler: function* (jobs) {
          if (invalid === "duplicate") yield jobSuccess(jobs[0]!.id, "completed");
          yield jobSuccess(invalid === "unknown" ? "not-a-reserved-job" : jobs[0]!.id, "invalid");
        },
      });
      const { adapter, scheduler } = await setup([worker]);
      await adapter.enqueue([{ queue: worker.queue, payload: null }, { queue: worker.queue, payload: null }]);
      await scheduler.runOnce();
      expect(adapter.inspectJobs()).toEqual([]);
      const letters = adapter.inspectDeadLetters();
      expect(letters).toHaveLength(invalid === "unknown" ? 2 : 1);
      expect(letters[0]!.error.name).toBe("WorkerBatchResultError");
    });
  }

  it("persists an already yielded correlated success even when the generator later throws", async () => {
    const cause = new Error("generator interrupted");
    const worker = defineWorker({ name: "interrupted-batch", queue: "interrupted-batch", input: z.null(), maxAttempts: 1, batch: { size: 2 },
      handler: function* (jobs) { yield jobSuccess(jobs[0]!.id, "durable-result"); throw cause; },
    });
    const complete = vi.fn(async () => undefined);
    const { adapter, scheduler } = await setup([worker], { completeCorrelatedJob: complete });
    await adapter.enqueue([
      { queue: worker.queue, payload: null, correlation: { namespace: "test", id: "first" } },
      { queue: worker.queue, payload: null },
    ]);
    await scheduler.runOnce();
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "completed", result: "durable-result" }));
    expect(adapter.inspectJobs()).toEqual([]);
    expect(adapter.inspectDeadLetters()).toMatchObject([{ originalJobId: "job-2", error: { message: cause.message } }]);
  });


  it("recovers an ordinary polling failure but surfaces an uncancelled sleep failure", async () => {
    const cycleFailure = new Error("temporary queue failure");
    const sleepFailure = new Error("polling delay failed");
    const reportError = vi.fn();
    let calls = 0;
    let scheduler: WorkerScheduler<Record<string, never>>;
    const sleep = vi.fn(async () => {
      calls++;
      // Bound a broken mutant that swallows the fatal delay failure, then let
      // the completion assertion distinguish it from the required rejection.
      if (calls >= 3) { void scheduler.stop("expire"); return; }
      if (calls === 2) throw sleepFailure;
    });
    const worker = defineWorker({ name: "polling", queue: "polling", input: z.null(), handler: () => undefined });
    const state = await setup([worker], { sleep, reportError });
    scheduler = state.scheduler;
    vi.spyOn(state.adapter, "listReadyQueues").mockRejectedValueOnce(cycleFailure);
    scheduler.start();
    await expect(scheduler.completion).rejects.toBe(sleepFailure);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(cycleFailure);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("treats a delay rejected by cooperative shutdown as a clean polling completion", async () => {
    const sleeping = Promise.withResolvers<void>();
    const worker = defineWorker({ name: "cancelled-poll", queue: "cancelled-poll", input: z.null(), handler: () => undefined });
    const { scheduler } = await setup([worker], { sleep: async (_delay, signal) => {
      sleeping.resolve();
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } });
    scheduler.start();
    try {
      await sleeping.promise;
      await scheduler.stop();
      await expect(scheduler.completion).resolves.toBeUndefined();
    } finally { await scheduler.stop("expire"); }
  });


  it("finishes peer handlers and their durable outcomes after one execution scope fails to open", async () => {
    vi.useFakeTimers();
    const failure = new Error("execution scope unavailable");
    let started = false;
    const finish = Promise.withResolvers<void>();
    const worker = defineWorker({ name: "scope-peers", queue: "scope-peers", input: z.null(), handler: async () => { started = true; await finish.promise; } });
    const { app, adapter, scheduler } = await setup([worker]);
    await adapter.enqueue([{ queue: worker.queue, payload: null }, { queue: worker.queue, payload: null }]);
    vi.spyOn(app, "createExecutionScope").mockRejectedValueOnce(failure);
    const extend = vi.spyOn(adapter, "extendLease");
    let settled = false;
    const cycle = scheduler.runOnce().catch((error: unknown) => error).finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe(false);
      expect(extend).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await cycle;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(await cycle).toBe(failure);
    expect(adapter.inspectJobs().map((job) => job.id)).toEqual(["job-1"]);
  });

  it("retains both invocation and completed-peer persistence failures", async () => {
    const invocationFailure = new Error("scope creation failed");
    const persistenceFailure = new Error("peer acknowledgement failed");
    const worker = defineWorker({ name: "combined-failures", queue: "combined-failures", input: z.null(), handler: () => undefined });
    const { app, adapter, scheduler } = await setup([worker]);
    await adapter.enqueue([{ queue: worker.queue, payload: null }, { queue: worker.queue, payload: null }]);
    vi.spyOn(app, "createExecutionScope").mockRejectedValueOnce(invocationFailure);
    vi.spyOn(adapter, "ack").mockRejectedValueOnce(persistenceFailure);
    await expect(scheduler.runOnce()).rejects.toMatchObject({ errors: [invocationFailure, persistenceFailure] });
    expect(adapter.inspectJobs()).toHaveLength(2);
  });

});
