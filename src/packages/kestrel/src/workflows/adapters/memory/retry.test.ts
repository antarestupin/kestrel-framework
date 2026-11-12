import { describe, expect, it } from "vitest";

import { MemoryWorkflowAdapter } from "./index.js";

const source = {
  executionId: "invoice-source",
  workflowName: "invoice.send",
  workflowVersion: 1,
  input: { invoiceId: "invoice" },
} as const;

const retry = {
  sourceExecutionId: source.executionId,
  executionId: "invoice-retry",
  workflowVersion: 2,
} as const;

describe("Memory workflow execution retries", () => {
  it("validates the target identity and rejects a live source before creating a retry", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(source);
    const before = adapter.inspectTasks();

    await expect(adapter.retryExecution({ ...retry, executionId: "", sourceExecutionId: "missing" }))
      .rejects.toThrow("Workflow execution IDs cannot be empty.");
    await expect(adapter.retryExecution(retry))
      .rejects.toThrow("Only failed workflow executions can be retried.");
    await expect(adapter.get(retry.executionId)).resolves.toBeUndefined();
    expect(adapter.inspectTasks()).toEqual(before);
  });

  it.each(["reject", "return-existing"] as const)("queues a distinct retry under an occupied %s policy", async (conflict) => {
    const adapter = new MemoryWorkflowAdapter();
    const concurrency = {
      definitionLimit: 2,
      keyed: { key: "invoice", limit: 1, conflict, scope: "execution" as const },
    };
    await adapter.start({ ...source, concurrency });
    const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await adapter.commitActivation({
      executionId: source.executionId, expectedRevision: 0, commands: [],
      taskId: task!.id, reservationToken: task!.reservationToken,
      outcome: { status: "failed", error: { name: "EmailError", message: "Mailbox is unavailable." } },
    });
    const occupiedId = "invoice-occupied";
    await adapter.start({ ...source, executionId: occupiedId, concurrency });

    // Operator retries wait for the original policy's permit with their own durable identity.
    const retried = await adapter.retryExecution(retry);
    expect(retried).toMatchObject({ created: true, execution: {
      executionId: retry.executionId, retryOfExecutionId: source.executionId,
      rootExecutionId: retry.executionId, workflowVersion: 2,
      status: "pending", concurrencyAdmitted: false, concurrency,
    } });
    expect(adapter.inspectTasks().map(({ executionId }) => executionId)).toEqual([occupiedId]);
    await expect(adapter.retryExecution({ ...retry, workflowVersion: 3 })).resolves.toEqual({
      created: false, execution: retried.execution,
    });

    await adapter.forceTerminate(occupiedId);
    expect(adapter.inspectTasks().map(({ executionId }) => executionId)).toEqual([retry.executionId]);
    await expect(adapter.get(retry.executionId)).resolves.toMatchObject({
      status: "queued", concurrencyAdmitted: true, concurrency,
    });
  });
});
