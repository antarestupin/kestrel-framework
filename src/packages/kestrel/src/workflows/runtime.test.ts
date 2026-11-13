import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { App, defineCatalog, executionCompletedEvent, executionContextDependency } from "../app/index.js";
import { PollingSupervisor } from "../scheduling/index.js";
import { MemoryWorkerAdapter, WorkerClient } from "../workers/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowClient } from "./client.js";
import { WorkflowRuntime } from "./runtime.js";
import { defineWorkflow } from "./workflow.js";
import { createWorkflowActivityWorker } from "./worker_activity_transport.js";
import { getWorkflowActivityExecutionContext } from "./activity_transport.js";

describe("WorkflowRuntime", () => {
  it.each(["resolve", "execution.started", "execution.completed"] as const)(
    "disposes the workflow execution when observation fails at %s",
    async (phase) => {
      const failure = new Error("workflow observation failed");
      const handler = vi.fn(() => undefined);
      const workflow = defineWorkflow({ name: "runtime.observation", handler });
      const app = new App({}, { catalog: defineCatalog({ runtime: { workflows: { workflow } } }) });
      const completed = vi.fn();
      const createScope = vi.spyOn(app, "createExecutionScope");
      app.container.registerFactory("observer", () => {
        if (phase === "resolve") throw failure;
        return {
          record: ({ name }: { name: string }) => {
            if (name === phase) throw failure;
          },
        };
      }, { lifetime: "scoped" });
      app.eventBus.listen(executionCompletedEvent, (event) => completed(event.outcome), { scope: "descendants" });
      const adapter = new MemoryWorkflowAdapter();
      const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never);
      try {
        await app.start();
        await new WorkflowClient(adapter).start(workflow, null);
        await expect(runtime.scheduler.runOnce()).rejects.toBe(failure);
        expect(handler).toHaveBeenCalledTimes(phase === "execution.completed" ? 1 : 0);
        expect(completed).toHaveBeenCalledExactlyOnceWith(phase === "execution.completed" ? "success" : "failure");
      } finally {
        // Release any scope left behind by a failing disposal assertion.
        const scopes = await Promise.allSettled(createScope.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : []));
        await Promise.allSettled(scopes.flatMap((scope) =>
          scope.status === "fulfilled" ? [scope.value.dispose("cancelled")] : []));
        createScope.mockRestore();
        await app.dispose();
      }
    },
  );

  it("resumes useful workflow processing after a transient reservation failure", async () => {
    const workflow = defineWorkflow({ name: "runtime.recovery", handler: () => undefined });
    const app = new App({}, { catalog: defineCatalog({ runtime: { workflows: { workflow } } }) });
    const adapter = new MemoryWorkflowAdapter();
    const failure = new Error("temporary reservation failure");
    const original = adapter.reserveTasks.bind(adapter);
    const reserve = vi.spyOn(adapter, "reserveTasks").mockRejectedValueOnce(failure).mockImplementation(original);
    const log = vi.fn();
    const runtime = new WorkflowRuntime(app, adapter, { error: log } as never, {
      polling: { initialBackoffMs: 1, maxBackoffMs: 1, isRecoverable: (error) => error === failure },
    });
    const fixture = new AbortController();
    const poll = runtime.scheduler.polling.run.bind(runtime.scheduler.polling);
    vi.spyOn(runtime.scheduler.polling, "run").mockImplementation((signal, ...options) =>
      poll(AbortSignal.any([signal, fixture.signal]), ...options));
    await app.start();
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    try {
      await runtime.start();
      await vi.waitFor(async () => expect(await handle.status()).toMatchObject({ status: "completed" }));
      expect(reserve.mock.calls.length).toBeGreaterThan(1);
      expect(runtime.state.scheduler.successfulCycles).toBeGreaterThan(0);
      expect(log).toHaveBeenCalledExactlyOnceWith({ err: failure }, "Workflow polling cycle failed");
      void runtime.stop().catch(() => undefined);
      await setImmediate();
      expect(runtime.state.scheduler.status).toBe("stopped");
    } finally { fixture.abort(); await runtime.stop(); await app.dispose(); }
  });

  it("stops polling through the application drain without an explicit runtime stop", async () => {
    const app = new App({});
    const runtime = new WorkflowRuntime(app, new MemoryWorkflowAdapter(), { error: vi.fn() } as never);
    try {
      await app.start();
      await runtime.start();
      expect(runtime.state.scheduler.status).toBe("running");
      await app.stop();
      await app.shutdown.drained();
      expect(runtime.state.scheduler.status).toBe("stopped");
    } finally { await runtime.stop(); await app.dispose(); }
  });

  it("preserves the setup error when disposing its execution also fails", async () => {
    const setupFailure = new Error("Observer could not be constructed");
    const disposalFailure = new Error("Scoped release failed");
    const workflow = defineWorkflow({ name: "runtime.setup-failure", handler: () => undefined });
    const app = new App({}, { catalog: defineCatalog({ runtime: { workflows: { workflow } } }) });
    app.container.registerFactory("observer", () => { throw setupFailure; }, { lifetime: "scoped" });
    const dispose = vi.fn(() => { throw disposalFailure; });
    app.eventBus.listen(executionCompletedEvent, dispose, { scope: "descendants" });
    const adapter = new MemoryWorkflowAdapter();
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never);
    try {
      await app.start();
      await new WorkflowClient(adapter).start(workflow, null);
      await expect(runtime.scheduler.runOnce()).rejects.toMatchObject({
        name: "AggregateError",
        message: "Workflow scope setup and disposal failed.",
        errors: [setupFailure, disposalFailure],
      });
      expect(dispose).toHaveBeenCalledOnce();
    } finally { await app.dispose(); }
  });

  it("reports task, observation and disposal failures from the same execution", async () => {
    const taskFailure = new Error("Activation storage unavailable");
    const observationFailure = new Error("Completion observation unavailable");
    const disposalFailure = new Error("Scoped release failed");
    const workflow = defineWorkflow({ name: "runtime.task-failure", handler: () => undefined });
    const app = new App({}, { catalog: defineCatalog({ runtime: { workflows: { workflow } } }) });
    app.container.registerValue("observer", {
      record: ({ name }: { name: string }) => {
        if (name === "execution.completed") throw observationFailure;
      },
    });
    app.eventBus.listen(executionCompletedEvent, () => { throw disposalFailure; }, { scope: "descendants" });
    const adapter = new MemoryWorkflowAdapter();
    vi.spyOn(adapter, "commitActivation").mockRejectedValueOnce(taskFailure);
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never);
    try {
      await app.start();
      await new WorkflowClient(adapter).start(workflow, null);
      await expect(runtime.scheduler.runOnce()).rejects.toMatchObject({
        name: "AggregateError",
        message: "Workflow execution and cleanup failed.",
        errors: [taskFailure, observationFailure, disposalFailure],
      });
    } finally { await app.dispose(); }
  });

  it("supervises standalone polling through its own shutdown listener", async () => {
    const app = new App({});
    const runtime = new WorkflowRuntime(app, new MemoryWorkflowAdapter(), { error: vi.fn() } as never);
    await app.start();
    const listeners = vi.spyOn(process, "once");
    const before = process.listenerCount("SIGTERM");
    const running = runtime.run();
    const requestStop = () => listeners.mock.calls.find(([event]) => event === "SIGTERM")?.[1]();
    try {
      await setImmediate();
      expect(runtime.state.scheduler.status).toBe("running");
      expect(process.listenerCount("SIGTERM")).toBe(before + 1);
      requestStop();
      await expect(running).resolves.toBeUndefined();
      expect(runtime.state.scheduler.status).toBe("stopped");
      expect(process.listenerCount("SIGTERM")).toBe(before);
    } finally { requestStop(); await Promise.allSettled([running, runtime.stop()]); listeners.mockRestore(); await app.dispose(); }
  });

  it("rejects the owning composite runtime when polling terminates", async () => {
    const app = new App({});
    const adapter = new MemoryWorkflowAdapter();
    const failure = new Error("terminal reservation failure");
    vi.spyOn(adapter, "reserveTasks").mockRejectedValue(failure);
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never);
    const { BackgroundRuntime } = await import("../background/runtime.js");
    const stopWorker = vi.fn(async () => undefined);
    const background = new BackgroundRuntime(app, {
      workers: { start: () => undefined, stop: stopWorker }, workflows: runtime,
    });
    await app.start();
    const before = process.listenerCount("SIGTERM");
    try {
      const failed = vi.fn();
      const running = background.run([]);
      void running.catch(failed);
      await vi.waitFor(() => expect(runtime.state.scheduler.status).toBe("failed"));
      await setImmediate();
      expect(failed).toHaveBeenCalledOnce();
      expect(runtime.state.scheduler.status).toBe("failed");
      expect(app.state).toBe("stopping");
      expect(stopWorker).toHaveBeenCalledOnce();
      expect(process.listenerCount("SIGTERM")).toBe(before);
      await expect(runtime.start()).rejects.toThrow();
    } finally { await app.dispose().catch(() => undefined); }
  });

  it("uses reservation diagnostics without rereading the execution", async () => {
    const workflow = defineWorkflow({
      name: "runtime.diagnostics",
      handler: () => undefined,
    });
    const app = new App({}, {
      catalog: defineCatalog({
        runtime: { workflows: { diagnostics: workflow } },
      }),
    });
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const getExecution = vi.spyOn(adapter, "get");

    await app.start();
    try {
      await client.start(workflow, null, { executionId: "diagnostics-1" });
      const [task] = adapter.inspectTasks();
      const createExecutionScope = vi.spyOn(app, "createExecutionScope");
      const runtime = new WorkflowRuntime(
        app,
        adapter,
        { error: vi.fn() } as never,
      );

      await expect(runtime.scheduler.runOnce()).resolves.toEqual({
        reserved: 1,
        completed: 1,
        stale: 0,
      });
      expect(getExecution).not.toHaveBeenCalled();
      expect(createExecutionScope).toHaveBeenCalledWith(`${task!.id}:1`);
      const taskScope = await createExecutionScope.mock.results[0]!.value;
      expect(taskScope.context.toRecord("observation")).toMatchObject({
        "workflow.executionId": "diagnostics-1",
        "workflow.rootExecutionId": "diagnostics-1",
        "workflow.taskAttempt": 1,
        "workflow.taskId": task!.id,
        "workflow.taskKind": "workflow",
        "workflow.replay": true,
      });
      expect(taskScope.context.toRecord("log")).toMatchObject({ operation: "workflow.activate", transport: "workflow", workload: "workflows" });
    } finally {
      await app.dispose();
    }
  });

  it("projects the parent identity of a durable child task into its execution scope", async () => {
    const child = defineWorkflow({ name: "runtime.child", handler: () => undefined });
    const parent = defineWorkflow({ name: "runtime.parent", handler: async (_input, context) => { await context.runChild(child, null); } });
    const app = new App({}, { catalog: defineCatalog({ runtime: { workflows: { child, parent } } }) });
    const completed = vi.fn();
    app.eventBus.listen(executionCompletedEvent, ({ context }) => completed(context.toRecord("observation")), { scope: "descendants" });
    const adapter = new MemoryWorkflowAdapter();
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never);
    try {
      await app.start();
      await new WorkflowClient(adapter).start(parent, null, { executionId: "parent-run" });
      await runtime.scheduler.runOnce();
      await runtime.scheduler.runOnce();
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({
        "workflow.name": "runtime.child", "workflow.parentExecutionId": "parent-run", "workflow.rootExecutionId": "parent-run",
      }));
    } finally { await app.dispose(); }
  });

  it.each([new Error("commit unavailable"), undefined])("records failed scoped completion even when the storage rejection has no value: %s", async (failure) => {
    const workflow = defineWorkflow({ name: "runtime.scope-failure", handler: () => undefined });
    const app = new App({}, { catalog: defineCatalog({ runtime: { workflows: { workflow } } }) });
    const record = vi.fn();
    app.container.registerValue("observer", { record });
    const adapter = new MemoryWorkflowAdapter();
    vi.spyOn(adapter, "commitActivation").mockRejectedValue(failure);
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never);
    try {
      await app.start();
      await new WorkflowClient(adapter).start(workflow, null, { executionId: "failed-commit" });
      const clock = vi.spyOn(performance, "now").mockReturnValue(100_000);
      try { await expect(runtime.scheduler.runOnce()).rejects.toBe(failure); }
      finally { clock.mockRestore(); }
      const started = record.mock.calls.find(([definition]) => definition.name === "execution.started");
      const completed = record.mock.calls.find(([definition]) => definition.name === "execution.completed");
      expect(started?.[1]).toMatchObject({ operation: "workflow.activate", transport: "workflow", context: { "workflow.executionId": "failed-commit" } });
      expect(completed?.[1]).toMatchObject({ operation: "workflow.activate", transport: "workflow",
        error: { message: failure?.message ?? "undefined" } });
      expect(completed?.[2]).toEqual({ outcome: "failure", durationMs: 0 });
    } finally { await app.dispose(); }
  });

  it("reports timer command identity without an error on successful scoped completion", async () => {
    const workflow = defineWorkflow({ name: "runtime.observed-timer", handler: (_input, context) => context.sleep({ milliseconds: 10 }) });
    const app = new App({}, { catalog: defineCatalog({ runtime: { workflows: { workflow } } }) });
    const record = vi.fn();
    app.container.registerValue("observer", { record });
    let now = new Date("2026-01-01T00:00:00Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never, { now: () => now.getTime() });
    try {
      await app.start();
      await new WorkflowClient(adapter).start(workflow, null, { executionId: "observed-timer" });
      await runtime.scheduler.runOnce();
      now = new Date(now.getTime() + 10);
      await runtime.scheduler.runOnce();
      // A timer has no Action transport to add the command identity on its behalf.
      const timer = record.mock.calls.find(([definition, data]) => definition.name === "execution.completed" && data.operation === "workflow.timer");
      expect(timer?.[1]).toMatchObject({ context: { "workflow.executionId": "observed-timer", "workflow.commandSequence": 0 } });
      expect(timer?.[1]).not.toHaveProperty("error");
      expect(timer?.[2]).toMatchObject({ outcome: "success" });
    } finally { await app.dispose(); }
  });

  it("executes embedded Actions through the owned application execution scope and codec", async () => {
    const activities: unknown[] = [];
    const action = defineAction({ name: "runtime.embedded", input: z.number(), output: z.number(),
      dependencies: { executionContext: executionContextDependency },
      handler: (value, { executionContext }) => {
        activities.push(getWorkflowActivityExecutionContext(executionContext));
        return value + 1;
      },
    });
    const workflow = defineWorkflow({ name: "runtime.embedded-workflow", input: z.number(), output: z.number(),
      handler: (value, context) => context.run(action, value),
    });
    const app = new App({}, { catalog: defineCatalog({ actions: { action }, runtime: { workflows: { workflow } } }) });
    const adapter = new MemoryWorkflowAdapter();
    const payloadCodec = {
      encode: (value: unknown) => String(value),
      decode: (value: unknown) => Number(value),
    };
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never, { completionBatchSize: 1, payloadCodec });
    const diagnostics: unknown[] = [];
    app.eventBus.listen(executionCompletedEvent, ({ context, outcome }) => diagnostics.push({ outcome, ...context.toRecord("observation") }), { scope: "descendants" });
    try {
      await app.start();
      const handle = await new WorkflowClient(adapter, { payloadCodec }).start(workflow, 2, { executionId: "embedded" });
      for (let cycle = 0; cycle < 3; cycle++) await runtime.scheduler.runOnce();
      await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
      await expect(handle.result()).resolves.toBe(3);
      expect(activities).toMatchObject([{ executionId: "embedded", sequence: 0, historyGeneration: 1, idempotencyKey: "embedded:0" }]);
      expect(diagnostics).toContainEqual(expect.objectContaining({ outcome: "success", "workflow.commandSequence": 0, "workflow.taskKind": "activity", "workflow.replay": false }));
    } finally { await app.dispose(); }
  });

  it("checks active pinned versions before starting any polling", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start({
      executionId: "unsupported-v1",
      workflowName: "runtime.versioned",
      workflowVersion: 1,
      input: null,
    });
    const current = defineWorkflow({
      name: "runtime.versioned",
      version: { current: 2, supportedFrom: 2 },
      handler: () => undefined,
    });
    const createExecutionScope = vi.fn();
    const runtime = new WorkflowRuntime(
      {
        catalog: {
          actions: { definitions: [] },
          workflows: { definitions: [current] },
        },
        createExecutionScope,
      } as never,
      adapter,
      { error: vi.fn() } as never,
    );

    await expect(runtime.start()).rejects.toMatchObject({
      name: "WorkflowDeploymentVersionError",
    });
    expect(createExecutionScope).not.toHaveBeenCalled();
    expect(adapter.inspectTasks()).toHaveLength(1);
  });

  it("waits for startup while stopping and never admits work after stop", async () => {
    const app = new App({});
    const adapter = new MemoryWorkflowAdapter();
    const reserve = vi.spyOn(adapter, "reserveTasks");
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never);
    const inventory = { summaries: [], unsupportedActiveVersions: [] };
    const check = Promise.withResolvers<typeof inventory>();
    const compatible = vi.spyOn(runtime.versions, "assertCompatible").mockReturnValue(check.promise);
    const stopped = vi.fn();
    try {
      await app.start();
      expect(runtime.completion).toBeUndefined();
      const starting = runtime.start();
      expect(runtime.start()).toBe(starting);
      const stopping = runtime.stop();
      void stopping.then(stopped, stopped);
      expect(runtime.stop()).toBe(stopping);
      expect(stopped).not.toHaveBeenCalled();
      expect(compatible).toHaveBeenCalledOnce();
      check.resolve(inventory);
      await expect(starting).resolves.toBeUndefined();
      await expect(stopping).resolves.toBeUndefined();
      expect(reserve).not.toHaveBeenCalled();
      expect(runtime.state).toMatchObject({ scheduler: { status: "stopped" }, dispatcher: { status: "idle" } });
      await expect(runtime.start()).rejects.toThrow("Workflow runtime has stopped.");
    } finally { check.resolve(inventory); await runtime.stop(); await app.dispose(); }
  });

  it("reports a terminal outbox failure and stops sibling scheduler polling", async () => {
    const app = new App({});
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const failure = new Error("outbox database unavailable");
    const reserve = vi.spyOn(adapter, "reserveTasks");
    const reserveDispatches = vi.spyOn(adapter, "reserveActivityDispatches").mockRejectedValue(failure);
    const log = vi.fn();
    const worker = createWorkflowActivityWorker(app);
    const runtime = new WorkflowRuntime(app, adapter, { error: log } as never,
      { outbox: { batchSize: 6, leaseMs: 850 } }, worker, new WorkerClient(new MemoryWorkerAdapter()));
    try {
      await app.start();
      await runtime.start();
      expect(runtime.completion).toBeDefined();
      const failed = vi.fn();
      void runtime.completion?.catch(failed);
      await setImmediate();
      expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
      // The failure must abort sibling polling before explicit shutdown.
      expect(runtime.state.scheduler.status).toBe("stopped");
      await expect(runtime.stop()).rejects.toMatchObject({
        name: "AggregateError", message: "Workflow polling failed.", errors: [failure],
      });
      expect(reserveDispatches).toHaveBeenCalledExactlyOnceWith({ limit: 6, leaseMs: 850 });
      expect(reserve).toHaveBeenCalledOnce();
      expect(reserve.mock.calls[0]?.[0].kinds).toEqual(["workflow", "timer"]);
      expect(log).toHaveBeenCalledExactlyOnceWith({ err: failure }, "Workflow activity outbox publication failed");
      expect(runtime.state).toMatchObject({ scheduler: { status: "stopped" }, dispatcher: { status: "failed", error: failure } });
    } finally { await runtime.stop().catch(() => undefined); await app.dispose().catch(() => undefined); }
  });

  it.each(["adapter", "configured"] as const)("retries a %s-classified outbox failure and waits after an empty cycle", async (policy) => {
    vi.useFakeTimers();
    const app = new App({});
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const failure = new Error("outbox temporarily unavailable");
    const classify = vi.fn((error) => error === failure);
    Object.assign(adapter, { isRecoverablePollingError: policy === "adapter" ? classify : () => false });
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof adapter.reserveActivityDispatches>>>();
    const reserve = vi.spyOn(adapter, "reserveActivityDispatches")
      .mockRejectedValueOnce(failure).mockResolvedValueOnce([]).mockImplementation(() => gate.promise);
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never, {
      polling: { initialBackoffMs: 4, maxBackoffMs: 4, ...(policy === "configured" ? { isRecoverable: classify } : {}) },
    }, createWorkflowActivityWorker(app), new WorkerClient(new MemoryWorkerAdapter()));
    try {
      await app.start();
      await runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.state.dispatcher.status).toBe("backoff");
      expect(classify).toHaveBeenCalledExactlyOnceWith(failure);
      await vi.advanceTimersByTimeAsync(5);
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(runtime.state.dispatcher.successfulCycles).toBe(1);
      await vi.advanceTimersByTimeAsync(95);
      expect(reserve).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5);
      expect(reserve).toHaveBeenCalledTimes(3);
    } finally {
      // Release a third reservation attempt even if a mutant skips the idle wait.
      const stopping = runtime.stop();
      gate.resolve([]);
      try { await stopping.catch(() => undefined); await app.dispose().catch(() => undefined); }
      finally { vi.useRealTimers(); }
    }
  });

  it("keeps the outbox polling active for work and idles after an empty reservation", async () => {
    const app = new App({});
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const dispatch = {
      id: "dispatch", executionId: "run", sequence: 0, target: "example.activity", payload: null,
      attempt: 1, availableAt: new Date(0), reservedAt: new Date(0), createdAt: new Date(0), reservationToken: "token",
    };
    vi.spyOn(adapter, "reserveActivityDispatches").mockResolvedValueOnce([dispatch]).mockResolvedValueOnce([]);
    vi.spyOn(adapter, "markActivityDispatchesPublished").mockImplementation(async (requests) => requests);
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never, {},
      createWorkflowActivityWorker(app), new WorkerClient(new MemoryWorkerAdapter()));
    // Exercise the callback directly so incorrect busy-polling fails an assertion.
    const polling = vi.spyOn(PollingSupervisor.prototype, "run");
    try {
      polling.mockImplementation(async function (this: PollingSupervisor, _signal, cycle, interval) {
        if (this === runtime.scheduler.polling) return;
        expect(interval).toBe(100);
        await expect(cycle()).resolves.toBe(true);
        await expect(cycle()).resolves.toBe(false);
      });
      await app.start();
      await runtime.start();
      await expect(runtime.completion).resolves.toBeUndefined();
      expect(adapter.reserveActivityDispatches).toHaveBeenCalledTimes(2);
    } finally {
      polling.mockRestore();
      await runtime.stop().catch(() => undefined);
      await app.dispose().catch(() => undefined);
    }
  });

  it("identifies the workflow drain to the application shutdown coordinator", async () => {
    const app = new App({});
    const wait = vi.spyOn(app.shutdown, "wait");
    const runtime = new WorkflowRuntime(app, new MemoryWorkflowAdapter(), { error: vi.fn() } as never);
    try {
      await runtime.stop();
      expect(wait).toHaveBeenCalledExactlyOnceWith("workflow drain", expect.any(Function));
    } finally { await app.dispose(); }
  });

  it("rejects startup if independently owned scheduler polling has already failed", async () => {
    const app = new App({});
    const adapter = new MemoryWorkflowAdapter();
    const failure = new Error("scheduler unavailable");
    vi.spyOn(adapter, "reserveTasks").mockRejectedValue(failure);
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never);
    try {
      await app.start();
      await expect(runtime.scheduler.run(new AbortController().signal)).rejects.toBe(failure);
      await expect(runtime.start()).rejects.toBe(failure);
    } finally { await runtime.stop().catch(() => undefined); await app.dispose().catch(() => undefined); }
  });

  it.each(["both", "worker", "client"] as const)("rejects an outbox runtime missing %s of its Worker transport", async (missing) => {
    const app = new App({});
    const registerDrain = vi.spyOn(app.shutdown, "registerDrain");
    try {
      expect(() => new WorkflowRuntime(app, new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" }), { error: vi.fn() } as never, {},
        missing === "client" ? createWorkflowActivityWorker(app) : undefined,
        missing === "worker" ? new WorkerClient(new MemoryWorkerAdapter()) : undefined))
        .toThrow("Outbox workflow activities require a Worker client and activity Worker.");
      expect(registerDrain).not.toHaveBeenCalled();
    } finally { await app.dispose(); }
  });
});
