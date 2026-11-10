import { describe, expect, it } from "vitest";

import type { ReservedWorkflowTask } from "../../adapter.js";
import { MemoryWorkflowAdapter } from "./adapter.js";

const epoch = new Date("2026-01-01T00:00:00.000Z");
const ref = (task: ReservedWorkflowTask) => ({ taskId: task.id, reservationToken: task.reservationToken });

/** The public reservation API supplies genuine generation tokens and observable task snapshots. */
async function setup() {
  let now = epoch;
  let sequence = 0;
  const adapter = new MemoryWorkflowAdapter({ now: () => now, createTaskId: () => `task-${++sequence}`, createReservationToken: () => `token-${++sequence}` });
  for (const executionId of ["first", "second", "unrelated"]) {
    await adapter.start({ executionId, workflowName: "ownership.run", workflowVersion: 1, input: null });
  }
  const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 3, leaseMs: 1_000 });
  return { adapter, tasks, advance: (milliseconds: number) => { now = new Date(epoch.getTime() + milliseconds); } };
}

describe("MemoryWorkflowAdapter task reservation ownership", () => {
  it("releases only matching generations in input order and preserves unrelated work", async () => {
    const { adapter, tasks, advance } = await setup();
    const [first, second, unrelated] = tasks as [ReservedWorkflowTask, ReservedWorkflowTask, ReservedWorkflowTask];
    const unrelatedBefore = adapter.inspectTasks().find(({ id }) => id === unrelated.id);
    const unrelatedExecution = await adapter.get(unrelated.executionId);
    advance(10);
    const result = await adapter.releaseTasks([
      { taskId: "missing-task", reservationToken: "missing-token" },
      { taskId: first.id, reservationToken: second.reservationToken },
      ref(second), ref(first), ref(second),
    ]);
    expect(result).toEqual([ref(second), ref(first)]);
    for (const task of [first, second]) {
      const stored = adapter.inspectTasks().find(({ id }) => id === task.id)!;
      expect(stored.availableAt).toEqual(new Date(epoch.getTime() + 10));
      expect(stored).not.toHaveProperty("reservationToken");
      expect(stored).not.toHaveProperty("reservedAt");
      expect(await adapter.get(task.executionId)).toMatchObject({ status: "queued", updatedAt: new Date(epoch.getTime() + 10) });
    }
    expect(adapter.inspectTasks().find(({ id }) => id === unrelated.id)).toEqual(unrelatedBefore);
    expect(await adapter.get(unrelated.executionId)).toEqual(unrelatedExecution);
  });

  it("renews owned generations without changing their tokens, reservation times or execution state", async () => {
    const { adapter, tasks, advance } = await setup();
    const [first, second, unrelated] = tasks as [ReservedWorkflowTask, ReservedWorkflowTask, ReservedWorkflowTask];
    const beforeTasks = adapter.inspectTasks();
    const beforeExecutions = await Promise.all(tasks.map(({ executionId }) => adapter.get(executionId)));
    advance(50);
    expect(await adapter.extendTaskLeases([
      { taskId: first.id, reservationToken: second.reservationToken, leaseMs: 100 },
      { taskId: "missing-task", reservationToken: "missing-token", leaseMs: 100 },
      { ...ref(second), leaseMs: 2_000 }, { ...ref(first), leaseMs: 1 },
    ])).toEqual([ref(second), ref(first)]);
    const expected = beforeTasks.map((task) => task.id === first.id
      ? { ...task, availableAt: new Date(epoch.getTime() + 51) }
      : task.id === second.id ? { ...task, availableAt: new Date(epoch.getTime() + 2_050) } : task);
    expect(adapter.inspectTasks()).toEqual(expected);
    expect(adapter.inspectTasks().find(({ id }) => id === unrelated.id)).toEqual(beforeTasks.find(({ id }) => id === unrelated.id));
    expect(await Promise.all(tasks.map(({ executionId }) => adapter.get(executionId)))).toEqual(beforeExecutions);
  });

  it("cannot mutate an old generation after another owner recovers the task", async () => {
    const { adapter, tasks, advance } = await setup();
    advance(1_001);
    const recovered = await adapter.reserveTasks({ kinds: ["workflow"], limit: 3, leaseMs: 1_000 });
    expect(recovered.map(({ reservationToken }) => reservationToken)).not.toEqual(tasks.map(({ reservationToken }) => reservationToken));
    const before = adapter.inspectTasks();
    expect(await adapter.releaseTasks(tasks.map(ref))).toEqual([]);
    expect(await adapter.extendTaskLeases(tasks.map((task) => ({ ...ref(task), leaseMs: 2_000 })))).toEqual([]);
    expect(adapter.inspectTasks()).toEqual(before);
  });

  it("returns empty results for empty batches without changing reservations", async () => {
    const { adapter } = await setup();
    const before = adapter.inspectTasks();
    expect(await adapter.releaseTasks([])).toEqual([]);
    expect(await adapter.extendTaskLeases([])).toEqual([]);
    expect(adapter.inspectTasks()).toEqual(before);
  });

  it("releases activity and timer tasks without queueing or retimestamping the waiting execution", async () => {
    let now = epoch;
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    await adapter.start({ executionId: "commands", workflowName: "ownership.run", workflowVersion: 1, input: null });
    const [activation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await adapter.commitActivation({ ...ref(activation!), executionId: "commands", expectedRevision: 0,
      commands: [{ kind: "activity", sequence: 0, target: "activity.run", payload: null }, { kind: "timer", sequence: 1, target: "timer", payload: { durationMs: 0 } }],
      outcome: { status: "waiting" },
    });
    const tasks = await adapter.reserveTasks({ kinds: ["activity", "timer"], limit: 2, leaseMs: 1_000 });
    expect(new Set(tasks.map(({ kind }) => kind))).toEqual(new Set(["activity", "timer"]));
    const before = await adapter.get("commands");
    now = new Date(epoch.getTime() + 50);
    expect(await adapter.releaseTasks(tasks.map(ref))).toEqual(tasks.map(ref));
    expect(await adapter.get("commands")).toEqual(before);
    for (const task of tasks) {
      expect(adapter.inspectTasks().find(({ id }) => id === task.id)).toMatchObject({ availableAt: now });
    }
  });

  for (const leaseMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid owned lease duration ${leaseMs} without changing the task`, async () => {
      const { adapter, tasks } = await setup();
      const before = adapter.inspectTasks();
      await expect(adapter.extendTaskLeases([{ ...ref(tasks[0]!), leaseMs }])).rejects.toThrow(TypeError);
      expect(adapter.inspectTasks()).toEqual(before);
    });
  }
});
