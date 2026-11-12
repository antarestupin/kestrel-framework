import { expect, it } from "vitest";

import { MemoryWorkflowAdapter } from "./index.js";

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
