import { describe, expect, it } from "vitest";

import { WorkflowExecutionNotFoundError } from "../../index.js";
import type { WorkflowPayload } from "../../serialization.js";
import { MemoryWorkflowAdapter } from "./index.js";

const start = {
  executionId: "workflow-1",
  workflowName: "workflow.run",
  workflowVersion: 1,
  input: null,
} as const;

async function reserveActivation(adapter: MemoryWorkflowAdapter) {
  const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
  if (task === undefined) throw new Error("Expected a workflow activation.");
  return { taskId: task.id, reservationToken: task.reservationToken, executionId: task.executionId };
}

describe("MemoryWorkflowAdapter projections", () => {
  it("returns detached output, dates, errors and concurrency metadata across execution reads", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const concurrency = { keyed: { key: "account", limit: 1, conflict: "enqueue", scope: "execution" } } as const;
    const expectedConcurrency = structuredClone(concurrency);
    const failedId = "failed";
    await adapter.startMany([start, { ...start, executionId: failedId, concurrency }]);
    await adapter.setPaused(failedId, true);

    const task = await reserveActivation(adapter);
    await expect(adapter.commitActivation({
      ...task, expectedRevision: 0, commands: [], outcome: { status: "completed", output: { total: 3 } },
    })).resolves.toBe(true);
    adapter.failExecution(failedId, { name: "ActivityTimeout", message: "Timed out.", details: { sequence: 2 } });

    const completed = await adapter.get(start.executionId);
    const failed = await adapter.get(failedId);
    // Consumers can modify a projection without mutating the durable execution.
    (completed!.output as { total: number }).total = 99;
    completed!.completedAt!.setTime(0);
    failed!.pausedAt!.setTime(0);
    failed!.error!.message = "Edited.";
    failed!.error!.details!.sequence = 99;
    Reflect.set(failed!.concurrency!.keyed!, "limit", 99);

    await expect(adapter.get(start.executionId)).resolves.toMatchObject({
      status: "completed", output: { total: 3 }, completedAt: now,
    });
    await expect(adapter.get(failedId)).resolves.toMatchObject({
      status: "failed", pausedAt: now, concurrency: expectedConcurrency,
      error: { name: "ActivityTimeout", message: "Timed out.", details: { sequence: 2 } },
    });
  });

  it("preserves failed command metadata and leaves an absent result omitted", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    await adapter.start(start);
    await adapter.commitActivation({
      ...await reserveActivation(adapter), expectedRevision: 0, outcome: { status: "waiting" },
      commands: [0, 1].map((sequence) => ({ sequence, kind: "activity", target: "workflow.activity", payload: null })),
    });
    const error = { name: "ActivityTimeout", message: "Timed out.", details: { sequence: 1 } };
    await expect(adapter.completeExternalActivity({
      executionId: start.executionId, sequence: 0, status: "completed", sourceId: "worker-0",
    })).resolves.toBe(true);
    await expect(adapter.completeExternalActivity({
      executionId: start.executionId, sequence: 1, status: "failed", sourceId: "worker-1", error,
    })).resolves.toBe(true);

    const history = await adapter.getHistory(start.executionId);
    const completed = history.filter((event) => event.type === "command-completed");
    expect(completed).toHaveLength(2);
    expect(completed[0]).not.toHaveProperty("result");
    expect(completed[0]).not.toHaveProperty("error");
    expect(completed[1]).not.toHaveProperty("result");
    expect(completed[1]!.error).toEqual(error);
    completed[1]!.error!.message = "Edited.";
    completed[1]!.error!.details!.sequence = 99;
    const reread = await adapter.getHistory(start.executionId);
    expect(reread[3]).toMatchObject({ type: "command-completed", sequence: 1, error });
  });

  it("reports the pending command even when an earlier journal event is a signal", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(start);
    await adapter.sendSignal({
      executionId: start.executionId, workflowName: start.workflowName, signalName: "ready", payload: null,
    });
    await expect(adapter.commitActivation({
      ...await reserveActivation(adapter), expectedRevision: 1, outcome: { status: "waiting" },
      commands: [{ sequence: 0, kind: "activity", target: "workflow.activity", payload: null }],
    })).resolves.toBe(true);
    await adapter.sendSignal({
      executionId: start.executionId, workflowName: start.workflowName, signalName: "retry", payload: null,
    });
    const task = await reserveActivation(adapter);
    await expect(adapter.continueAsNew({ ...task, expectedRevision: 3, workflowVersion: 2, input: null }))
      .rejects.toThrow("cannot continue as new with pending command 0");
    await expect(adapter.getHistoryArchives(start.executionId)).resolves.toEqual([]);
    await expect(adapter.getHistory("unknown-execution")).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
  });
});

