import { describe, expect, it } from "vitest";

import { WorkflowExecutionNotFoundError } from "../../errors.js";
import { MemoryWorkflowAdapter } from "./index.js";

const execution = { executionId: "version-one", workflowName: "invoice.send", workflowVersion: 1 };
const blocked = { name: "WorkflowExecutionVersionUnsupportedError", message: "Version one is not deployed." };

async function commitVersionError(adapter: MemoryWorkflowAdapter, status: "blocked" | "failed") {
  await adapter.start({ ...execution, input: null });
  const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
  await expect(adapter.commitActivation({
    executionId: execution.executionId, taskId: task!.id, reservationToken: task!.reservationToken,
    expectedRevision: 0, commands: [], outcome: { status, error: blocked },
  })).resolves.toBe(true);
}

describe("Memory workflow version recovery", () => {
  it("leaves a blocked execution recoverable when allocating the wake-up fails", async () => {
    const failure = new Error("Workflow task identity is temporarily unavailable.");
    let rejectWakeUp = false;
    let taskNumber = 0;
    const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
      if (rejectWakeUp) throw failure;
      return `task-${++taskNumber}`;
    } });
    await commitVersionError(adapter, "blocked");
    const original = await adapter.get(execution.executionId);

    rejectWakeUp = true;
    await expect(adapter.recoverVersionBlockedExecution(execution)).rejects.toBe(failure);
    await expect(adapter.get(execution.executionId)).resolves.toEqual(original);
    expect(adapter.inspectTasks()).toEqual([]);

    rejectWakeUp = false;
    await expect(adapter.recoverVersionBlockedExecution(execution)).resolves.toBe(true);
    expect(adapter.inspectTasks()).toMatchObject([{ executionId: execution.executionId, kind: "workflow" }]);
  });

  it("does not recover a terminal execution whose failure happens to share the error name", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await commitVersionError(adapter, "failed");
    const failed = await adapter.get(execution.executionId);

    await expect(adapter.recoverVersionBlockedExecution(execution)).resolves.toBe(false);
    await expect(adapter.get(execution.executionId)).resolves.toEqual(failed);
    expect(adapter.inspectTasks()).toEqual([]);
  });

  it("keeps distinct workflow-name and version combinations separate in the inventory", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.startMany([
      { executionId: "short-name", workflowName: "invoice1", workflowVersion: 23, input: null },
      { executionId: "long-name", workflowName: "invoice12", workflowVersion: 3, input: null },
    ]);
    await expect(adapter.summarizeExecutionVersions()).resolves.toEqual([
      { workflowName: "invoice1", workflowVersion: 23, status: "queued", count: 1 },
      { workflowName: "invoice12", workflowVersion: 3, status: "queued", count: 1 },
    ]);
  });

  it("rejects an archive lookup for an unknown execution", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await expect(adapter.getHistoryArchives("missing")).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
  });

  it("keeps an omitted terminal output distinct from explicit null", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start({ ...execution, input: null });
    await adapter.start({ ...execution, executionId: "explicit-output", input: null });

    expect(adapter.completeExecution(execution.executionId)).toBe(true);
    expect(adapter.completeExecution("explicit-output", null)).toBe(true);
    const omitted = await adapter.get(execution.executionId);
    expect(omitted).toMatchObject({ status: "completed" });
    expect(omitted).not.toHaveProperty("output");
    await expect(adapter.get("explicit-output")).resolves.toMatchObject({ status: "completed", output: null });
  });
});
