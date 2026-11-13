import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { EmbeddedWorkflowActivityTransport, type WorkflowActivityHandler } from "./activity_transport.js";
import type {
  CommitWorkflowActivationRequest,
  ReservedWorkflowTask,
  WorkflowTaskReservationRef,
} from "./adapter.js";
import { WorkflowClient } from "./client.js";
import { WorkflowScheduler, type WorkflowSchedulerOptions } from "./scheduler.js";
import { defineWorkflow } from "./workflow.js";
import { WorkflowActivityInfrastructureError, WorkflowInvalidSuspensionError } from "./errors.js";
import { WorkflowReplayer } from "./replayer.js";

describe("WorkflowScheduler", () => {
  it.each<[keyof WorkflowSchedulerOptions, number]>([
    ["batchSize", 0], ["idlePollMs", 1.5], ["leaseMs", -1], ["maxHistoryEvents", 0],
    ["completionBatchSize", 0], ["completionFlushIntervalMs", 0],
  ])("rejects an invalid %s", (name, value) => {
    const create = () => new WorkflowScheduler([], new MemoryWorkflowAdapter(),
      new EmbeddedWorkflowActivityTransport(() => undefined), { [name]: value });
    const message = name === "completionBatchSize"
      ? "Batch buffer size must be a positive integer."
      : `Workflow scheduler ${name} must be a positive integer.`;
    expect(create).toThrow(new TypeError(message));
  });

  it("returns a task reserved while shutdown was beginning and prevents another reservation", async () => {
    const shutdown = new AbortController();
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "shutdown.admission", output: z.null(), handler: () => null });
    const scope = vi.fn();
    const reserve = adapter.reserveTasks.bind(adapter);
    const observed = vi.spyOn(adapter, "reserveTasks").mockImplementation(async (request) => {
      const reserved = await reserve(request);
      shutdown.abort();
      return reserved;
    });
    const release = vi.spyOn(adapter, "releaseTasks");
    const load = vi.spyOn(adapter, "loadActivations");
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      executionSignal: shutdown.signal, runInExecutionScope: scope,
    });
    const client = new WorkflowClient(adapter);
    await client.start(workflow, null);
    await client.start(workflow, null);

    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 2, stale: 2, completed: 0 });
    expect(scope).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith([
      { taskId: expect.any(String), reservationToken: expect.any(String) },
      { taskId: expect.any(String), reservationToken: expect.any(String) },
    ]);
    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 0, stale: 0, completed: 0 });
    expect(observed).toHaveBeenCalledOnce();
  });

  it("does not call the adapter release path for an empty reservation during shutdown", async () => {
    const shutdown = new AbortController();
    const adapter = new MemoryWorkflowAdapter();
    vi.spyOn(adapter, "reserveTasks").mockImplementationOnce(async () => {
      shutdown.abort();
      return [];
    });
    const release = vi.spyOn(adapter, "releaseTasks");
    const scheduler = new WorkflowScheduler([], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      executionSignal: shutdown.signal,
    });
    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 0, completed: 0, stale: 0 });
    expect(release).not.toHaveBeenCalled();
  });

  it("retries an adapter-classified transient polling error", async () => {
    vi.useFakeTimers();
    const adapter = new MemoryWorkflowAdapter();
    const failure = new Error("Reservation temporarily unavailable");
    const classify = vi.fn((error: unknown) => error === failure);
    Object.assign(adapter, { isRecoverablePollingError: classify });
    const reserve = vi.spyOn(adapter, "reserveTasks").mockRejectedValueOnce(failure).mockResolvedValue([]);
    const stop = new AbortController();
    const scheduler = new WorkflowScheduler([], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      polling: { initialBackoffMs: 10, maxBackoffMs: 10 },
    });
    const poll = scheduler.polling.run.bind(scheduler.polling);
    let cycles = 0;
    vi.spyOn(scheduler.polling, "run").mockImplementation((signal, cycle, idleMs, report) =>
      poll(signal, () => {
        // A mistaken busy-poll callback must reach the assertion without spinning indefinitely.
        if (++cycles > 2) stop.abort();
        return cycle();
      }, idleMs, report));
    const run = scheduler.run(stop.signal);
    void run.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(classify).toHaveBeenCalledExactlyOnceWith(failure);
      expect(scheduler.polling.state.status).toBe("backoff");
      await vi.advanceTimersByTimeAsync(10);
      expect(reserve).toHaveBeenCalledTimes(2);
    } finally {
      stop.abort();
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("tells the polling supervisor to wait only after an empty reservation", async () => {
    const stop = new AbortController();
    const scheduler = new WorkflowScheduler([], new MemoryWorkflowAdapter(),
      new EmbeddedWorkflowActivityTransport(() => undefined), { idlePollMs: 25 });
    vi.spyOn(scheduler, "runOnce")
      .mockResolvedValueOnce({ reserved: 0, completed: 0, stale: 0 })
      .mockResolvedValueOnce({ reserved: 1, completed: 0, stale: 1 });
    const poll = vi.spyOn(scheduler.polling, "run").mockImplementation(async (signal, cycle, idleMs) => {
      expect(signal).toBe(stop.signal);
      expect(idleMs).toBe(25);
      // Reserved work keeps polling active even if its lease became stale before commit.
      await expect(cycle()).resolves.toBe(false);
      await expect(cycle()).resolves.toBe(true);
    });

    await scheduler.run(stop.signal);
    expect(poll).toHaveBeenCalledOnce();
  });

  it("captures the configured UUID source in workflow history", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "scheduler.uuid", output: z.string(), handler: (_input, context) => context.uuid() });
    const createUuid = vi.fn(() => "custom-durable-id");
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), { createUuid });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    await scheduler.runOnce();

    expect(await handle.status()).toMatchObject({ status: "completed", output: "custom-durable-id" });
    await expect(handle.result()).resolves.toBe("custom-durable-id");
    expect(createUuid).toHaveBeenCalledOnce();
  });

  it.each([49, 50])("checks the schedule-to-close boundary after %sms", async (elapsed) => {
    let now = 5_000;
    const adapter = new MemoryWorkflowAdapter({ now: () => new Date(now) });
    const action = defineAction({ name: "deadline.schedule", handler: () => null });
    const workflow = defineWorkflow({ name: "deadline.workflow", output: z.null(), handler: (_input, context) =>
      context.run(action, null, { scheduleToCloseTimeout: { milliseconds: 50 } }) });
    const handler = vi.fn(() => null);
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => handler), {
      now: () => now, completionBatchSize: 1,
    });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    now += elapsed;

    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
    expect(handler).toHaveBeenCalledTimes(elapsed < 50 ? 1 : 0);
    expect(await adapter.getHistory(handle.executionId)).toMatchObject([
      { type: "command-scheduled" },
      elapsed < 50
        ? { type: "command-completed", result: null }
        : { type: "command-completed", error: { name: "WorkflowActivityTimeoutError", message: expect.stringContaining("schedule-to-close") } },
    ]);
  });

  it("runs an activity without a schedule-to-close deadline even after a long wait", async () => {
    let now = 0;
    const adapter = new MemoryWorkflowAdapter({ now: () => new Date(now) });
    const action = defineAction({ name: "deadline.unbounded", output: z.null(), handler: () => null });
    const workflow = defineWorkflow({ name: "deadline.optional", output: z.null(), handler: (_input, context) => context.run(action, null) });
    const handler = vi.fn(() => null);
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => handler), {
      now: () => now, completionBatchSize: 1,
    });
    await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    now = 86_400_000;
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps the embedded activity deadline referenced while the handler owns the lease", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const action = defineAction({ name: "deadline.referenced", output: z.null(), handler: () => null });
    const deadline = 12_345;
    const workflow = defineWorkflow({ name: "deadline.embedded", output: z.null(), handler: (_input, context) =>
      context.run(action, null, { startToCloseTimeout: { milliseconds: deadline } }) });
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<null>();
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => () => {
      entered.resolve();
      return result.promise;
    }), { completionBatchSize: 1 });
    await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const cycle = scheduler.runOnce();
    try {
      // A malformed deadline must fail a bounded assertion, even if the handler never starts.
      await Promise.race([entered.promise, cycle]);
      const index = timers.mock.calls.findIndex(([, delay]) => delay === deadline);
      expect(timers.mock.results[index]?.value.hasRef()).toBe(true);
    } finally {
      result.resolve(null);
      try { await cycle; } finally { timers.mockRestore(); }
    }
  });

  it("caps infrastructure retry delays and keeps the final failure durable", async () => {
    let now = 5_000;
    const adapter = new MemoryWorkflowAdapter({ now: () => new Date(now) });
    const action = defineAction({ name: "deadline.retry", handler: () => null });
    const workflow = defineWorkflow({ name: "deadline.retry-workflow", output: z.null(), handler: (_input, context) =>
      context.run(action, null, { retry: {
        maxAttempts: 3, initialDelay: { milliseconds: 20 }, backoffCoefficient: 3, maxDelay: { milliseconds: 35 },
      } }) });
    const handler = vi.fn<WorkflowActivityHandler>(() => { throw new WorkflowActivityInfrastructureError("transport offline"); });
    const persistCompletion = vi.spyOn(adapter, "completeActivities");
    const record = vi.fn();
    const scope = vi.fn();
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => handler), {
      now: () => now, completionBatchSize: 1, instrumentation: { record },
      runInExecutionScope: (id, operation, run, task) => { scope(id, operation, run, task); return run(); },
    });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    for (const delay of [20, 35]) {
      await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
      now += delay - 1;
      await expect(scheduler.runOnce()).resolves.toMatchObject({ reserved: 0 });
      now++;
    }
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    expect(handler.mock.calls.map(([, attempt]) => attempt.attempt)).toEqual([1, 2, 3]);
    expect(persistCompletion).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
      executionId: handle.executionId, sequence: 0, status: "failed",
      error: expect.objectContaining({ message: "transport offline" }),
    })]);
    expect(scope.mock.calls.map(([, operation]) => operation)).toEqual([
      "workflow.activate", "workflow.activity", "workflow.activity", "workflow.activity",
    ]);
    expect(record.mock.calls.map(([event]) => event).filter((event) => event.data.retryDelayMs !== undefined)).toEqual(
      [20, 35].map((retryDelayMs, index) => ({
        type: "task", outcome: "success", durationMs: 0, data: {
          executionId: handle.executionId, workflowName: workflow.name, workflowVersion: 1, historyGeneration: 1,
          taskKind: "activity", result: "retried", attempt: index + 1, queueAgeMs: index === 0 ? 0 : 20,
          commandSequence: 0, target: action.name, retryDelayMs,
        },
      })),
    );
    expect(await adapter.getHistory(handle.executionId)).toMatchObject([
      { type: "command-scheduled" }, { type: "command-completed", error: { name: "WorkflowActivityInfrastructureError" } },
    ]);
  });

  it.each(["missing", "wrong-task", "wrong-token", "storage-error", "storage-error-and-scope",
    "storage-error-propagated", "owned"] as const)("checks a %s lease during execution-scope setup", async (ownership) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const adapter = new MemoryWorkflowAdapter();
    const action = defineAction({ name: "lease.protected", handler: () => null });
    const workflow = defineWorkflow({ name: "lease.workflow", output: z.null(), handler: (_input, context) => context.run(action, null) });
    const handler = vi.fn(() => null);
    const releaseScope = Promise.withResolvers<void>();
    const enteredScope = vi.fn();
    const storageError = new Error("Lease storage unavailable");
    const scopeError = new Error("Execution scope also failed");
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => handler), {
      leaseMs: 100,
      completionBatchSize: 1,
      async runInExecutionScope(_executionId, _operation, run, task) {
        if (task.kind === "activity") {
          enteredScope();
          await releaseScope.promise;
          if (ownership === "storage-error-and-scope") throw scopeError;
          if (ownership === "storage-error-propagated") throw storageError;
        }
        return run();
      },
    });
    const extend = vi.spyOn(adapter, "extendTaskLeases").mockImplementationOnce(async ([request]) => {
      if (ownership.startsWith("storage-error")) throw storageError;
      if (request === undefined || ownership === "missing") return [];
      return [{
        taskId: ownership === "wrong-task" ? "another-task" : request.taskId,
        reservationToken: ownership === "wrong-token" ? "another-token" : request.reservationToken,
      }];
    });
    const release = vi.spyOn(adapter, "releaseTasks");
    const finished = vi.fn();
    const failed = vi.fn();
    try {
      await new WorkflowClient(adapter).start(workflow, null);
      await scheduler.runOnce();
      void scheduler.runOnce().then(finished, failed);
      await vi.advanceTimersByTimeAsync(0);
      expect(enteredScope).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(50);
      expect(extend).toHaveBeenCalledOnce();
      releaseScope.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const owned = ownership === "owned";
      expect(handler).toHaveBeenCalledTimes(owned ? 1 : 0);
      if (ownership.startsWith("storage-error")) {
        expect(finished).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledExactlyOnceWith(ownership === "storage-error-and-scope"
          ? expect.objectContaining({ name: "AggregateError", message: "Workflow task and lease renewal failed.", errors: [scopeError, storageError] })
          : storageError);
      } else {
        expect(finished).toHaveBeenCalledExactlyOnceWith({ reserved: 1, completed: owned ? 1 : 0, stale: owned ? 0 : 1 });
        expect(failed).not.toHaveBeenCalled();
      }
      if (owned) expect(release).not.toHaveBeenCalled();
      else expect(release).toHaveBeenCalledExactlyOnceWith([{
        taskId: expect.any(String), reservationToken: expect.any(String),
      }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { releaseScope.resolve(); vi.useRealTimers(); }
  });

  it.each([false, true])("ignores an activity settlement after shutdown (failed=%s)", async (fails) => {
    const adapter = new MemoryWorkflowAdapter();
    const shutdown = new AbortController();
    const outcome = Promise.withResolvers<null>();
    const handler = vi.fn(() => outcome.promise);
    const action = defineAction({ name: "late.activity", handler: () => null });
    const workflow = defineWorkflow({ name: "late.workflow", handler: async (_input, context) => {
      await context.run(action, null);
    } });
    const complete = vi.spyOn(adapter, "completeActivities");
    const release = vi.spyOn(adapter, "releaseTasks");
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => handler), {
      executionSignal: shutdown.signal, completionBatchSize: 1,
    });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    const cycle = scheduler.runOnce();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(handler).toHaveBeenCalledOnce();
      shutdown.abort();
      if (fails) outcome.reject(new Error("Activity failed after shutdown"));
      else outcome.resolve(null);
      await expect(cycle).resolves.toEqual({ reserved: 1, completed: 0, stale: 1 });
      expect(complete).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(await adapter.getHistory(handle.executionId)).toHaveLength(1);
    } finally {
      outcome.resolve(null);
      await cycle.catch(() => undefined);
    }
  });

  it.each(["blocked", "failed", "waiting", "completed"] as const)("records the replay lifecycle result for %s", async (status) => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "replay.lifecycle", handler: () => undefined });
    const handle = await new WorkflowClient(adapter).start(workflow, null, { executionId: "lifecycle" });
    const replayer = new WorkflowReplayer();
    const error = new WorkflowInvalidSuspensionError("lifecycle");
    // A custom replay implementation may settle without asking the scheduler to construct a context.
    vi.spyOn(replayer, "replay").mockResolvedValue(
      status === "blocked" || status === "failed" ? { status, error, commands: [] }
        : status === "waiting" ? { status, commands: [] }
          : { status, output: undefined, commands: [] },
    );
    const record = vi.fn();
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      replayer, instrumentation: { record },
    });

    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
    await expect(handle.status()).resolves.toMatchObject({ status });
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenLastCalledWith({
      type: "lifecycle", outcome: status === "blocked" || status === "failed" ? "failure" : "success",
      data: {
        executionId: "lifecycle", workflowName: workflow.name, workflowVersion: 1, historyGeneration: 1,
        operation: status === "waiting" ? "wait" : status, status,
      },
    });
  });

  it("records the committed task even when the adapter no longer returns the execution", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "replay.missing", handler: () => undefined });
    await new WorkflowClient(adapter).start(workflow, null);
    vi.spyOn(adapter, "get").mockResolvedValue(undefined);
    const record = vi.fn();
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      instrumentation: { record },
    });

    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "task", outcome: "success" }));
  });


  it.each(["waiting", "completed"] as const)("handles pending cancellation when replay is %s without opening a context", async (status) => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "cancelled.replay", handler: () => undefined });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await adapter.requestCancellation(handle.executionId);
    const replayer = new WorkflowReplayer();
    vi.spyOn(replayer, "replay").mockResolvedValue(status === "completed"
      ? { status, commands: [], output: undefined }
      : { status, commands: [] });
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), { replayer });
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    await expect(handle.status()).resolves.toMatchObject({
      status: status === "completed" ? "cancelled" : "waiting", cancellationRequested: true,
    });
  });

  it("releases a timer when shutdown begins during scope setup", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const shutdown = new AbortController();
    const timer = createReservedTimer({});
    vi.spyOn(adapter, "reserveTasks").mockResolvedValueOnce([timer]);
    const release = vi.spyOn(adapter, "releaseTasks");
    const complete = vi.spyOn(adapter, "completeActivities");
    const record = vi.fn();
    const scheduler = new WorkflowScheduler([], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      executionSignal: shutdown.signal, completionBatchSize: 1, instrumentation: { record },
      runInExecutionScope: async (_id, _operation, run) => {
        shutdown.abort();
        return run();
      },
    });
    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 0, stale: 1 });
    expect(complete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith([{ taskId: timer.id, reservationToken: timer.reservationToken }]);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      type: "task", outcome: "success", data: expect.objectContaining({ result: "stale" }),
    }));
  });

  it("fails a continuation that tries to create an already completed explicit child", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const child = defineWorkflow({ name: "explicit.child", handler: () => undefined });
    const parent = defineWorkflow({
      name: "explicit.parent",
      handler: async (_input, context) => {
        await context.runChild(child, null, { executionId: "fixed-child" });
        if (context.generation === 1) return context.continueAsNew(null);
      },
    });
    const scheduler = new WorkflowScheduler([parent, child], adapter, new EmbeddedWorkflowActivityTransport(() => undefined));
    const handle = await new WorkflowClient(adapter).start(parent, null, { executionId: "parent" });
    for (let activation = 0; activation < 4; activation += 1) await scheduler.runOnce();

    await expect(adapter.get("fixed-child")).resolves.toMatchObject({ status: "completed" });
    await expect(handle.status()).resolves.toMatchObject({
      status: "failed", historyGeneration: 2, error: { name: "WorkflowExecutionConflictError" },
    });
    await expect(adapter.getHistory(handle.executionId)).resolves.toEqual([]);
  });

  it("blocks a missing deployment definition and reports the lifecycle result", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start({ executionId: "missing-definition", workflowName: "missing.workflow", workflowVersion: 1, input: null });
    const record = vi.fn();
    const scheduler = new WorkflowScheduler([], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), { instrumentation: { record } });
    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
    await expect(adapter.get("missing-definition")).resolves.toMatchObject({ status: "blocked", error: { message: expect.stringContaining("missing.workflow") } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "lifecycle", outcome: "failure",
      data: expect.objectContaining({ executionId: "missing-definition", operation: "blocked" }) }));
  });

  it("counts an omitted activation snapshot as stale without opening a scope", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "snapshot.stale", handler: () => undefined });
    await new WorkflowClient(adapter).start(workflow, null);
    const load = vi.spyOn(adapter, "loadActivations").mockResolvedValue([]);
    const release = vi.spyOn(adapter, "releaseTasks");
    const openScope = vi.fn();
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      runInExecutionScope: openScope,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 0, stale: 1 });
    expect(load).toHaveBeenCalledExactlyOnceWith([{ taskId: expect.any(String), reservationToken: expect.any(String) }]);
    expect(openScope).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it.each(["input", "output", "continued-input"] as const)("persists a %s validation failure as a terminal result", async (failure) => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "validation.workflow", input: z.string(), output: z.string(),
      handler: (_input, context) => {
        if (failure === "continued-input") return context.continueAsNew(false as never);
        return false as never;
      },
    });
    await adapter.start({ executionId: "invalid-validation", workflowName: workflow.name, workflowVersion: 1,
      input: failure === "input" ? false : "valid" });
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined));
    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
    await expect(adapter.get("invalid-validation")).resolves.toMatchObject({ status: "failed", error: { name: "ZodError" } });
    await expect(adapter.getHistoryArchives("invalid-validation")).resolves.toEqual([]);
  });

  it("releases all reservations if multiple execution scopes fail", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "batch.failure", handler: () => undefined });
    const client = new WorkflowClient(adapter);
    await client.start(workflow, null, { executionId: "first" });
    await client.start(workflow, null, { executionId: "second" });
    const failures = { first: new Error("first scope unavailable"), second: new Error("second scope unavailable") };
    const release = vi.spyOn(adapter, "releaseTasks");
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      runInExecutionScope: async (executionId) => { throw failures[executionId as keyof typeof failures]; },
    });
    await expect(scheduler.runOnce()).rejects.toMatchObject({
      name: "AggregateError", message: "Workflow reservation batch failed.", errors: expect.arrayContaining(Object.values(failures)),
    });
    expect(release).toHaveBeenCalledTimes(2);
    expect(adapter.inspectTasks()).toHaveLength(2);
    expect(adapter.inspectTasks().map(({ reservationToken }) => reservationToken)).toEqual([undefined, undefined]);
  });

  it("preserves a scope failure when the reservation release also fails", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "release.failure", handler: () => undefined });
    const scopeFailure = new Error("Execution scope unavailable");
    const releaseFailure = new Error("Storage unavailable during release");
    const record = vi.fn();
    const release = vi.spyOn(adapter, "releaseTasks").mockRejectedValueOnce(releaseFailure);
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      runInExecutionScope: async () => { throw scopeFailure; },
      instrumentation: { record },
    });
    await new WorkflowClient(adapter).start(workflow, null, { executionId: "release-failure" });

    const startedAt = performance.now();
    await expect(scheduler.runOnce()).rejects.toMatchObject({
      name: "AggregateError", message: "Workflow task execution and release failed.", errors: [scopeFailure, releaseFailure],
    });
    expect(release).toHaveBeenCalledExactlyOnceWith([{ taskId: expect.any(String), reservationToken: expect.any(String) }]);
    expect(record.mock.calls).toStrictEqual([[{
      type: "task", outcome: "failure", durationMs: expect.any(Number),
      data: {
        executionId: "release-failure", workflowName: workflow.name, workflowVersion: 1,
        historyGeneration: 1, taskKind: "workflow", result: "failed", attempt: 1, queueAgeMs: expect.any(Number),
      },
    }]]);
    expect(record.mock.calls[0]?.[0].durationMs).toBeLessThanOrEqual(performance.now() - startedAt);
  });

  it.each([
    { payload: { durationMs: 4 }, target: "sleep", sequence: 0, lag: 16 },
    { payload: { timeoutMs: 7 }, target: "signal:workflow.ready", sequence: 2, lag: 13 },
    { payload: null, target: "sleep", sequence: 0, lag: 20 },
    { payload: [7], target: "sleep", sequence: 0, lag: 20 },
    { payload: "legacy", target: "sleep", sequence: 0, lag: 20 },
    { payload: { durationMs: "unknown" }, target: "sleep", sequence: 0, lag: 20 },
    { payload: { durationMs: Infinity }, target: "sleep", sequence: 0, lag: 20 },
  ] as const)("records a timer scope and observation for $payload", async ({ payload, target, sequence, lag }) => {
    const adapter = new MemoryWorkflowAdapter();
    const timer = createReservedTimer({ payload, target, commandSequence: sequence });
    vi.spyOn(adapter, "reserveTasks").mockResolvedValueOnce([timer]);
    const load = vi.spyOn(adapter, "loadActivations");
    const complete = vi.spyOn(adapter, "completeActivities").mockResolvedValueOnce([{
      taskId: timer.id, reservationToken: timer.reservationToken,
    }]);
    const scope = vi.fn();
    const record = vi.fn();
    const scheduler = new WorkflowScheduler([], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      completionBatchSize: 1, instrumentation: { record },
      runInExecutionScope: (id, operation, run, task) => { scope(id, operation, run, task); return run(); },
    });

    const startedAt = performance.now();
    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
    expect(load).not.toHaveBeenCalled();
    expect(scope).toHaveBeenCalledExactlyOnceWith(timer.executionId, "workflow.timer", expect.any(Function), timer);
    const completion = target.startsWith("signal:")
      ? { status: "failed", error: expect.objectContaining({
          name: "WorkflowSignalTimeoutError", details: { executionId: timer.executionId, signalName: "workflow.ready" },
        }) }
      : { status: "completed", result: null };
    expect(complete).toHaveBeenCalledExactlyOnceWith([{
      taskId: timer.id, reservationToken: timer.reservationToken, executionId: timer.executionId, sequence, ...completion,
    }]);
    expect(record.mock.calls).toStrictEqual([[{
      type: "task", outcome: "success", durationMs: expect.any(Number),
      data: {
        executionId: timer.executionId, workflowName: timer.workflowName, workflowVersion: timer.workflowVersion,
        historyGeneration: timer.historyGeneration, taskKind: "timer", result: "committed", attempt: 1,
        queueAgeMs: 20, timerLagMs: lag, commandSequence: sequence, target,
      },
    }]]);
    expect(record.mock.calls[0]?.[0].durationMs).toBeLessThanOrEqual(performance.now() - startedAt);
  });

  it.each(["target", "commandSequence"] as const)("returns an invalid timer reservation missing %s", async (missing) => {
    const adapter = new MemoryWorkflowAdapter();
    const timer = createReservedTimer({});
    delete timer[missing];
    vi.spyOn(adapter, "reserveTasks").mockResolvedValueOnce([timer]);
    const release = vi.spyOn(adapter, "releaseTasks");
    const complete = vi.spyOn(adapter, "completeActivities");
    const scheduler = new WorkflowScheduler([], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), { completionBatchSize: 1 });

    await expect(scheduler.runOnce()).rejects.toThrow(new TypeError(`Workflow task "${timer.id}" is not a valid timer.`));
    expect(release).toHaveBeenCalledExactlyOnceWith([{ taskId: timer.id, reservationToken: timer.reservationToken }]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("executes replay activations and embedded activities to completion", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const uppercaseAction = defineAction({
      name: "example.uppercase",
      input: z.object({ value: z.string() }),
      output: z.object({ result: z.string() }),
      handler: ({ value }) => ({ result: value.toUpperCase() }),
    });
    const workflow = defineWorkflow({
      name: "example.run",
      input: z.object({ value: z.string() }),
      output: z.object({ result: z.string() }),
      handler: (input, context) => context.run(uppercaseAction, input),
    });
    const transport = new EmbeddedWorkflowActivityTransport((target) =>
      target === "example.uppercase"
        ? (payload) => ({
            result: (payload as { value: string }).value.toUpperCase(),
          })
        : undefined);
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      transport,
    );
    const client = new WorkflowClient(adapter);
    const handle = await client.start(workflow, { value: "hello" });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    await expect(handle.status()).resolves.toMatchObject({ status: "waiting" });
    await scheduler.runOnce();
    await scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
    await expect(handle.result()).resolves.toEqual({ result: "HELLO" });
    await expect(adapter.getHistory(handle.executionId)).resolves.toMatchObject([
      { type: "command-scheduled", target: "example.uppercase" },
      { type: "command-completed", result: { result: "HELLO" } },
    ]);
  });

  it("buffers concurrent activity completions into one adapter call", async () => {
    class TrackingAdapter extends MemoryWorkflowAdapter {
      public readonly completionBatchSizes: number[] = [];

      public override async completeActivities(
        requests: readonly import("./adapter.js").CompleteWorkflowActivityRequest[],
      ) {
        this.completionBatchSizes.push(requests.length);
        return super.completeActivities(requests);
      }
    }

    const adapter = new TrackingAdapter();
    const action = defineAction({
      name: "batch.activity",
      output: z.string(),
      handler: () => "done",
    });
    const workflow = defineWorkflow({
      name: "batch.completions",
      handler: async (_input, context) => {
        await Promise.all([
          context.run(action, null),
          context.run(action, null),
        ]);
      },
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => () => "done"),
      { completionBatchSize: 2, completionFlushIntervalMs: 100 },
    );
    await new WorkflowClient(adapter).start(workflow, null);

    await scheduler.runOnce();
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 2 });

    expect(adapter.completionBatchSizes).toEqual([2]);
  });

  it("buffers concurrent timer completions into one adapter call", async () => {
    class TrackingAdapter extends MemoryWorkflowAdapter {
      public readonly completionBatchSizes: number[] = [];

      public override async completeActivities(
        requests: readonly import("./adapter.js").CompleteWorkflowActivityRequest[],
      ) {
        this.completionBatchSizes.push(requests.length);
        return super.completeActivities(requests);
      }
    }

    const adapter = new TrackingAdapter();
    const workflow = defineWorkflow({
      name: "batch.timers",
      handler: async (_input, context) => {
        await Promise.all([
          context.sleep({ milliseconds: 0 }),
          context.sleep({ milliseconds: 0 }),
        ]);
      },
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      { completionBatchSize: 2, completionFlushIntervalMs: 100 },
    );
    await new WorkflowClient(adapter).start(workflow, null);

    await scheduler.runOnce();
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 2 });

    expect(adapter.completionBatchSizes).toEqual([2]);
  });

  it.each([1, 3])("blocks an execution whose pinned version %s is outside the deployment range", async (version) => {
    const adapter = new MemoryWorkflowAdapter();
    const oldWorkflow = defineWorkflow({
      name: "versioned.run",
      version: { current: version },
      handler: () => undefined,
    });
    const client = new WorkflowClient(adapter);
    const handle = await client.start(oldWorkflow, null);
    const currentWorkflow = defineWorkflow({
      name: "versioned.run",
      version: { current: 2, supportedFrom: 2 },
      handler: () => undefined,
    });
    const scheduler = new WorkflowScheduler(
      [currentWorkflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
    );

    await scheduler.runOnce();

    await expect(adapter.get(handle.executionId)).resolves.toMatchObject({
      status: "blocked",
      error: { name: "WorkflowExecutionVersionUnsupportedError" },
    });
  });

  it("runs every task inside the injected execution boundary", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const commit = vi.spyOn(adapter, "commitActivation");
    const workflow = defineWorkflow({
      name: "scope.run",
      handler: () => undefined,
    });
    const calls: string[] = [];
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      {
        runInExecutionScope: async (executionId, operation, run) => {
          calls.push(`${executionId}:${operation}`);
          return run();
        },
      },
    );
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    await scheduler.runOnce();

    expect(calls).toEqual([`${handle.executionId}:workflow.activate`]);
    expect(commit.mock.calls[0]?.[0].outcome).toStrictEqual({ status: "completed" });
  });

  it("commits an embedded activity without a result as an absent durable value", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const action = defineAction({ name: "no-result.activity", output: z.undefined(), handler: () => undefined });
    const workflow = defineWorkflow({ name: "no-result.workflow", handler: async (_input, context) => {
      await context.run(action, null);
    } });
    const complete = vi.spyOn(adapter, "completeActivities");
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => () => undefined), {
      completionBatchSize: 1,
    });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(complete.mock.calls).toStrictEqual([[[{
      taskId: expect.any(String), reservationToken: expect.any(String), executionId: handle.executionId,
      sequence: 0, status: "completed",
    }]]]);
  });

  it("loads reserved workflow snapshots in one batch before opening scopes", async () => {
    class TrackingAdapter extends MemoryWorkflowAdapter {
      public readonly batchSizes: number[] = [];

      public snapshotsLoaded = false;

      public override async loadActivations(
        reservations: readonly WorkflowTaskReservationRef[],
      ) {
        this.batchSizes.push(reservations.length);
        const loaded = await super.loadActivations(reservations);
        this.snapshotsLoaded = true;
        return loaded;
      }
    }

    const adapter = new TrackingAdapter();
    const workflow = defineWorkflow({
      name: "batch.run",
      handler: () => undefined,
    });
    const scopeStates: boolean[] = [];
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      {
        runInExecutionScope: async (_executionId, _operation, run) => {
          scopeStates.push(adapter.snapshotsLoaded);
          return run();
        },
      },
    );
    const client = new WorkflowClient(adapter);
    await client.start(workflow, null, { executionId: "batch-1" });
    await client.start(workflow, null, { executionId: "batch-2" });

    await expect(scheduler.runOnce()).resolves.toEqual({
      reserved: 2,
      completed: 2,
      stale: 0,
    });
    expect(adapter.batchSizes).toEqual([2]);
    expect(scopeStates).toEqual([true, true]);
  });

  it("releases an activation when a signal advances its loaded revision", async () => {
    class RacingSignalAdapter extends MemoryWorkflowAdapter {
      private injectSignal = true;

      public override async loadActivations(
        reservations: readonly WorkflowTaskReservationRef[],
      ) {
        const loaded = await super.loadActivations(reservations);
        const snapshot = loaded[0]?.snapshot;

        if (snapshot !== undefined && this.injectSignal) {
          this.injectSignal = false;
          await this.sendSignal({
            executionId: snapshot.executionId,
            workflowName: snapshot.workflowName,
            signalName: "example.race",
            payload: null,
          });
        }

        return loaded;
      }
    }

    const adapter = new RacingSignalAdapter();
    const record = vi.fn();
    const get = vi.spyOn(adapter, "get");
    const workflow = defineWorkflow({
      name: "race.run",
      handler: () => undefined,
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      { instrumentation: { record } },
    );
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    await expect(scheduler.runOnce()).resolves.toEqual({
      reserved: 1,
      completed: 0,
      stale: 1,
    });
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "task", outcome: "success", data: expect.objectContaining({ executionId: handle.executionId, result: "stale" }),
    }));
    expect(get).not.toHaveBeenCalled();
    await scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
    await expect(adapter.getHistory(handle.executionId)).resolves.toMatchObject([
      { type: "signal-received", name: "example.race" },
    ]);
  });

  it("recovers a task after an interruption before its durable commit", async () => {
    class InterruptingAdapter extends MemoryWorkflowAdapter {
      private interrupt = true;

      public override async commitActivation(
        request: CommitWorkflowActivationRequest,
      ): Promise<boolean> {
        if (this.interrupt) {
          this.interrupt = false;
          throw new Error("Injected interruption");
        }

        return super.commitActivation(request);
      }
    }

    const adapter = new InterruptingAdapter();
    const workflow = defineWorkflow({
      name: "interruption.run",
      handler: () => undefined,
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
    );
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    await expect(scheduler.runOnce()).rejects.toThrow("Injected interruption");
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
  });

  it("allows only one scheduler to reserve a workflow activation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({
      name: "concurrent.run",
      handler: () => undefined,
    });
    const transport = new EmbeddedWorkflowActivityTransport(() => undefined);
    const first = new WorkflowScheduler([workflow], adapter, transport);
    const second = new WorkflowScheduler([workflow], adapter, transport);
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    const cycles = await Promise.all([first.runOnce(), second.runOnce()]);

    expect(cycles.reduce((total, cycle) => total + cycle.reserved, 0)).toBe(1);
    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
  });

  it.each([1, 2])("blocks replay only after exceeding the configured %s-event history limit", async (maxHistoryEvents) => {
    const adapter = new MemoryWorkflowAdapter();
    const action = defineAction({
      name: "history.activity",
      output: z.null(),
      handler: () => null,
    });
    const workflow = defineWorkflow({
      name: "history.run",
      handler: async (_input, context) => {
        await context.run(action, null);
      },
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => () => null),
      { maxHistoryEvents },
    );
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    await scheduler.runOnce();
    await scheduler.runOnce();
    await scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject(maxHistoryEvents === 1
      ? { status: "blocked", error: { name: "WorkflowHistoryLimitExceededError" } }
      : { status: "completed" });
  });

  it.each([false, true])("settles a caught continuation interrupt (subsequent failure=%s)", async (fails) => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "generation.failure",
      handler: async (_input, context) => {
        try {
          await context.continueAsNew(null);
        } catch {
          if (fails) throw new Error("Cleanup after continuation failed");
        }
      },
    });
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined));
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    await expect(handle.status()).resolves.toMatchObject(fails
      ? { status: "failed", historyGeneration: 1, error: { message: "Cleanup after continuation failed" } }
      : { status: "queued", historyGeneration: 2 });
    await expect(adapter.getHistoryArchives(handle.executionId)).resolves.toHaveLength(fails ? 0 : 1);
  });

  it("continues as new under the same identity with a fresh archived generation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const record = vi.fn();
    const workflow = defineWorkflow({
      name: "generation.loop",
      version: { current: 2, supportedFrom: 1 },
      input: z.object({ remaining: z.number().int().nonnegative() }),
      output: z.object({ generation: z.number().int() }),
      handler: async ({ remaining }, context) => {
        if (remaining > 0) {
          await context.continueAsNew({ remaining: remaining - 1 });
        }
        return { generation: context.generation };
      },
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      { instrumentation: { record } },
    );
    const handle = await new WorkflowClient(adapter).start(
      workflow,
      { remaining: 2 },
      { executionId: "generation-loop" },
    );

    await scheduler.runOnce();
    // A queued successor has no completed or waiting lifecycle result yet.
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "task", data: expect.objectContaining({ result: "committed" }),
    }));
    await expect(handle.status()).resolves.toMatchObject({
      executionId: "generation-loop",
      workflowVersion: 2,
      historyGeneration: 2,
      input: { remaining: 1 },
      status: "queued",
    });
    await scheduler.runOnce();
    await scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "completed", historyGeneration: 3 });
    await expect(handle.result()).resolves.toEqual({ generation: 3 });
    await expect(adapter.getHistoryArchives("generation-loop"))
      .resolves.toMatchObject([
        { historyGeneration: 1, input: { remaining: 2 }, history: [] },
        { historyGeneration: 2, input: { remaining: 1 }, history: [] },
      ]);
    // A retry of the original start request remains idempotent even though the
    // current generation input has changed twice.
    await expect(new WorkflowClient(adapter).start(
      workflow,
      { remaining: 2 },
      { executionId: "generation-loop" },
    )).resolves.toMatchObject({ executionId: "generation-loop" });
  });
});

/** A custom adapter can return a timer even when its historical payload is incomplete. */
function createReservedTimer(overrides: Partial<ReservedWorkflowTask>): ReservedWorkflowTask {
  return {
    id: "timer-task",
    executionId: "timer-run",
    workflowName: "timers.example",
    workflowVersion: 2,
    historyGeneration: 3,
    rootExecutionId: "timer-run",
    kind: "timer",
    commandSequence: 0,
    target: "sleep",
    attempt: 1,
    availableAt: new Date(100),
    reservedAt: new Date(120),
    reservationToken: "owned-timer",
    createdAt: new Date(100),
    ...overrides,
  };
}
