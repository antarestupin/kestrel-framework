import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import {
  App,
  executionContextDependency,
} from "../app/index.js";
import {
  MemoryWorkerAdapter,
  WorkerClient,
  WorkerScheduler,
  type WorkerCorrelatedCompletion,
} from "../workers/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import {
  createWorkflowActivityWorker,
  WorkflowActivityOutboxDispatcher,
  WorkflowWorkerCompletionSink,
  workflowActivityCorrelationNamespace,
} from "./worker_activity_transport.js";
import { EmbeddedWorkflowActivityTransport, getWorkflowActivityExecutionContext } from "./activity_transport.js";
import { WorkflowClient } from "./client.js";
import { WorkflowScheduler } from "./scheduler.js";
import { defineWorkflow } from "./workflow.js";
import { WorkflowActivityInfrastructureError } from "./errors.js";

describe("Worker-backed workflow activities", () => {
  it.each(["schedule-to-close", "before-deadline", "without-deadline", "retry-limit"] as const)("preserves %s behavior through Worker delivery", async (scenario) => {
    let now = 5_000;
    const invoke = vi.fn(() => {
      if (scenario === "before-deadline" || scenario === "without-deadline") return null;
      throw new WorkflowActivityInfrastructureError("transient transport failure");
    });
    const action = defineAction({ name: "worker.deadline", input: z.null(), handler: invoke });
    const app = new App({}, { catalog: { actions: { action } } });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    onTestFinished(async () => { clock.mockRestore(); await app.dispose(); });
    await app.start();
    const workers = new MemoryWorkerAdapter({ now: () => new Date(now) });
    const worker = createWorkflowActivityWorker(app);
    const complete = vi.fn(async () => undefined);
    const scheduler = new WorkerScheduler(app, workers, [worker], {
      slots: 1, leaseMs: 1_000, now: () => new Date(now), completeCorrelatedJob: complete,
    });
    const options = scenario === "retry-limit"
      ? { maxAttempts: 4, initialDelayMs: 20, backoffCoefficient: 3, maxDelayMs: 35 }
      : scenario === "without-deadline" ? {} : { scheduleToCloseTimeoutMs: 50 };
    const job = await new WorkerClient(workers).enqueue(worker, {
      taskId: "outbox-row", executionId: "workflow", sequence: 0, target: action.name,
      payload: { input: null, options }, scheduledAtMs: now - (scenario === "before-deadline" ? 49 : 50),
    }, { correlation: { namespace: workflowActivityCorrelationNamespace, id: "workflow:0", data: { executionId: "workflow", sequence: 0 } } });

    if (scenario === "retry-limit") {
      for (const delay of [20, 35, 35]) {
        await expect(scheduler.runOnce()).resolves.toBe(1);
        expect(complete).not.toHaveBeenCalled();
        expect(workers.inspectJobs()).toMatchObject([{
          id: job, availableAt: new Date(now + delay),
          lastError: { name: "WorkerRetryError", message: "Workflow activity workflow:0 failed." },
        }]);
        now += delay;
      }
    }
    await expect(scheduler.runOnce()).resolves.toBe(1);
    const succeeds = scenario === "before-deadline" || scenario === "without-deadline";
    expect(invoke).toHaveBeenCalledTimes(scenario === "schedule-to-close" ? 0 : succeeds ? 1 : 4);
    const result = succeeds
      ? { type: "workflow.activity.result", status: "completed", dispatchId: "outbox-row", result: null }
      : { type: "workflow.activity.result", status: "failed", dispatchId: "outbox-row", error: expect.objectContaining({
          name: scenario === "schedule-to-close" ? "WorkflowActivityTimeoutError" : "WorkflowActivityInfrastructureError",
          ...(scenario === "schedule-to-close" ? { details: { timeoutKind: "schedule-to-close", executionId: "workflow", sequence: 0 } } : {}),
        }) };
    expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId: job, status: "completed", result }));
    expect(workers.inspectJobs()).toHaveLength(0);
  });

  it.each([false, true])("settles every publication before releasing its owner, including second failure=%s", async (secondFails) => {
    const workflows = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const now = new Date(100);
    const dispatch = {
      id: "first", executionId: "execution", sequence: 0, target: "example.activity", payload: null,
      attempt: 1, availableAt: now, reservedAt: now, reservationToken: "first-token", createdAt: now,
    };
    vi.spyOn(workflows, "reserveActivityDispatches").mockResolvedValue([
      dispatch, { ...dispatch, id: "second", sequence: 1, reservationToken: "second-token" },
    ]);
    const retry = vi.spyOn(workflows, "retryActivityDispatches");
    const mark = vi.spyOn(workflows, "markActivityDispatchesPublished").mockImplementation(async (requests) => requests);
    const client = new WorkerClient(new MemoryWorkerAdapter());
    const publication = Promise.withResolvers<string>();
    const failure = new Error("queue rejected publication");
    const secondFailure = new Error("queue rejected the second publication");
    vi.spyOn(client, "enqueue").mockRejectedValueOnce(failure).mockReturnValueOnce(publication.promise);
    const dispatcher = new WorkflowActivityOutboxDispatcher(workflows, client, createWorkflowActivityWorker(new App({})), { retryDelayMs: 42 });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const result = vi.fn();
    const cycle = dispatcher.runOnce().then(result, result);
    try {
      await setImmediate();
      expect(retry).toHaveBeenCalledWith([{
        dispatchId: "first", reservationToken: "first-token", retryAt: new Date(1_042),
      }]);
      expect(result).not.toHaveBeenCalled();
    } finally {
      if (secondFails) publication.reject(secondFailure);
      else publication.resolve("second-job");
      await cycle;
      clock.mockRestore();
    }
    if (secondFails) {
      expect(mark).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledTimes(2);
      expect(result).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "AggregateError", errors: [
        expect.objectContaining({ cause: failure }), expect.objectContaining({ cause: secondFailure }),
      ], message: "Workflow activity publication batch failed." }));
    } else {
      expect(mark).toHaveBeenCalledExactlyOnceWith([{ dispatchId: "second", reservationToken: "second-token" }]);
      expect(result).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        cause: failure, message: "Could not publish workflow activity execution:0.",
      }));
    }
  });

  it("preserves the queue failure when rescheduling its outbox row fails too", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const now = new Date(1_000);
    const publishError = new Error("Worker queue unavailable");
    const retryError = new Error("Outbox store unavailable");
    vi.spyOn(adapter, "reserveActivityDispatches").mockResolvedValueOnce([{
      id: "outbox", executionId: "run", sequence: 0, target: "activity", payload: null,
      attempt: 1, availableAt: now, reservedAt: now, reservationToken: "owned", createdAt: now,
    }]);
    const retry = vi.spyOn(adapter, "retryActivityDispatches").mockRejectedValueOnce(retryError);
    const client = new WorkerClient(new MemoryWorkerAdapter());
    vi.spyOn(client, "enqueue").mockRejectedValueOnce(publishError);
    const dispatcher = new WorkflowActivityOutboxDispatcher(adapter, client, createWorkflowActivityWorker(new App({})));

    await expect(dispatcher.runOnce()).rejects.toMatchObject({
      name: "AggregateError", message: "Could not publish or reschedule workflow activity run:0.",
      errors: [publishError, retryError],
    });
    expect(retry).toHaveBeenCalledExactlyOnceWith([{
      dispatchId: "outbox", reservationToken: "owned", retryAt: expect.any(Date),
    }]);
  });

  it("reports a stale outbox mark even if the Worker queue accepted the job", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const now = new Date(1_000);
    vi.spyOn(adapter, "reserveActivityDispatches").mockResolvedValue([{
      id: "outbox", executionId: "run", sequence: 0, target: "activity", payload: null,
      attempt: 1, availableAt: now, reservedAt: now, reservationToken: "stale-token", createdAt: now,
    }]);
    const mark = vi.spyOn(adapter, "markActivityDispatchesPublished");
    const retry = vi.spyOn(adapter, "retryActivityDispatches");
    const workers = new MemoryWorkerAdapter();
    const dispatcher = new WorkflowActivityOutboxDispatcher(adapter, new WorkerClient(workers), createWorkflowActivityWorker(new App({})));

    await expect(dispatcher.runOnce()).rejects.toMatchObject({ cause: expect.objectContaining({ message: "The workflow activity outbox lease is stale." }) });
    expect(workers.inspectJobs()).toHaveLength(1);
    expect(mark).toHaveBeenCalledExactlyOnceWith([{ dispatchId: "outbox", reservationToken: "stale-token" }]);
    expect(retry).toHaveBeenCalledExactlyOnceWith([{ dispatchId: "outbox", reservationToken: "stale-token", retryAt: expect.any(Date) }]);
  });

  it("keeps replay generations distinct when publishing the same command sequence", async () => {
    const workflows = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const createdAt = new Date(123);
    const dispatch = {
      id: "dispatch-first",
      executionId: "same-execution",
      sequence: 0,
      target: "example.activity",
      payload: null,
      attempt: 1,
      availableAt: createdAt,
      reservedAt: createdAt,
      reservationToken: "reserved-first",
      createdAt,
      historyGeneration: 1,
    };
    const reserve = vi.spyOn(workflows, "reserveActivityDispatches")
      .mockResolvedValueOnce([dispatch])
      .mockResolvedValueOnce([{ ...dispatch, id: "dispatch-next", historyGeneration: 2 }]);
    const mark = vi.spyOn(workflows, "markActivityDispatchesPublished").mockImplementation(async (reservations) => reservations);
    const workers = new MemoryWorkerAdapter();
    const worker = createWorkflowActivityWorker(new App({}));
    const dispatcher = new WorkflowActivityOutboxDispatcher(workflows, new WorkerClient(workers), worker);

    await expect(dispatcher.runOnce()).resolves.toBe(1);
    await expect(dispatcher.runOnce()).resolves.toBe(1);
    expect(reserve).toHaveBeenCalledWith({ limit: 25, leaseMs: 30_000 });
    expect(mark).toHaveBeenCalledTimes(2);
    const [first, next] = workers.inspectJobs();
    expect(first?.identity).toBe("same-execution:0");
    expect(first?.correlation?.data).toStrictEqual({ executionId: "same-execution", sequence: 0 });
    expect(first?.payload).not.toHaveProperty("historyGeneration");
    expect(next?.identity).not.toBe(first?.identity);
    expect(next?.correlation?.id).toBe(next?.identity);
    expect(next?.correlation?.data).toEqual({ executionId: "same-execution", sequence: 0, historyGeneration: 2 });
    expect(next?.payload).toHaveProperty("historyGeneration", 2);
  });

  it("omits the generation for a legacy dispatch that has no generation metadata", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const now = new Date(0);
    vi.spyOn(adapter, "reserveActivityDispatches").mockResolvedValue([{
      id: "legacy", executionId: "legacy-run", sequence: 0, target: "example.activity", payload: null,
      attempt: 1, availableAt: now, reservedAt: now, reservationToken: "lease", createdAt: now,
    }]);
    vi.spyOn(adapter, "markActivityDispatchesPublished").mockImplementation(async (requests) => requests);
    const app = new App({});
    const client = new WorkerClient(new MemoryWorkerAdapter());
    const enqueue = vi.spyOn(client, "enqueue");
    try {
      const dispatcher = new WorkflowActivityOutboxDispatcher(adapter, client, createWorkflowActivityWorker(app));
      await expect(dispatcher.runOnce()).resolves.toBe(1);
      const [_, payload, options] = enqueue.mock.calls[0]!;
      expect(payload).not.toHaveProperty("historyGeneration");
      expect(options?.correlation?.data).toStrictEqual({ executionId: "legacy-run", sequence: 0 });
    } finally { await app.dispose(); }
  });

  it("does not retain the process with a Worker activity deadline", async () => {
    const deadline = 12_345;
    const entered = Promise.withResolvers<void>();
    const output = Promise.withResolvers<null>();
    const action = defineAction({ name: "worker.unreferenced", output: z.null(), handler: () => {
      entered.resolve();
      return output.promise;
    } });
    const app = new App({}, { catalog: { actions: { action } } });
    try {
      await app.start();
      const workers = new MemoryWorkerAdapter();
      const worker = createWorkflowActivityWorker(app);
      const scheduler = new WorkerScheduler(app, workers, [worker], { slots: 1, leaseMs: 1_000 });
      await new WorkerClient(workers).enqueue(worker, {
        taskId: "row", executionId: "run", sequence: 0, target: action.name, scheduledAtMs: Date.now(),
        payload: { input: null, options: { startToCloseTimeoutMs: deadline } },
      });
      const timers = vi.spyOn(globalThis, "setTimeout");
      const cycle = scheduler.runOnce();
      try {
        await Promise.race([entered.promise, cycle]);
        const index = timers.mock.calls.findIndex(([, delay]) => delay === deadline);
        expect(timers.mock.results[index]?.value.hasRef()).toBe(false);
      } finally {
        output.resolve(null);
        try { await cycle; } finally { timers.mockRestore(); }
      }
    } finally { await app.dispose(); }
  });

  it("routes both Worker failures and activity outcomes using the original generation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const complete = vi.spyOn(adapter, "completeExternalActivity").mockResolvedValue(true);
    const sink = new WorkflowWorkerCompletionSink(adapter);
    const job = {
      jobId: "original-job",
      correlation: {
        namespace: workflowActivityCorrelationNamespace,
        id: "activity-generation-2",
        data: { executionId: "original-execution", sequence: 0, historyGeneration: 2 },
      },
    };
    const error = { name: "ActivityError", message: "failed", stack: "error stack" };
    const failed: WorkerCorrelatedCompletion = { ...job, status: "failed", error };
    const businessFailure: WorkerCorrelatedCompletion = {
      ...job, status: "completed", result: {
        type: "workflow.activity.result", status: "failed", error,
        executionId: "other-execution", sequence: 5, historyGeneration: 3, sourceId: "other-job",
      },
    };
    const expected = { executionId: "original-execution", sequence: 0, historyGeneration: 2, sourceId: "original-job", status: "failed", error };
    await sink.complete(failed);
    await sink.complete(businessFailure);
    expect(complete.mock.calls).toEqual([[expected], [expected]]);
    complete.mockResolvedValueOnce(false);
    await expect(sink.complete(failed)).rejects.toThrow("original-execution:0 was rejected");
  });

  it("rejects invalid Worker payloads before they reach the Action handler", async () => {
    const worker = createWorkflowActivityWorker(new App({}));
    const valid = { taskId: "job", executionId: "run", sequence: 0, target: "action", payload: null, scheduledAtMs: 5 };
    expect((await worker.inputSchema.safeParseAsync(valid)).success).toBe(true);
    for (const invalid of [null, "invalid", { ...valid, taskId: 3 }, { ...valid, executionId: 3 },
      { ...valid, sequence: 0.5 }, { ...valid, historyGeneration: 0 }, { ...valid, target: 3 },
      { ...valid, scheduledAtMs: "5" }, { ...valid, historyGeneration: "2" }, { ...valid, payload: undefined },
    ]) {
      // JSON publication removes absent properties before the Worker receives the payload.
      expect((await worker.inputSchema.safeParseAsync(JSON.parse(JSON.stringify(invalid)))).success).toBe(false);
    }
  });

  it.each([undefined, null, 17, { type: "workflow.activity.result", status: "failed", error: null },
    { type: "workflow.activity.result", status: "failed", error: "invalid" },
    { type: "workflow.activity.result", status: "failed", error: { message: "missing name" } },
    { type: "workflow.activity.result", status: "failed", error: { name: "Error" } },
    { type: "workflow.activity.result", status: "failed", error: { name: "Error", message: "invalid", stack: 3 } },
    { type: "workflow.activity.result", status: "queued", error: { name: "Error", message: "invalid" } },
    { type: "ordinary.worker.result", status: "completed", result: "not an activity result" },
  ])("records a durable failure for a malformed Worker result %j", async (result) => {
    const adapter = new MemoryWorkflowAdapter();
    const complete = vi.spyOn(adapter, "completeExternalActivity").mockResolvedValue(true);
    const sink = new WorkflowWorkerCompletionSink(adapter);
    await sink.complete({
      jobId: "job", status: "completed", result,
      correlation: { namespace: workflowActivityCorrelationNamespace, id: "run:0", data: { executionId: "run", sequence: 0 } },
    });
    expect(complete).toHaveBeenCalledExactlyOnceWith({ executionId: "run", sequence: 0, sourceId: "job", status: "failed", error: {
      name: "WorkflowActivityResultError", message: "The workflow activity Worker returned an invalid result.",
    } });
  });

  it("rejects unsupported or invalid correlation without writing a completion", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const complete = vi.spyOn(adapter, "completeExternalActivity");
    const sink = new WorkflowWorkerCompletionSink(adapter);
    const data = { executionId: "run", sequence: 0 };
    const job = { jobId: "job", status: "completed" as const, result: { type: "workflow.activity.result", status: "completed" } };
    await expect(sink.complete({ ...job, correlation: { namespace: "another.namespace", id: "run:0", data } }))
      .rejects.toThrow("Unsupported Worker correlation namespace");
    for (const invalid of [null, "invalid", { ...data, historyGeneration: 0 }, { ...data, historyGeneration: 1.5 },
      { ...data, historyGeneration: "2" }, { ...data, executionId: 8 }, { ...data, sequence: 1.5 }]) {
      await expect(sink.complete({ ...job, correlation: { namespace: workflowActivityCorrelationNamespace, id: "run:0", data: invalid } }))
        .rejects.toThrow(new TypeError(typeof invalid === "object" && invalid !== null
          ? "Workflow activity correlation data is invalid."
          : "Workflow activity correlation data is missing."));
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses a durable completion generation and ignores an obsolete dispatch id", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const complete = vi.spyOn(adapter, "completeExternalActivity").mockResolvedValue(true);
    const sink = new WorkflowWorkerCompletionSink(adapter);
    await sink.complete({
      jobId: "job", status: "completed",
      result: { type: "workflow.activity.result", status: "completed", dispatchId: "obsolete-row" },
      correlation: { namespace: workflowActivityCorrelationNamespace, id: "run:0:generation-2",
        data: { executionId: "run", sequence: 0, historyGeneration: 2 } },
    });
    expect(complete.mock.calls).toStrictEqual([[{
      executionId: "run", sequence: 0, historyGeneration: 2, sourceId: "job", status: "completed",
    }]]);
  });

  it("passes the original dispatch id when a queued Worker job has unversioned correlation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const complete = vi.spyOn(adapter, "completeExternalActivity").mockResolvedValue(true);
    const sink = new WorkflowWorkerCompletionSink(adapter);
    await sink.complete({
      jobId: "legacy-job", status: "completed",
      result: { type: "workflow.activity.result", status: "completed", result: 6, dispatchId: "original-dispatch" },
      correlation: { namespace: workflowActivityCorrelationNamespace, id: "run:0", data: { executionId: "run", sequence: 0 } },
    });
    expect(complete.mock.calls).toStrictEqual([[{
      executionId: "run", sequence: 0, sourceId: "legacy-job", dispatchId: "original-dispatch", status: "completed", result: 6,
    }]]);
  });

  it("records Worker and activity failures without manufacturing a missing stack", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const complete = vi.spyOn(adapter, "completeExternalActivity").mockResolvedValue(true);
    const sink = new WorkflowWorkerCompletionSink(adapter);
    const job = { jobId: "job", correlation: { namespace: workflowActivityCorrelationNamespace, id: "run:0",
      data: { executionId: "run", sequence: 0 } } };
    const error = { name: "ActivityError", message: "Recorded failure" };
    await sink.complete({ ...job, status: "failed", error });
    await sink.complete({ ...job, status: "completed", result: { type: "workflow.activity.result", status: "failed", error } });
    const expected = { executionId: "run", sequence: 0, sourceId: "job", status: "failed", error };
    expect(complete.mock.calls).toStrictEqual([[expected], [expected]]);
  });

  it.each(["default", "custom"] as const)("executes one Worker activity in each generation with the %s codec", async (mode) => {
    const invocations: Array<{ key: string; generation: number | undefined }> = [];
    const action = defineAction({ name: "generation.activity", input: z.number(), output: z.number(),
      dependencies: { executionContext: executionContextDependency },
      handler: (input, { executionContext }) => {
        const activity = getWorkflowActivityExecutionContext(executionContext)!;
        invocations.push({ key: activity.idempotencyKey, generation: activity.historyGeneration });
        return input * 2;
      },
    });
    const workflow = defineWorkflow({ name: "generation.outbox", input: z.number(), output: z.number(),
      handler: async (input, context) => {
        const result = await context.run(action, input);
        if (context.generation === 1) await context.continueAsNew(input + 1);
        return result;
      },
    });
    const app = new App({}, { catalog: { actions: { action } } });
    const codec = mode === "default" ? undefined : {
      encode: (value: unknown) => JSON.stringify(value) ?? "null",
      decode: (value: unknown): unknown => JSON.parse(String(value)),
    };
    onTestFinished(() => app.dispose());
    await app.start();
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const workers = new MemoryWorkerAdapter();
    const worker = createWorkflowActivityWorker(app, codec);
    const outbox = new WorkflowActivityOutboxDispatcher(adapter, new WorkerClient(workers), worker);
    const sink = new WorkflowWorkerCompletionSink(adapter);
    const complete = vi.fn((completion: WorkerCorrelatedCompletion) => sink.complete(completion));
    const workerScheduler = new WorkerScheduler(app, workers, [worker], {
      slots: 1, leaseMs: 1_000, completeCorrelatedJob: complete,
    });
    const codecOptions = codec === undefined ? {} : { payloadCodec: codec };
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      taskKinds: ["workflow", "timer"], ...codecOptions,
    });
    const handle = await new WorkflowClient(adapter, codecOptions).start(workflow, 2, { executionId: "continue-outbox" });

    await scheduler.runOnce();
    await expect(outbox.runOnce()).resolves.toBe(1);
    await workerScheduler.runOnce();
    await scheduler.runOnce();
    await expect(handle.status()).resolves.toMatchObject({ status: "queued", historyGeneration: 2 });
    await scheduler.runOnce();
    await expect(outbox.runOnce()).resolves.toBe(1);
    await workerScheduler.runOnce();
    await scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "completed", historyGeneration: 2 });
    await expect(handle.result()).resolves.toBe(6);
    expect(invocations).toEqual([{ key: "continue-outbox:0", generation: 1 }, { key: "continue-outbox:0:generation-2", generation: 2 }]);
    expect(complete).toHaveBeenCalledTimes(2);
    const second = complete.mock.calls[1]?.[0];
    expect(second).toMatchObject({ status: "completed", result: { type: "workflow.activity.result", status: "completed" } });
    expect(second?.status === "completed" && second.result).not.toHaveProperty("dispatchId");
  });

  it("publishes an outbox command and records its correlated Action result", async () => {
    const activityKeys: string[] = [];
    const double = defineAction({
      name: "numbers.double",
      input: z.number(),
      output: z.number(),
      dependencies: { executionContext: executionContextDependency },
      handler: (value, { executionContext }) => {
        activityKeys.push(
          getWorkflowActivityExecutionContext(executionContext)!.idempotencyKey,
        );
        return value * 2;
      },
    });
    const app = new App({}, {
      catalog: { actions: { double } },
    });
    onTestFinished(() => app.dispose());
    await app.start();
    let workflowId = 0;
    const workflows = new MemoryWorkflowAdapter({
      activityDispatchMode: "outbox",
      createTaskId: () => `workflow-task-${++workflowId}`,
      createReservationToken: () => `workflow-token-${workflowId}`,
    });
    let workerId = 0;
    const workers = new MemoryWorkerAdapter({
      createId: () => `worker-job-${++workerId}`,
      createReservationToken: () => `worker-token-${workerId}`,
    });
    const activityWorker = createWorkflowActivityWorker(app);
    const client = new WorkerClient(workers);
    const dispatcher = new WorkflowActivityOutboxDispatcher(
      workflows,
      client,
      activityWorker,
    );
    const sink = new WorkflowWorkerCompletionSink(workflows);
    const scheduler = new WorkerScheduler(
      app,
      workers,
      [activityWorker],
      {
        slots: 2,
        leaseMs: 1_000,
        completeCorrelatedJob: (completion) => sink.complete(completion),
      },
    );

    await workflows.start({
      executionId: "execution-1",
      workflowName: "test.workflow",
      workflowVersion: 1,
      input: null,
    });
    const [activation] = await workflows.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 1_000,
    });
    expect(activation).toBeDefined();
    await workflows.commitActivation({
      taskId: activation!.id,
      reservationToken: activation!.reservationToken,
      executionId: "execution-1",
      expectedRevision: 0,
      commands: [{
        sequence: 0,
        kind: "activity",
        target: double.name,
        payload: {
          input: 2,
          options: {
            maxAttempts: 2,
            initialDelayMs: 1,
            backoffCoefficient: 2,
          },
        },
      }],
      outcome: { status: "waiting" },
    });

    await expect(dispatcher.runOnce()).resolves.toBe(1);
    expect(workers.inspectJobs()).toMatchObject([{
      identity: "execution-1:0",
      correlation: {
        namespace: "workflow.activity",
        data: { executionId: "execution-1", sequence: 0 },
      },
    }]);
    const publishedJob = workers.inspectJobs()[0]!;
    // Simulate a queue such as SQS delivering the same logical message twice.
    await workers.enqueue([{
      queue: publishedJob.queue,
      payload: publishedJob.payload,
      ...(publishedJob.correlation === undefined
        ? {}
        : { correlation: publishedJob.correlation }),
    }]);
    await scheduler.runOnce();

    const history = await workflows.getHistory("execution-1");
    expect(history.filter((event) => event.type === "command-completed"))
      .toMatchObject([{ sequence: 0, result: 4 }]);
    expect(workers.inspectJobs()).toHaveLength(0);
    expect(activityKeys).toEqual(["execution-1:0", "execution-1:0"]);
    expect((await workflows.getHistory("execution-1")).filter(
      (event) => event.type === "command-completed",
    )).toHaveLength(1);
  });
});
