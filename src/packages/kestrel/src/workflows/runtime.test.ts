import { describe, expect, it, vi } from "vitest";

import { App, defineCatalog } from "../app/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowClient } from "./client.js";
import { WorkflowRuntime } from "./runtime.js";
import { defineWorkflow } from "./workflow.js";

describe("WorkflowRuntime", () => {
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
