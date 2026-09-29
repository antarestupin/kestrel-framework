import { describe, expect, it } from "vitest";

import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowVersionOperations } from "./version_operations.js";
import { defineWorkflow } from "./workflow.js";

describe("WorkflowVersionOperations", () => {
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
    await expect(operations.recover("recoverable")).resolves.toBe(true);
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
