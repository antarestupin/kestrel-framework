import { describe, expect, it, vi } from "vitest";

import { App, defineCatalog } from "../app/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowClient } from "./client.js";
import { WorkflowRuntime } from "./runtime.js";
import { defineWorkflow } from "./workflow.js";

describe("WorkflowRuntime", () => {
  it("resumes useful workflow processing after a transient reservation failure", async () => {
    const workflow = defineWorkflow({ name: "runtime.recovery", handler: () => undefined });
    const app = new App({}, { catalog: defineCatalog({ runtime: { workflows: { workflow } } }) });
    const adapter = new MemoryWorkflowAdapter();
    const failure = new Error("temporary reservation failure");
    const original = adapter.reserveTasks.bind(adapter);
    const reserve = vi.spyOn(adapter, "reserveTasks").mockRejectedValueOnce(failure).mockImplementation(original);
    const runtime = new WorkflowRuntime(app, adapter, { error: vi.fn() } as never, {
      polling: { initialBackoffMs: 1, maxBackoffMs: 1, isRecoverable: (error) => error === failure },
    });
    await app.start();
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    try {
      await runtime.start();
      await vi.waitFor(async () => expect(await handle.status()).toMatchObject({ status: "completed" }));
      expect(reserve.mock.calls.length).toBeGreaterThan(1);
      expect(runtime.state.scheduler.successfulCycles).toBeGreaterThan(0);
    } finally { await runtime.stop(); await app.dispose(); }
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
      await expect(background.run([])).rejects.toThrow();
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
      });
    } finally {
      await app.dispose();
    }
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
});