describe("MemoryWorkflowAdapter validation", () => {
  it("requires record payloads even when command fields are optional", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(start);
    const task = await reserveActivation(adapter);
    const activate = (kind: string, payload: WorkflowPayload) => adapter.commitActivation({
      ...task, expectedRevision: 0, outcome: { status: "waiting" },
      commands: [{ sequence: 0, kind, target: "ready", payload }],
    });

    // A signal without a timeout is valid, but a non-record payload is malformed.
    for (const payload of [[], "ready", null]) {
      await expect(activate("signal", payload)).rejects.toThrow("Workflow command payload must be an object.");
    }
    for (const concurrency of [[], "account", null]) {
      await expect(activate("child", { version: 1, input: null, concurrency }))
        .rejects.toThrow("Workflow child concurrency must be an object.");
    }
    for (const keyed of [[], "account", null]) {
      await expect(activate("child", { version: 1, input: null, concurrency: { keyed } }))
        .rejects.toThrow("Workflow keyed concurrency must be an object.");
    }
    await expect(adapter.getHistory(start.executionId)).resolves.toEqual([]);
    await expect(activate("signal", {})).resolves.toBe(true);
    expect(adapter.inspectTasks()).toEqual([]);
  });

  it("preserves optional child concurrency fields and normalizes retained conflicts", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(start);
    const metadata = [
      { definitionLimit: 1 },
      { keyed: { key: "account", limit: 1, conflict: "return-existing", scope: "active-work" } },
      { keyed: { key: "account", limit: 1, conflict: "reject", scope: "execution" } },
    ] as const satisfies readonly WorkflowPayload[];
    const commands = metadata.map((concurrency, sequence) => ({
      sequence, kind: "child", target: "workflow.child",
      payload: { input: null, version: 1, executionId: `child-${sequence}`, concurrency },
    }));
    await expect(adapter.commitActivation({
      ...await reserveActivation(adapter), expectedRevision: 0, outcome: { status: "waiting" }, commands,
    })).resolves.toBe(true);

    const results = await Promise.all(commands.map(({ payload }) => adapter.get(payload.executionId)));
    expect(results.map((child) => child?.concurrency)).toStrictEqual([
      metadata[0],
      { keyed: { ...metadata[1].keyed, conflict: "enqueue" } },
      { keyed: { ...metadata[2].keyed, conflict: "enqueue" } },
    ]);
  });

  it("counts active-work leases independently for each workflow definition and key", async () => {
    let id = 0;
    const adapter = new MemoryWorkflowAdapter({
      now: () => new Date("2026-01-01T00:00:00Z"),
      createTaskId: () => `task-${++id}`,
    });
    const keyed = { key: "account", limit: 2, conflict: "enqueue", scope: "active-work" } as const;
    await adapter.startMany([
      { ...start, executionId: "first", concurrency: { keyed } },
      { ...start, executionId: "second", concurrency: { keyed } },
      { ...start, executionId: "third", concurrency: { keyed } },
      { ...start, executionId: "other-key", concurrency: { keyed: { ...keyed, key: "other" } } },
      { ...start, executionId: "other-definition", workflowName: "workflow.other", concurrency: { keyed } },
    ]);
    const reserve = () => adapter.reserveTasks({ kinds: ["workflow"], limit: 4, leaseMs: 1 });
    const reserved = await reserve();
    expect(reserved.map(({ executionId }) => executionId)).toEqual(["first", "second", "other-key", "other-definition"]);
    await expect(reserve()).resolves.toEqual([]);

    const first = reserved[0]!;
    await adapter.commitActivation({
      taskId: first.id, reservationToken: first.reservationToken, executionId: first.executionId,
      expectedRevision: 0, outcome: { status: "waiting" }, commands: [],
    });
    await expect(reserve()).resolves.toMatchObject([{ executionId: "third", attempt: 1 }]);
  });

  it("does not reserve a queued activity after its execution has failed", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(start);
    await adapter.commitActivation({
      ...await reserveActivation(adapter), expectedRevision: 0, outcome: { status: "waiting" },
      commands: [{ sequence: 0, kind: "activity", target: "workflow.activity", payload: null }],
    });
    adapter.failExecution(start.executionId, { name: "ExternalFailure", message: "Stopped." });

    // The in-memory settlement seam leaves pending task records behind.
    expect(adapter.inspectTasks()).toMatchObject([{ kind: "activity", attempt: 0 }]);
    await expect(adapter.reserveTasks({ kinds: ["activity"], limit: 1, leaseMs: 1 }))
      .resolves.toEqual([]);
  });
});
