import { describe, expect, it, vi } from "vitest";

import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowExecutionNotFoundError, WorkflowExecutionVersionUnsupportedError } from "./errors.js";
import { WorkflowOperations } from "./operations.js";
import { WorkflowVersionOperations } from "./version_operations.js";
import { defineWorkflow } from "./workflow.js";

describe("WorkflowVersionOperations", () => {
  it("sorts missing and unsupported active versions, preserving each status count", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const definition = defineWorkflow({ name: "alpha", version: { current: 3, supportedFrom: 2 }, handler: () => undefined });
    const summary = (workflowName: string, workflowVersion: number, status: "queued" | "waiting" | "failed" | "cancelled" | "terminated", count: number) =>
      ({ workflowName, workflowVersion, status, count });
    vi.spyOn(adapter, "summarizeExecutionVersions").mockResolvedValue([
      summary("zeta", 1, "queued", 1), summary("alpha", 4, "waiting", 3),
      summary("alpha", 1, "queued", 2), summary("alpha", 4, "queued", 5),
      summary("alpha", 2, "queued", 1), summary("alpha", 3, "waiting", 1),
      summary("missing-failed", 1, "failed", 1), summary("missing-cancelled", 1, "cancelled", 1),
      summary("missing-terminated", 1, "terminated", 1),
    ]);
    const { unsupportedActiveVersions } = await new WorkflowVersionOperations([definition], adapter).inspect();
    expect(unsupportedActiveVersions).toEqual([
      { workflowName: "alpha", workflowVersion: 1, count: 2, statuses: { queued: 2 }, reason: "version-unsupported" },
      { workflowName: "alpha", workflowVersion: 4, count: 8, statuses: { waiting: 3, queued: 5 }, reason: "version-unsupported" },
      { workflowName: "zeta", workflowVersion: 1, count: 1, statuses: { queued: 1 }, reason: "definition-missing" },
    ]);
  });

  it("rejects absent or incompatible executions before asking storage to recover them", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.startMany([
      startRequest("old", "example.versioned", 1),
      startRequest("current", "example.versioned", 3),
      startRequest("future", "example.versioned", 4),
      startRequest("missing", "example.missing", 3),
    ]);
    const definition = defineWorkflow({ name: "example.versioned", version: { current: 3, supportedFrom: 2 }, handler: () => undefined });
    const recover = vi.spyOn(adapter, "recoverVersionBlockedExecution");
    const operations = new WorkflowVersionOperations([definition], adapter);
    await expect(operations.recover("unknown")).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    for (const id of ["old", "future", "missing"]) {
      await expect(operations.recover(id)).rejects.toBeInstanceOf(WorkflowExecutionVersionUnsupportedError);
    }
    expect(recover).not.toHaveBeenCalled();
    await expect(operations.recover("current")).resolves.toBe(false);
    expect(recover).toHaveBeenCalledExactlyOnceWith({ executionId: "current", workflowName: definition.name, workflowVersion: 3 });
  });

  it("reports counts and rejects deployments missing an active version", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest("old", "example.versioned", 1));
    await adapter.start(startRequest("missing", "example.missing", 3));
    adapter.completeExecution("missing", null);
    const current = defineWorkflow({
      name: "example.versioned",
      version: { current: 2, supportedFrom: 2 },
      handler: () => undefined,
    });
    const operations = new WorkflowVersionOperations([current], adapter);

    const inventory = await operations.inspect();
    expect(inventory.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workflowName: "example.versioned",
        workflowVersion: 1,
        count: 1,
      }),
      expect.objectContaining({
        workflowName: "example.missing",
        workflowVersion: 3,
        count: 1,
      }),
    ]));
    expect(inventory.unsupportedActiveVersions).toMatchObject([{
        workflowName: "example.versioned",
        workflowVersion: 1,
        count: 1,
        statuses: { queued: 1 },
        reason: "version-unsupported",
    }]);
    await expect(operations.assertCompatible()).rejects.toMatchObject({
      name: "WorkflowDeploymentVersionError",
      diagnostics: [{ workflowName: "example.versioned", workflowVersion: 1 }],
    });
  });

  it("recovers only a version-blocked execution after compatible code returns", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest("recoverable", "example.versioned", 1));
    const [task] = await adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 1_000,
    });
    const [loaded] = await adapter.loadActivations([{
      taskId: task!.id,
      reservationToken: task!.reservationToken,
    }]);
    const snapshot = loaded?.snapshot;
    await adapter.commitActivation({
      taskId: task!.id,
      reservationToken: task!.reservationToken,
      executionId: "recoverable",
      expectedRevision: snapshot!.revision,
      commands: [],
      outcome: {
        status: "blocked",
        error: {
          name: "WorkflowExecutionVersionUnsupportedError",
          message: "Version one is not deployed.",
        },
      },
    });
    const compatible = defineWorkflow({
      name: "example.versioned",
      version: { current: 2, supportedFrom: 1 },
      handler: () => undefined,
    });
    const operations = new WorkflowVersionOperations([compatible], adapter);

    await expect(operations.assertCompatible()).resolves.toBeDefined();
    await expect(new WorkflowOperations([compatible], adapter).recover("recoverable")).resolves.toBe(true);
    const recovered = await adapter.get("recoverable");
    expect(recovered).toMatchObject({ status: "queued" });
    expect(recovered).not.toHaveProperty("error");
    await expect(operations.recover("recoverable")).resolves.toBe(false);
  });
});

function startRequest(
  executionId: string,
  workflowName: string,
  workflowVersion: number,
) {
  return {
    executionId,
    workflowName,
    workflowVersion,
    input: null,
  };
}
