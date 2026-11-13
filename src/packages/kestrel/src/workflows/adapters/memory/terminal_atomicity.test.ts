import { expect, it } from "vitest";

import { MemoryWorkflowAdapter } from "./index.js";

it.each(["cancel", "resume"] as const)("preserves a waiting execution when its %s wake cannot be allocated", async (operation) => {
  let next = 0;
  let failWake = false;
  const failure = new Error("No workflow task ID available.");
  const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
    if (failWake) throw failure;
    return `task-${++next}`;
  } });
  const executionId = "waiting";
  await adapter.start({ executionId, workflowName: "workflow.waiting", workflowVersion: 1, input: null });
  const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
  await adapter.commitActivation({
    taskId: task!.id, reservationToken: task!.reservationToken, executionId, expectedRevision: 0,
    commands: [{ sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 60_000 } }],
    outcome: { status: "waiting" },
  });
  if (operation === "resume") await adapter.setPaused(executionId, true);
  const transition = () => operation === "cancel" ? adapter.requestCancellation(executionId) : adapter.setPaused(executionId, false);
  const execution = await adapter.get(executionId);
  const history = await adapter.getHistory(executionId);
  const tasks = adapter.inspectTasks();

  failWake = true;
  await expect(transition()).rejects.toBe(failure);
  await expect(adapter.get(executionId)).resolves.toEqual(execution);
  await expect(adapter.getHistory(executionId)).resolves.toEqual(history);
  expect(adapter.inspectTasks()).toEqual(tasks);

  failWake = false;
  await expect(transition()).resolves.toBe(true);
  await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 }))
    .resolves.toMatchObject([{ executionId }]);
});

it.each(["cancel", "commit"] as const)("keeps %s of a parent and its waiting child retryable when the child's wake fails", async (operation) => {
  let next = 0;
  let allocationsBeforeFailure = Infinity;
  const failure = new Error("No child wake ID available.");
  const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
    if (--allocationsBeforeFailure === 0) throw failure;
    return `task-${++next}`;
  } });
  const executionIds = ["parent", "child"];
  await adapter.start({ executionId: "parent", workflowName: "workflow.parent", workflowVersion: 1, input: null });
  const reserve = async () => (await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 }))[0]!;
  for (const executionId of executionIds) {
    const task = await reserve();
    await adapter.commitActivation({
      taskId: task.id, reservationToken: task.reservationToken, executionId, expectedRevision: 0,
      commands: executionId === "parent" ? [{
        sequence: 0, kind: "child", target: "workflow.child", payload: { executionId: "child", version: 1, input: null },
      }] : [],
      outcome: { status: "waiting" },
    });
  }
  let transition = () => adapter.requestCancellation("parent");
  if (operation === "commit") {
    await adapter.sendSignal({ executionId: "parent", workflowName: "workflow.parent", signalName: "ready", payload: null });
    const task = await reserve();
    transition = () => adapter.commitActivation({
      taskId: task.id, reservationToken: task.reservationToken, executionId: "parent", expectedRevision: 2,
      commands: [], outcome: { status: "completed" },
    });
  }
  const state = async () => ({
    executions: await Promise.all(executionIds.map((id) => adapter.get(id))),
    histories: await Promise.all(executionIds.map((id) => adapter.getHistory(id))),
    tasks: adapter.inspectTasks(),
  });
  const before = await state();

  allocationsBeforeFailure = operation === "cancel" ? 2 : 1;
  await expect(transition()).rejects.toBe(failure);
  expect(await state()).toEqual(before);

  allocationsBeforeFailure = Infinity;
  await expect(transition()).resolves.toBe(true);
  const after = await state();
  expect(after.executions).toMatchObject([
    operation === "cancel" ? { cancellationRequested: true } : { status: "completed" },
    { executionId: "child", cancellationRequested: true },
  ]);
  expect(after.tasks.map(({ executionId }) => executionId).sort()).toEqual(operation === "cancel" ? ["child", "parent"] : ["child"]);
});

