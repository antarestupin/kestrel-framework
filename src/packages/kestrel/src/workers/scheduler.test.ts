import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import {
  AsyncLocalObserverContext,
  type ObservationEvent,
  type ObservationRecorder,
  ScopedObserver,
} from "../observability/index.js";
import {
  circuitBreaker,
  defineAdmissionPolicy,
  defineRateLimit,
  localResourcePressure,
  LocalResourcePressureMonitor,
  MemoryRateLimitAdapter,
  minutes,
  rateLimit,
  seconds,
  ThrottlingManager,
  type LocalResourcePressureSource,
} from "../throttling/index.js";
import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { WorkerScheduler } from "./scheduler.js";
import { WorkerRetryError } from "./errors.js";
import {
  defineWorker,
  jobFail,
  jobSuccess,
} from "./worker.js";

function createAdapter(): MemoryWorkerAdapter {
  let id = 0;
  let token = 0;

  return new MemoryWorkerAdapter({
    createId: () => `id-${++id}`,
    createReservationToken: () => `token-${++token}`,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

/** Creates an application that captures scoped observations in memory. */
async function createObservedApp(): Promise<{
  app: App<Record<string, never>>;
  events: ObservationEvent[];
  observerContext: AsyncLocalObserverContext;
}> {
  const app = new App<Record<string, never>>({});
  const events: ObservationEvent[] = [];
  const observerContext = new AsyncLocalObserverContext();
  const recorder: ObservationRecorder = {
    enqueue: (event) => events.push(event),
    flush: async () => {},
    close: async () => {},
    getHealth: () => ({
      status: "healthy",
      pendingCount: 0,
      droppedCount: 0,
      droppedByOverflow: 0,
      droppedByStorageFailure: 0,
      consecutiveStorageFailures: 0,
    }),
  };

  app.container.registerValue("observationRecorder", recorder);
  app.container.registerValue("observerContext", observerContext);
  app.container.registerFactory(
    "observer",
    ({ executionId, observationRecorder }: {
      executionId: string;
      observationRecorder: ObservationRecorder;
    }) => new ScopedObserver(executionId, observationRecorder),
    { lifetime: "scoped" },
  );
  await app.start();

  return { app, events, observerContext };
}

/** Creates a running application for scheduler-only tests. */
async function createStartedApp(): Promise<App<Record<string, never>>> {
  const app = new App<Record<string, never>>({});

  await app.start();

  return app;
}

describe("WorkerScheduler", () => {
  it.each([
    { size: 1, fail: false },
    { size: 100, fail: false },
    { size: 1, fail: true },
    { size: 100, fail: true },
  ])("keeps correlated ACKs behind slow persistence (size $size, failure $fail)", async ({ size, fail }) => {
    vi.useFakeTimers();
    const app = await createStartedApp();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let cycle: Promise<unknown> | undefined;
    try {
      const adapter = createAdapter();
      const ack = vi.spyOn(adapter, "ack");
      const worker = defineWorker({
        name: "slow-result",
        queue: "slow-result",
        input: z.string(),
        handler: () => undefined,
      });
      await adapter.enqueue([{
        queue: worker.queue,
        payload: "payload",
        correlation: { namespace: "workflow.activity", id: "execution/1" },
      }]);
      const scheduler = new WorkerScheduler(app, adapter, [worker], {
        slots: 1,
        leaseMs: 1_000,
        ackBufferSize: size,
        ackFlushIntervalMs: 10,
        completeCorrelatedJob: async () => {
          started.resolve();
          await finish.promise;
          if (fail) throw new Error("result store unavailable");
        },
      });
      cycle = scheduler.runOnce().then(
        (count) => ({ count }),
        (error: unknown) => ({ error }),
      );
      await started.promise;
      // Neither a full batch, its timer, nor shutdown may acknowledge a result
      // that has not reached its destination yet.
      await vi.advanceTimersByTimeAsync(20);
      await scheduler.stop("expire");
      expect(ack).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toHaveLength(1);
      finish.resolve();
      expect(await cycle).toEqual(fail
        ? { error: new Error("result store unavailable") }
        : { count: 1 });
      await vi.advanceTimersByTimeAsync(20);
      expect(adapter.inspectJobs()).toHaveLength(fail ? 1 : 0);
    } finally {
      finish.resolve();
      await cycle;
      await app.stop();
      vi.useRealTimers();
    }
  });

  it.each(["sync", "async"] as const)("hands off a correlated result before acknowledging the queue job (%s)", async (mode) => {
    const adapter = createAdapter();
    const completions: unknown[] = [];
    const worker = defineWorker({
      name: "correlated-result",
      queue: "correlated-result",
      input: mode === "async" ? z.number().refine(async () => true) : z.number(),
      validation: { input: mode },
      handler: (_job, _dependencies, context) => {
        context.setResult({ doubled: 4 });
      },
    });
    await adapter.enqueue([{
      identity: "workflow/activity/1",
      queue: worker.queue,
      payload: 2,
      correlation: { namespace: "workflow.activity", id: "execution/1" },
    }]);
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        completeCorrelatedJob: async (completion) => {
          expect(adapter.inspectJobs()).toHaveLength(1);
          completions.push(completion);
        },
      },
    );

    await scheduler.runOnce();

    expect(completions).toEqual([{
      jobId: "id-1",
      identity: "workflow/activity/1",
      correlation: { namespace: "workflow.activity", id: "execution/1" },
      status: "completed",
      result: { doubled: 4 },
    }]);
    expect(adapter.inspectJobs()).toHaveLength(0);
  });

  it("keeps a correlated job leased when terminal result handoff fails", async () => {
    const adapter = createAdapter();
    const worker = defineWorker({
      name: "correlated-handoff-failure",
      queue: "correlated-handoff-failure",
      input: z.string(),
      handler: () => undefined,
    });
    await adapter.enqueue([{
      queue: worker.queue,
      payload: "payload",
      correlation: { namespace: "workflow.activity", id: "execution/1" },
    }]);
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        completeCorrelatedJob: async () => {
          throw new Error("result store unavailable");
        },
      },
    );

    await expect(scheduler.runOnce()).rejects.toThrow("result store unavailable");
    expect(adapter.inspectJobs()).toMatchObject([{ attempt: 1 }]);
  });

  it("skips queue storage while the process-wide reservation gate is pressured", async () => {
    const adapter = createAdapter();
    const reserve = vi.spyOn(adapter, "reserve");
    const listReadyQueues = vi.spyOn(adapter, "listReadyQueues");
    const worker = defineWorker({
      name: "pressured",
      queue: "pressured",
      input: z.string(),
      handler: vi.fn(),
    });
    await adapter.enqueue([{ queue: worker.queue, payload: "payload" }]);
    const source: LocalResourcePressureSource = {
      supports: (signalId) => signalId === "cpu",
      read: () => 0.95,
    };
    const monitor = new LocalResourcePressureMonitor([source]);
    const throttling = new ThrottlingManager(new MemoryRateLimitAdapter(), {
      namespace: "workers",
      resourcePressureMonitor: monitor,
    });
    const reservationPressure = defineAdmissionPolicy({
      id: "worker-process-pressure",
      limits: [localResourcePressure({
        id: "worker-process",
        signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } },
      })],
    });
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        throttling,
        reservationPressure,
      },
    );

    await expect(scheduler.runOnce()).resolves.toBe(0);
    expect(listReadyQueues).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(adapter.inspectJobs()).toHaveLength(1);
    await throttling.close();
  });

  it("leaves jobs pending while their queue is paused", async () => {
    const adapter = createAdapter();
    const handler = vi.fn();
    const worker = defineWorker({
      name: "paused",
      queue: "paused",
      input: z.string(),
      handler,
    });
    await adapter.enqueue([{ queue: worker.queue, payload: "payload" }]);
    await adapter.setQueueEnabled(worker.queue, false);
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      { slots: 1, leaseMs: 1_000, readyQueueRefreshMs: 1 },
    );

    await expect(scheduler.runOnce()).resolves.toBe(0);

    expect(handler).not.toHaveBeenCalled();
    expect(adapter.inspectJobs()).toHaveLength(1);
  });

  it("validates payloads and acknowledges successful individual jobs", async () => {
    const adapter = createAdapter();
    const { app, events, observerContext } = await createObservedApp();
    const handler = vi.fn(async () => {
      expect(observerContext.get()).toBeDefined();
    });
    const worker = defineWorker({
      name: "email.send",
      queue: "emails",
      input: z.object({ email: z.email() }),
      handler,
    });
    await adapter.enqueue([{
      queue: worker.queue,
      payload: { email: "user@example.com" },
    }]);
    const scheduler = new WorkerScheduler(
      app,
      adapter,
      [worker],
      { slots: 1, leaseMs: 1_000 },
    );

    await expect(scheduler.runOnce()).resolves.toBe(1);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { email: "user@example.com" },
        attempt: 1,
      }),
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(adapter.inspectJobs()).toHaveLength(0);
    expect(events.map((event) => event.name)).toEqual([
      "execution.started",
      "execution.completed",
    ]);
    expect(events[0]?.data).toEqual({
      operation: "email.send",
      transport: "worker",
    });
    expect(events[1]).toMatchObject({
      executionId: events[0]?.executionId,
      outcome: "success",
      durationMs: expect.any(Number),
      data: {
        operation: "email.send",
        transport: "worker",
      },
    });
  });

  it("retries failures and dead-letters the final confirmed failure", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let id = 0;
    const adapter = new MemoryWorkerAdapter({
      createId: () => `id-${++id}`,
      createReservationToken: () => `token-${id}`,
      now: () => now,
    });
    const worker = defineWorker({
      name: "failing",
      queue: "failures",
      input: z.string(),
      maxAttempts: 2,
      retryDelayMs: 100,
      handler: async () => {
        throw new Error("handler failed");
      },
    });
    const { app, events } = await createObservedApp();
    const requestedExecutionId = "00000000-0000-4000-8000-000000000001";
    await adapter.enqueue([{
      queue: worker.queue,
      payload: "payload",
      executionId: requestedExecutionId,
    }]);
    const scheduler = new WorkerScheduler(
      app,
      adapter,
      [worker],
      { slots: 1, leaseMs: 1_000, now: () => now },
    );

    await scheduler.runOnce();
    expect(adapter.inspectJobs()).toMatchObject([{
      attempt: 1,
      availableAt: new Date("2026-01-01T00:00:00.100Z"),
    }]);

    now = new Date("2026-01-01T00:00:00.100Z");
    await scheduler.runOnce();

    expect(adapter.inspectJobs()).toHaveLength(0);
    expect(adapter.inspectDeadLetters()).toMatchObject([{
      attempt: 2,
      error: { message: "handler failed" },
    }]);
    expect(events.map((event) => ({
      name: event.name,
      outcome: event.outcome,
      operation: event.data.operation,
      transport: event.data.transport,
    }))).toEqual([
      {
        name: "execution.started",
        outcome: undefined,
        operation: "failing",
        transport: "worker",
      },
      {
        name: "execution.completed",
        outcome: "failure",
        operation: "failing",
        transport: "worker",
      },
      {
        name: "execution.started",
        outcome: undefined,
        operation: "failing",
        transport: "worker",
      },
      {
        name: "execution.completed",
        outcome: "failure",
        operation: "failing",
        transport: "worker",
      },
    ]);
    expect(events[0]?.executionId).toBe(requestedExecutionId);
    expect(events[2]?.executionId).not.toBe(requestedExecutionId);
    expect(events[0]?.executionId).not.toBe(events[2]?.executionId);
  });

  it("uses a supplied execution ID for an individual job", async () => {
    const adapter = createAdapter();
    const { app, events } = await createObservedApp();
    const worker = defineWorker({
      name: "correlated",
      queue: "correlated",
      input: z.string(),
      handler: () => undefined,
    });
    const executionId = "00000000-0000-4000-8000-000000000001";
    await adapter.enqueue([{
      queue: worker.queue,
      payload: "payload",
      executionId,
    }]);
    const scheduler = new WorkerScheduler(
      app,
      adapter,
      [worker],
      { slots: 1, leaseMs: 1_000 },
    );

    await scheduler.runOnce();

    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.executionId)))
      .toEqual(new Set([executionId]));
  });

  it("isolates a correlated job from ordinary batch invocations", async () => {
    const adapter = createAdapter();
    const { app, events } = await createObservedApp();
    const handledBatches: string[][] = [];
    const worker = defineWorker({
      name: "batch-correlated",
      queue: "batch-correlated",
      input: z.number(),
      batch: { size: 3 },
      handler: (jobs) => {
        handledBatches.push(jobs.map((job) => job.id));
      },
    });
    const executionId = "00000000-0000-4000-8000-000000000001";
    await adapter.enqueue([
      { queue: worker.queue, payload: 1 },
      { queue: worker.queue, payload: 2, executionId },
      { queue: worker.queue, payload: 3 },
      { queue: worker.queue, payload: 4 },
    ]);
    const scheduler = new WorkerScheduler(
      app,
      adapter,
      [worker],
      { slots: 2, leaseMs: 1_000 },
    );

    await scheduler.runOnce();

    expect(handledBatches).toEqual([
      ["id-1"],
      ["id-2"],
      ["id-3", "id-4"],
    ]);
    const invocationExecutionIds = events
      .filter((event) => event.name === "execution.started")
      .map((event) => event.executionId);
    expect(invocationExecutionIds).toHaveLength(3);
    expect(invocationExecutionIds[1]).toBe(executionId);
    expect(new Set(invocationExecutionIds).size).toBe(3);
  });

  it("keeps yielded successes when later batch results are missing", async () => {
    const adapter = createAdapter();
    const { app, events } = await createObservedApp();
    const worker = defineWorker({
      name: "batch",
      queue: "batch",
      input: z.number(),
      maxAttempts: 1,
      batch: { size: 2 },
      handler: function *(jobs) {
        yield jobSuccess(jobs[0]!.id);
      },
    });
    await adapter.enqueue([
      { queue: worker.queue, payload: 1 },
      { queue: worker.queue, payload: 2 },
    ]);
    const scheduler = new WorkerScheduler(
      app,
      adapter,
      [worker],
      { slots: 1, leaseMs: 1_000 },
    );

    await scheduler.runOnce();

    expect(adapter.inspectJobs()).toHaveLength(0);
    expect(adapter.inspectDeadLetters()).toHaveLength(1);
    expect(adapter.inspectDeadLetters()[0]?.error.name)
      .toBe("WorkerBatchResultError");
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.executionId)).size).toBe(1);
    expect(events[1]).toMatchObject({
      outcome: "failure",
      data: { operation: "batch", transport: "worker" },
    });
  });

  it("durably acknowledges yielded successes before a batch completes", async () => {
    const adapter = createAdapter();
    const failure = new Error("batch interrupted");
    let releaseHandler = (): void => undefined;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const worker = defineWorker({
      name: "progressive-batch",
      queue: "progressive-batch",
      input: z.number(),
      maxAttempts: 1,
      batch: { size: 2 },
      handler: async function *(jobs) {
        yield jobSuccess(jobs[0]!.id);
        await handlerBlocked;
        throw failure;
      },
    });
    await adapter.enqueue([
      { queue: worker.queue, payload: 1 },
      { queue: worker.queue, payload: 2 },
    ]);
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        ackBufferSize: 1,
      },
    );

    const running = scheduler.runOnce();

    await vi.waitFor(() => expect(adapter.inspectJobs()).toHaveLength(1));
    releaseHandler();
    await running;

    expect(adapter.inspectJobs()).toHaveLength(0);
    expect(adapter.inspectDeadLetters()).toHaveLength(1);
    expect(adapter.inspectDeadLetters()[0]?.error.message)
      .toBe(failure.message);
  });

  it("honors a manual retry delay requested by a handler", async () => {
    const adapter = createAdapter();
    const worker = defineWorker({
      name: "manual-retry",
      queue: "manual-retry",
      input: z.string(),
      handler: () => {
        throw new WorkerRetryError("try later", 250);
      },
    });
    await adapter.enqueue([{ queue: worker.queue, payload: "payload" }]);
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      },
    );

    await scheduler.runOnce();

    expect(adapter.inspectJobs()[0]?.availableAt).toEqual(
      new Date("2026-01-01T00:00:00.250Z"),
    );
  });

  it("honors a manual retry delay yielded by a batch handler", async () => {
    const adapter = createAdapter();
    const failure = new Error("try later");
    const worker = defineWorker({
      name: "batch-manual-retry",
      queue: "batch-manual-retry",
      input: z.string(),
      batch: { size: 1 },
      handler: function *(jobs) {
        yield jobFail(jobs[0]!.id, {
          cause: failure,
          retryDelayMs: 250,
        });
      },
    });
    await adapter.enqueue([{ queue: worker.queue, payload: "payload" }]);
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      },
    );

    await scheduler.runOnce();

    expect(adapter.inspectJobs()[0]?.availableAt).toEqual(
      new Date("2026-01-01T00:00:00.250Z"),
    );
  });

  it("rejects invalid batch retry delays in the failure helper", () => {
    expect(() => jobFail("job", {
      cause: new Error("failed"),
      retryDelayMs: -1,
    })).toThrow("Worker retry delays must be non-negative finite numbers.");
  });

  it("combines batch estimates and reports one invocation-wide actual cost", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const rateAdapter = new MemoryRateLimitAdapter({ now: () => now });
    const throttling = new ThrottlingManager(rateAdapter, {
      namespace: "workers",
      now: () => now,
    });
    const policy = defineAdmissionPolicy({
      id: "partner-api",
      limits: [rateLimit({
        id: "partner-requests",
        unit: "requests",
        limit: 10,
        per: minutes(1),
        burst: 10,
      })],
      costAccounting: { reconciliation: "synchronous" },
    });
    const worker = defineWorker({
      name: "throttled-batch",
      queue: "throttled-batch",
      input: z.coerce.number(),
      batch: { size: 2 },
      throttling: {
        requirements: (job) => ({
          admission: policy,
          estimatedCost: { requests: job.payload },
        }),
      },
      handler: (_jobs, _dependencies, context) => {
        context.reportActualCost({ requests: 2 });
      },
    });
    const adapter = createAdapter();
    await adapter.enqueue([
      { queue: worker.queue, payload: "2" },
      { queue: worker.queue, payload: "3" },
    ]);
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        throttling,
      },
    );

    await scheduler.runOnce();

    await expect(rateAdapter.inspectMany([{
      key: "workers:partner-requests",
      limit: 10,
      periodMs: 60_000,
      burst: 10,
      cost: 1,
    }])).resolves.toMatchObject([{ remaining: 8 }]);
    expect(adapter.inspectJobs()).toHaveLength(0);
    await throttling.close();
  });

  it("defers rejected jobs until retryAt without consuming an attempt", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const rateAdapter = new MemoryRateLimitAdapter({ now: () => now });
    const throttling = new ThrottlingManager(rateAdapter, {
      namespace: "workers",
      now: () => now,
    });
    const limit = defineRateLimit({
      id: "partner-api",
      requests: 1,
      per: minutes(1),
    });
    const occupied = await throttling.acquire(limit);
    await occupied.complete({ outcome: "success" });
    const handler = vi.fn();
    const decisions: string[] = [];
    const worker = defineWorker({
      name: "deferred",
      queue: "deferred",
      input: z.string(),
      throttling: { requirements: () => ({ admission: limit }) },
      handler,
    });
    const adapter = createAdapter();
    await adapter.enqueue([{ queue: worker.queue, payload: "payload" }]);
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        now: () => now,
        throttling,
        recordThrottlingDecision: ({ result }) => decisions.push(result),
      },
    );

    await scheduler.runOnce();

    expect(handler).not.toHaveBeenCalled();
    expect(adapter.inspectJobs()).toMatchObject([{
      attempt: 0,
      availableAt: new Date("2026-01-01T00:01:00.000Z"),
    }]);
    expect(decisions).toEqual(["deferred"]);
    await throttling.close();
  });

  it("does not occupy a handler slot while another job waits for admission", async () => {
    const rateAdapter = new MemoryRateLimitAdapter();
    const throttling = new ThrottlingManager(rateAdapter, {
      namespace: "workers",
    });
    const limit = defineRateLimit({
      id: "slow-api",
      requests: 1,
      per: minutes(60),
    });
    const occupied = await throttling.acquire(limit);
    await occupied.complete({ outcome: "success" });
    const order: string[] = [];
    const blocked = defineWorker({
      name: "blocked",
      queue: "blocked",
      input: z.string(),
      throttling: {
        requirements: () => ({ admission: limit }),
        buffering: {
          strategy: "hold",
          maxBlockedJobs: 1,
          maxHoldMs: 30,
          fallbackDelayMs: 100,
        },
      },
      handler: () => {
        order.push("blocked-handler");
      },
    });
    const free = defineWorker({
      name: "free",
      queue: "free",
      input: z.string(),
      handler: () => {
        order.push("free-handler");
      },
    });
    const adapter = createAdapter();
    await adapter.enqueue([
      { queue: blocked.queue, payload: "blocked-1" },
      { queue: blocked.queue, payload: "blocked-2" },
      { queue: free.queue, payload: "free" },
    ]);
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [blocked, free],
      {
        slots: 1,
        leaseMs: 1_000,
        reservationLimit: 3,
        throttling,
        recordThrottlingDecision: ({ result }) => order.push(result),
      },
    );

    await scheduler.runOnce();

    expect(order).toContain("held");
    expect(order).not.toContain("blocked-handler");
    expect(order.indexOf("free-handler")).toBeLessThan(
      order.lastIndexOf("deferred"),
    );
    expect(order.filter((item) => item === "held")).toHaveLength(1);
    expect(order.filter((item) => item === "deferred")).toHaveLength(2);
    expect(adapter.inspectJobs()).toMatchObject([
      { attempt: 0 },
      { attempt: 0 },
    ]);
    await throttling.close();
  });

  it.each(["defer", "release"] as const)("batches rejected individual jobs using %s without counting attempts", async (strategy) => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const rateAdapter = new MemoryRateLimitAdapter({ now: () => now });
    const throttling = new ThrottlingManager(rateAdapter, {
      namespace: "workers",
      now: () => now,
    });
    const limit = defineRateLimit({
      id: "release-api",
      requests: 1,
      per: seconds(10),
    });
    const occupied = await throttling.acquire(limit);
    await occupied.complete({ outcome: "success" });
    const worker = defineWorker({
      name: "released",
      queue: "released",
      input: z.string(),
      throttling: {
        requirements: () => ({ admission: limit }),
        buffering: { strategy },
      },
      handler: vi.fn(),
    });
    const adapter = createAdapter();
    await adapter.enqueue(Array.from({ length: 50 }, () => ({
      queue: worker.queue,
      payload: "payload",
    })));
    const defer = vi.spyOn(adapter, "defer");
    const decisions: string[] = [];
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        reservationLimit: 50,
        // The cycle boundary drains small batches without waiting this long.
        deferFlushIntervalMs: 5_000,
        leaseMs: 1_000,
        now: () => now,
        throttling,
        recordThrottlingDecision: ({ result }) => decisions.push(result),
      },
    );

    await scheduler.runOnce();

    expect(defer).toHaveBeenCalledOnce();
    expect(defer.mock.calls[0]![0]).toHaveLength(50);
    expect(adapter.inspectJobs()).toMatchObject(Array.from({ length: 50 }, () => ({
      attempt: 0,
      availableAt: strategy === "release" ? now : new Date(now.getTime() + 10_000),
    })));
    expect(decisions).toEqual(Array.from({ length: 50 }, () =>
      strategy === "release" ? "released" : "deferred"));
    expect(worker.handler).not.toHaveBeenCalled();
    await throttling.close();
  });

  it("keeps failed deferrals leased without turning them into handler failures", async () => {
    const app = await createStartedApp();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const throttling = new ThrottlingManager(new MemoryRateLimitAdapter({ now: () => now }), {
      namespace: "workers",
      now: () => now,
    });
    try {
      const limit = defineRateLimit({ id: "unavailable", requests: 1, per: seconds(10) });
      const occupied = await throttling.acquire(limit);
      await occupied.complete({ outcome: "success" });
      const worker = defineWorker({
        name: "failed-deferral",
        queue: "failed-deferral",
        input: z.string(),
        throttling: { requirements: () => ({ admission: limit }) },
        handler: vi.fn(),
      });
      const adapter = createAdapter();
      await adapter.enqueue([{ queue: worker.queue, payload: "payload" }]);
      const failure = new Error("deferral store unavailable");
      vi.spyOn(adapter, "defer").mockRejectedValue(failure);
      const retry = vi.spyOn(adapter, "retry");
      const deadLetter = vi.spyOn(adapter, "deadLetter");
      const decisions = vi.fn();
      const scheduler = new WorkerScheduler(app, adapter, [worker], {
        slots: 1,
        leaseMs: 1_000,
        throttling,
        recordThrottlingDecision: decisions,
      });
      await expect(scheduler.runOnce()).rejects.toBe(failure);
      expect(retry).not.toHaveBeenCalled();
      expect(deadLetter).not.toHaveBeenCalled();
      expect(decisions).not.toHaveBeenCalled();
      expect(worker.handler).not.toHaveBeenCalled();
      expect(adapter.inspectJobs()).toMatchObject([{
        attempt: 1,
        reservationToken: "token-1",
      }]);
    } finally {
      await throttling.close();
      await app.stop();
    }
  });

  it("maintains peer leases until result persistence settles after a deferral failure", async () => {
    vi.useFakeTimers();
    const app = await createStartedApp();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const throttling = new ThrottlingManager(new MemoryRateLimitAdapter({ now: () => now }), {
      namespace: "workers",
      now: () => now,
    });
    const handoffStarted = Promise.withResolvers<void>();
    const finishHandoff = Promise.withResolvers<void>();
    let cycle: Promise<unknown> | undefined;
    try {
      const limit = defineRateLimit({ id: "peer-limit", requests: 1, per: seconds(10) });
      const occupied = await throttling.acquire(limit);
      await occupied.complete({ outcome: "success" });
      const blocked = defineWorker({
        name: "blocked-peer",
        queue: "blocked-peer",
        input: z.string(),
        throttling: { requirements: () => ({ admission: limit }) },
        handler: () => undefined,
      });
      const successful = defineWorker({
        name: "successful-peer",
        queue: "successful-peer",
        input: z.string(),
        handler: () => undefined,
      });
      const adapter = createAdapter();
      await adapter.enqueue([
        { queue: blocked.queue, payload: "blocked" },
        {
          queue: successful.queue,
          payload: "success",
          correlation: { namespace: "workflow.activity", id: "execution/1" },
        },
      ]);
      const failure = new Error("deferral unavailable");
      vi.spyOn(adapter, "defer").mockRejectedValue(failure);
      const extend = vi.spyOn(adapter, "extendLease");
      const scheduler = new WorkerScheduler(app, adapter, [blocked, successful], {
        slots: 2,
        leaseMs: 1_000,
        throttling,
        completeCorrelatedJob: async () => {
          handoffStarted.resolve();
          await finishHandoff.promise;
        },
      });
      let settled = false;
      cycle = scheduler.runOnce().catch((error: unknown) => error).finally(() => {
        settled = true;
      });
      await handoffStarted.promise;
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe(false);
      expect(extend).toHaveBeenCalledOnce();
      expect(extend.mock.calls[0]![0]).toHaveLength(2);
      finishHandoff.resolve();
      expect(await cycle).toBe(failure);
      expect(adapter.inspectJobs()).toMatchObject([{ queue: blocked.queue }]);
    } finally {
      finishHandoff.resolve();
      await cycle;
      await throttling.close();
      await app.stop();
      vi.useRealTimers();
    }
  });

  it("feeds worker failure classification into later circuit admission", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const policy = defineAdmissionPolicy({
      id: "worker-partner-health",
      limits: [circuitBreaker({
        id: "worker-partner-circuit",
        failureThreshold: 1,
        cooldown: seconds(10),
      })],
    });
    const handler = vi.fn((_job, _dependencies, { reportFeedback }) => {
      reportFeedback({ kind: "timeout" });
      throw new Error("partner timeout");
    });
    const worker = defineWorker({
      name: "circuit-worker",
      queue: "circuit-worker",
      input: z.string(),
      maxAttempts: 1,
      throttling: { requirements: () => ({ admission: policy }) },
      handler,
    });
    const adapter = createAdapter();
    const throttling = new ThrottlingManager(new MemoryRateLimitAdapter(), {
      namespace: "workers",
      now: () => now,
    });
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        now: () => now,
        throttling,
      },
    );
    await adapter.enqueue([{ queue: worker.queue, payload: "first" }]);

    await scheduler.runOnce();
    await adapter.enqueue([{ queue: worker.queue, payload: "second" }]);
    await scheduler.runOnce();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(adapter.inspectDeadLetters()).toHaveLength(1);
    expect(adapter.inspectJobs()).toMatchObject([{
      attempt: 0,
      availableAt: new Date("2026-01-01T00:00:10.000Z"),
    }]);
    await throttling.close();
  });

  it("fails a batch before invocation when jobs declare different policies", async () => {
    const first = defineRateLimit({
      id: "first-api",
      requests: 10,
      per: minutes(1),
    });
    const second = defineRateLimit({
      id: "second-api",
      requests: 10,
      per: minutes(1),
    });
    const handler = vi.fn();
    const worker = defineWorker({
      name: "inconsistent-batch",
      queue: "inconsistent-batch",
      input: z.enum(["first", "second"]),
      maxAttempts: 1,
      batch: { size: 2 },
      throttling: {
        requirements: (job) => ({
          admission: job.payload === "first" ? first : second,
        }),
      },
      handler,
    });
    const adapter = createAdapter();
    await adapter.enqueue([
      { queue: worker.queue, payload: "first" },
      { queue: worker.queue, payload: "second" },
    ]);
    const throttling = new ThrottlingManager(new MemoryRateLimitAdapter(), {
      namespace: "workers",
    });
    const scheduler = new WorkerScheduler(
      await createStartedApp(),
      adapter,
      [worker],
      {
        slots: 1,
        leaseMs: 1_000,
        throttling,
      },
    );

    await scheduler.runOnce();

    expect(handler).not.toHaveBeenCalled();
    expect(adapter.inspectDeadLetters()).toHaveLength(2);
    expect(adapter.inspectDeadLetters()[0]?.error.message)
      .toContain("must use the same admission policy");
    await throttling.close();
  });
});
