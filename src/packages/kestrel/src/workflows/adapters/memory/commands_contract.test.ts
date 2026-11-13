import { describe, expect, it } from "vitest";

import { type ReservedWorkflowTask, WorkflowExecutionConflictError } from "../../index.js";
import { MemoryWorkflowAdapter } from "./index.js";

const now = () => new Date("2026-01-01T12:00:00Z");
const start = (executionId: string, workflowName = "workflow.run") => ({
  executionId, workflowName, workflowVersion: 1, input: null,
});

function reference(task: ReservedWorkflowTask | undefined) {
  if (task === undefined) throw new Error("Expected a workflow activation.");
  return { taskId: task.id, reservationToken: task.reservationToken, executionId: task.executionId };
}

const reserve = (adapter: MemoryWorkflowAdapter) => adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });

describe("MemoryWorkflowAdapter command contracts", () => {
  it("matches a buffered signal once and only removes its own command timer", async () => {
    const adapter = new MemoryWorkflowAdapter({ now });
    const signal = (sequence: number) => ({ sequence, kind: "signal", target: "ready", payload: { timeoutMs: 500 } });
    const send = (executionId: string, signalName: string, payload: string) => adapter.sendSignal({
      executionId, workflowName: "workflow.run", signalName, payload,
    });
    await adapter.start(start("peer"));
    await adapter.commitActivation({
      ...reference((await reserve(adapter))[0]), expectedRevision: 0, commands: [signal(0)], outcome: { status: "waiting" },
    });
    const peerSignal = await send("peer", "ready", "different execution");
    await adapter.start(start("main"));
    const otherSignal = await send("main", "unrelated", "different name");
    const first = await send("main", "ready", "first");

    const task = (await reserve(adapter)).find(({ executionId }) => executionId === "main");
    await expect(adapter.commitActivation({
      ...reference(task), expectedRevision: 2, outcome: { status: "waiting" },
      commands: [
        signal(0), signal(1), { sequence: 2, kind: "activity", target: "unrelated", payload: null },
        { sequence: 3, kind: "timer", target: "ignored", payload: { durationMs: 900 } },
      ],
    })).resolves.toBe(true);

    const completions = async () => (await adapter.getHistory("main")).filter(({ type }) => type === "command-completed");
    expect(await completions()).toMatchObject([{ sequence: 0, sourceId: first.id, result: "first" }]);
    expect(adapter.inspectSignals().map(({ id, consumedBySequence }) => ({ id, consumedBySequence }))).toEqual([
      { id: peerSignal.id, consumedBySequence: undefined },
      { id: otherSignal.id, consumedBySequence: undefined },
      { id: first.id, consumedBySequence: 0 },
    ]);
    // Both the peer's same-sequence timer and the other commands remain scheduled.
    expect(adapter.inspectTasks().filter(({ kind }) => kind !== "workflow").map((task) => [
      task.executionId, task.kind, task.commandSequence, task.target,
    ])).toEqual([
      ["peer", "timer", 0, "signal:ready"],
      ["main", "timer", 1, "signal:ready"],
      ["main", "activity", 2, "unrelated"],
      ["main", "timer", 3, "sleep"],
    ]);

    const replay = (await reserve(adapter)).find(({ executionId }) => executionId === "main");
    await expect(adapter.commitActivation({
      ...reference(replay), expectedRevision: 7, outcome: { status: "waiting" }, commands: [],
    })).resolves.toBe(true);
    expect(await completions()).toHaveLength(1);

    const second = await send("main", "ready", "second");
    const later = (await reserve(adapter)).find(({ executionId }) => executionId === "main");
    await expect(adapter.commitActivation({
      ...reference(later), expectedRevision: 8, outcome: { status: "waiting" }, commands: [],
    })).resolves.toBe(true);
    expect(await completions()).toMatchObject([
      { sequence: 0, sourceId: first.id, result: "first" },
      { sequence: 1, sourceId: second.id, result: "second" },
    ]);
  });

  it("keeps one parent completion for an already settled child command", async () => {
    let next = 0;
    let failWake = false;
    const adapter = new MemoryWorkflowAdapter({ now, createTaskId: () => {
      if (failWake) throw new Error("The existing child completion must not allocate another wake.");
      return `task-${++next}`;
    } });
    await adapter.start(start("parent"));
    await adapter.commitActivation({
      ...reference((await reserve(adapter))[0]), expectedRevision: 0, outcome: { status: "waiting" },
      commands: [{
        sequence: 0, kind: "child", target: "workflow.child", payload: { executionId: "first", version: 1, input: null },
      }],
    });
    // A second low-level execution can carry the same retained parent link.
    await adapter.start({ ...start("second", "workflow.child"), parentExecutionId: "parent", parentCommandSequence: 0 });
    const children = await reserve(adapter);
    const settle = (executionId: string) => adapter.commitActivation({
      ...reference(children.find((child) => child.executionId === executionId)),
      expectedRevision: 0, commands: [], outcome: { status: "completed" },
    });
    await expect(settle("first")).resolves.toBe(true);
    const history = await adapter.getHistory("parent");
    expect(history).toMatchObject([{ type: "command-scheduled" }, { type: "command-completed", sequence: 0 }]);
    expect(history[1]).not.toHaveProperty("result");
    expect(history[1]).not.toHaveProperty("sourceId");
    const [wake] = await reserve(adapter);
    await adapter.commitActivation({
      ...reference(wake), expectedRevision: 2, commands: [], outcome: { status: "waiting" },
    });

    failWake = true;
    await expect(settle("second")).resolves.toBe(true);
    await expect(adapter.getHistory("parent")).resolves.toEqual(history);
    await expect(reserve(adapter)).resolves.toEqual([]);
  });

  it("records only one completion when cancelling two pending children with the same low-level link", async () => {
    const adapter = new MemoryWorkflowAdapter({ now });
    const concurrency = { keyed: { key: "shared", limit: 1, conflict: "enqueue", scope: "execution" } } as const;
    await adapter.startMany([
      start("parent"),
      { ...start("holder", "workflow.child"), concurrency },
      { ...start("first", "workflow.child"), concurrency, parentExecutionId: "parent", parentCommandSequence: 0 },
      { ...start("second", "workflow.child"), concurrency, parentExecutionId: "parent", parentCommandSequence: 0 },
    ]);
    await expect(adapter.requestCancellation("parent")).resolves.toBe(true);
    expect((await adapter.getHistory("parent")).filter(({ type }) => type === "command-completed")).toMatchObject([
      { sequence: 0, error: { name: "WorkflowCancellationError", details: { executionId: "first" } } },
    ]);
    await expect(adapter.get("second")).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects reusing an otherwise compatible child ID linked to a different parent", async () => {
    const adapter = new MemoryWorkflowAdapter({ now });
    await adapter.startMany([
      start("parent"),
      { ...start("child", "workflow.child"), parentExecutionId: "another-parent", parentCommandSequence: 0 },
    ]);
    const task = (await reserve(adapter)).find(({ executionId }) => executionId === "parent");
    await expect(adapter.commitActivation({
      ...reference(task), expectedRevision: 0, outcome: { status: "waiting" },
      commands: [{
        sequence: 0, kind: "child", target: "workflow.child", payload: { executionId: "child", version: 1, input: null },
      }],
    })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    await expect(adapter.getHistory("parent")).resolves.toEqual([]);
  });

  it("retries a child from its original input after the child's journal rotates", async () => {
    const adapter = new MemoryWorkflowAdapter({ now });
    await adapter.start(start("parent"));
    await adapter.commitActivation({
      ...reference((await reserve(adapter))[0]), expectedRevision: 0, outcome: { status: "waiting" },
      commands: [{
        sequence: 0, kind: "child", target: "workflow.child",
        payload: { executionId: "child", version: 1, input: { initial: true } },
      }],
    });
    await expect(adapter.continueAsNew({
      ...reference((await reserve(adapter))[0]), expectedRevision: 0, workflowVersion: 2, input: { initial: false },
    })).resolves.toBe(true);
    adapter.failExecution("child", { name: "WorkflowError", message: "Failed in the second generation." });

    await expect(adapter.retryExecution({ executionId: "retry", sourceExecutionId: "child", workflowVersion: 2 }))
      .resolves.toMatchObject({ created: true, execution: { input: { initial: true } } });
  });

  it("only publishes a parent completion for distinct executions with a command link", async () => {
    const adapter = new MemoryWorkflowAdapter({ now });
    await adapter.startMany([
      start("parent"),
      { ...start("unlinked"), parentExecutionId: "parent" },
      { ...start("self-linked"), parentExecutionId: "self-linked", parentCommandSequence: 0 },
    ]);
    const tasks = await reserve(adapter);
    for (const executionId of ["unlinked", "self-linked"]) {
      const task = tasks.find((candidate) => candidate.executionId === executionId);
      await expect(adapter.commitActivation({
        ...reference(task), expectedRevision: 0, commands: [], outcome: { status: "completed" },
      })).resolves.toBe(true);
      await expect(adapter.get(executionId)).resolves.toMatchObject({ status: "completed", revision: 0 });
    }
    await expect(adapter.getHistory("parent")).resolves.toEqual([]);
    await expect(adapter.getHistory("self-linked")).resolves.toEqual([]);
  });

  it("counts retained child permits only within the matching definition and key", async () => {
    const adapter = new MemoryWorkflowAdapter({ now });
    const keyed = { key: "shared", limit: 1, scope: "execution", conflict: "enqueue" } as const;
    await adapter.startMany([
      start("parent"),
      { ...start("other-key", "workflow.child"), concurrency: { keyed: { ...keyed, key: "different" } } },
      { ...start("other-definition", "workflow.other"), concurrency: { keyed } },
      { ...start("unkeyed", "workflow.child"), concurrency: { definitionLimit: 5 } },
      start("unconfigured", "workflow.child"),
    ]);
    const parent = (await reserve(adapter)).find(({ executionId }) => executionId === "parent");
    await expect(adapter.commitActivation({
      ...reference(parent), expectedRevision: 0, outcome: { status: "waiting" },
      commands: ["first", "second"].map((executionId, sequence) => ({
        sequence, kind: "child", target: "workflow.child",
        payload: { executionId, version: 1, input: null, concurrency: { keyed } },
      })),
    })).resolves.toBe(true);
    await expect(adapter.get("first")).resolves.toMatchObject({ status: "queued", concurrencyAdmitted: true });
    await expect(adapter.get("second")).resolves.toMatchObject({ status: "pending", concurrencyAdmitted: false });
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "second")).toEqual([]);
  });
});