it("leaves every embedded completion retryable when a later wake allocation fails", async () => {
  let next = 0;
  let allocationsBeforeFailure = Infinity;
  const failure = new Error("No workflow task ID available.");
  const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
    if (--allocationsBeforeFailure === 0) throw failure;
    return `task-${++next}`;
  } });
  const executionIds = ["first", "second"];
  await adapter.startMany(executionIds.map((executionId) => ({ executionId, workflowName: "workflow.batch", workflowVersion: 1, input: null })));
  for (const task of await adapter.reserveTasks({ kinds: ["workflow"], limit: 2, leaseMs: 1_000 })) {
    await adapter.commitActivation({
      taskId: task.id, reservationToken: task.reservationToken, executionId: task.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "test.activity", payload: null }], outcome: { status: "waiting" },
    });
  }
  const tasks = await adapter.reserveTasks({ kinds: ["activity"], limit: 2, leaseMs: 1_000 });
  const requests = tasks.map(({ id: taskId, reservationToken, executionId }) => ({ taskId, reservationToken, executionId, sequence: 0, status: "completed", result: null } as const));
  const state = async () => ({
    executions: await Promise.all(executionIds.map((id) => adapter.get(id))),
    histories: await Promise.all(executionIds.map((id) => adapter.getHistory(id))),
    tasks: adapter.inspectTasks(),
  });
  const before = await state();

  allocationsBeforeFailure = 2;
  await expect(adapter.completeActivities(requests)).rejects.toBe(failure);
  expect(await state()).toEqual(before);

  allocationsBeforeFailure = Infinity;
  await expect(adapter.completeActivities(requests)).resolves.toEqual(tasks.map(({ id: taskId, reservationToken }) => ({ taskId, reservationToken })));
  for (const id of executionIds) {
    expect((await adapter.getHistory(id)).at(-1)).toMatchObject({ type: "command-completed", sequence: 0, result: null });
  }
});

it.each(["activation", "termination", "pending cancellation"] as const)(
  "leaves the child and parent retryable when wake allocation fails during %s",
  async (operation) => {
    let next = 0;
    let failWake = false;
    const failure = new Error("No workflow task ID available.");
    const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
      if (failWake) throw failure;
      return `task-${++next}`;
    } });
    await adapter.start({ executionId: "parent", workflowName: "workflow.parent", workflowVersion: 1, input: null });
    const reserve = () => adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });
    const [parent] = await reserve();
    const concurrency = { keyed: { key: "group", limit: 1, conflict: "enqueue", scope: "execution" } };
    await adapter.commitActivation({
      taskId: parent!.id, reservationToken: parent!.reservationToken, executionId: "parent", expectedRevision: 0,
      commands: ["active-child", "pending-child"].map((executionId, sequence) => ({
        sequence, kind: "child", target: "workflow.child", payload: { executionId, version: 1, input: null, concurrency },
      })),
      outcome: { status: "waiting" },
    });
    const [child] = await reserve();
    const childId = operation === "pending cancellation" ? "pending-child" : "active-child";
    const finish = () => {
      if (operation === "pending cancellation") return adapter.requestCancellation(childId);
      if (operation === "termination") return adapter.forceTerminate(childId, "Stopped.");
      return adapter.commitActivation({
        taskId: child!.id, reservationToken: child!.reservationToken, executionId: childId,
        expectedRevision: 0, commands: [], outcome: { status: "completed", output: { ok: true } },
      });
    };
    const state = async () => ({
      child: await adapter.get(childId), parent: await adapter.get("parent"),
      history: await adapter.getHistory("parent"), tasks: adapter.inspectTasks(),
    });
    const before = await state();

    failWake = true;
    await expect(finish()).rejects.toBe(failure);
    expect(await state()).toEqual(before);

    // The same request can record one completion and queue the parent on retry.
    failWake = false;
    await expect(finish()).resolves.toBe(true);
    const history = await adapter.getHistory("parent");
    expect(history).toHaveLength(before.history.length + 1);
    const completion = history.at(-1);
    if (operation === "activation") {
      expect(completion).toMatchObject({ type: "command-completed", sequence: 0, result: { ok: true } });
    } else if (operation === "termination") {
      expect(completion).toMatchObject({ type: "command-completed", sequence: 0, error: {
        name: "WorkflowExecutionTerminatedError", message: "Stopped.",
      } });
    } else {
      expect(completion).toMatchObject({ type: "command-completed", sequence: 1, error: {
        name: "WorkflowCancellationError", message: `Child workflow "${childId}" cancelled.`,
        details: { executionId: childId },
      } });
    }
    expect((await reserve()).map(({ executionId }) => executionId)).toContain("parent");
  },
);

it("does not allocate a parent wake while the child still has to handle cancellation", async () => {
  let next = 0;
  let failWake = false;
  const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
    if (failWake) throw new Error("Unexpected workflow task ID allocation.");
    return `task-${++next}`;
  } });
  await adapter.start({ executionId: "parent", workflowName: "workflow.parent", workflowVersion: 1, input: null });
  const [parent] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
  await adapter.commitActivation({
    taskId: parent!.id, reservationToken: parent!.reservationToken, executionId: "parent", expectedRevision: 0,
    commands: [{
      sequence: 0, kind: "child", target: "workflow.child", payload: { executionId: "child", version: 1, input: null },
    }],
    outcome: { status: "waiting" },
  });

  // The existing child task can deliver the cancellation without waking its parent.
  failWake = true;
  await expect(adapter.requestCancellation("child")).resolves.toBe(true);
  await expect(adapter.get("child")).resolves.toMatchObject({ status: "queued", cancellationRequested: true });
  await expect(adapter.get("parent")).resolves.toMatchObject({ status: "waiting", revision: 1 });
  expect(adapter.inspectTasks()).toMatchObject([{ executionId: "child", kind: "workflow" }]);
});