describe("MemoryWorkflowAdapter retained permit release", () => {
  it("wakes the oldest matching execution while other permit groups remain pending", async () => {
    let clock = now();
    const adapter = new MemoryWorkflowAdapter({ now: () => clock });
    const keyed = { key: "shared", limit: 1, scope: "execution", conflict: "enqueue" } as const;
    const concurrency = { keyed };
    const other = { keyed: { ...keyed, key: "different" } };
    await adapter.startMany([
      { ...start("active"), concurrency },
      { ...start("other-key-active"), concurrency: other },
      { ...start("other-definition-active", "workflow.other"), concurrency },
      { ...start("other-key-waiting"), concurrency: other },
      { ...start("other-definition-waiting", "workflow.other"), concurrency },
      { ...start("unkeyed"), concurrency: { definitionLimit: 5 } },
      start("unconfigured"),
    ]);
    clock = new Date(now().getTime() + 20);
    await adapter.start({ ...start("later"), concurrency });
    // Admission follows durable creation times even when the clock steps backward.
    clock = new Date(now().getTime() + 10);
    await adapter.start({ ...start("earlier"), concurrency });
    await expect(adapter.forceTerminate("active", "Maintenance.")).resolves.toBe(true);

    await expect(adapter.get("earlier")).resolves.toMatchObject({ status: "queued", concurrencyAdmitted: true });
    for (const executionId of ["later", "other-key-waiting", "other-definition-waiting"]) {
      await expect(adapter.get(executionId)).resolves.toMatchObject({ status: "pending", concurrencyAdmitted: false });
    }
    expect(adapter.inspectTasks().map(({ executionId }) => executionId)).toContain("earlier");
    await adapter.forceTerminate("earlier", "Maintenance.");
    await expect(adapter.get("later")).resolves.toMatchObject({ status: "queued", concurrencyAdmitted: true });
  });
});
