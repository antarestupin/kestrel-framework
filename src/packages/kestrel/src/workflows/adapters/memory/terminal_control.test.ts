import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { WorkflowExecutionNotFoundError } from "../../errors.js";
import { MemoryWorkflowAdapter } from "./adapter.js";

const epoch = new Date("2026-01-01T00:00:00.000Z");
const start = (executionId: string) => ({ executionId, workflowName: "controls.run", workflowVersion: 1, input: null });

/** Exercise terminal behavior through real start/reserve/commit transitions, not private map writes. */
describe("MemoryWorkflowAdapter terminal controls", () => {
  it("wakes a resumed waiting execution even when its previous activation was consumed", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => epoch });
    await adapter.start(start("waiting"));
    const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await adapter.commitActivation({ taskId: task!.id, reservationToken: task!.reservationToken, executionId: "waiting", expectedRevision: 0, commands: [], outcome: { status: "waiting" } });
    expect(adapter.inspectTasks()).toEqual([]);
    await adapter.setPaused("waiting", true);
    expect(adapter.inspectTasks()).toEqual([]);
    expect(await adapter.setPaused("waiting", false)).toBe(true);
    expect(adapter.inspectTasks()).toMatchObject([{ executionId: "waiting", kind: "workflow" }]);
  });

  it("preserves an existing activation and unrelated activity/timer tasks during cancellation", async () => {
    let sequence = 0;
    const adapter = new MemoryWorkflowAdapter({ now: () => epoch, createTaskId: () => `cancel-task-${++sequence}` });
    for (const id of ["cancelled", "unrelated"]) {
      await adapter.start(start(id));
      const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });
      const task = tasks.find(({ executionId }) => executionId === id)!;
      await adapter.commitActivation({ taskId: task.id, reservationToken: task.reservationToken, executionId: id, expectedRevision: 0,
        commands: [{ kind: "activity", sequence: 0, target: "activity.run", payload: null }, { kind: "timer", sequence: 1, target: "timer", payload: { durationMs: 60_000 } }], outcome: { status: "waiting" } });
    }
    await adapter.sendSignal({ executionId: "cancelled", workflowName: "controls.run", signalName: "wake", payload: null });
    const activation = adapter.inspectTasks().find(({ executionId, kind }) => executionId === "cancelled" && kind === "workflow");
    const unrelated = adapter.inspectTasks().filter(({ executionId }) => executionId === "unrelated");
    expect(unrelated).toHaveLength(2);
    await adapter.requestCancellation("cancelled");
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "unrelated")).toEqual(unrelated);
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "cancelled")).toEqual([activation]);
  });

  it("keeps another execution's outbox work when terminating an execution tree", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => epoch, activityDispatchMode: "outbox" });
    for (const id of ["closed", "unrelated"]) {
      await adapter.start(start(id));
      const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
      await adapter.commitActivation({ taskId: task!.id, reservationToken: task!.reservationToken, executionId: id, expectedRevision: 0,
        commands: [{ kind: "activity", sequence: 0, target: "activity.run", payload: null }], outcome: { status: "waiting" } });
    }
    const unrelated = adapter.inspectActivityDispatches().filter(({ executionId }) => executionId === "unrelated");
    expect(unrelated).toHaveLength(1);
    await adapter.forceTerminate("closed", "close one tree");
    expect(adapter.inspectActivityDispatches()).toEqual(unrelated);
  });

  it("wakes a waiting parent when a pending child is cancelled and another child is terminated", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => epoch });
    const concurrency = { keyed: { key: "child-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
    await adapter.start({ ...start("holder"), workflowName: "child.run", concurrency });
    await adapter.start(start("parent"));
    const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });
    const parent = tasks.find(({ executionId }) => executionId === "parent")!;
    await adapter.commitActivation({ taskId: parent.id, reservationToken: parent.reservationToken, executionId: "parent", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "child.run", payload: { version: 1, input: null, executionId: "pending-child", concurrency } }, { kind: "child", sequence: 1, target: "other-child.run", payload: { version: 1, input: null, executionId: "open-child" } }], outcome: { status: "waiting" } });
    expect((await adapter.get("pending-child"))?.status).toBe("pending");
    await adapter.requestCancellation("pending-child");
    await adapter.forceTerminate("open-child", "child operator stop");
    expect(await adapter.get("parent")).toMatchObject({ status: "queued", revision: 4 });
    expect((await adapter.getHistory("parent")).filter(({ type }) => type === "command-completed")).toMatchObject([
      { sequence: 0, completionOrder: 0, error: { name: "WorkflowCancellationError" } },
      { sequence: 1, completionOrder: 1, error: { name: "WorkflowExecutionTerminatedError", message: "child operator stop" } },
    ]);
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "parent")).toMatchObject([{ kind: "workflow" }]);
  });

  it("cancels a pending execution once, clears its pause and resolves its terminal waiter", async () => {
    let now = epoch;
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const concurrency = { keyed: { key: "held-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
    await adapter.start({ ...start("holder"), concurrency });
    await adapter.start({ ...start("pending"), concurrency });
    await adapter.start({ ...start("still-pending"), concurrency });
    await adapter.setPaused("pending", true);
    const holder = await adapter.get("holder");
    let terminal: unknown;
    void adapter.waitForTerminal("pending").then((result) => { terminal = result; });
    now = new Date(epoch.getTime() + 10);
    expect(await adapter.requestCancellation("pending")).toBe(true);
    expect(await adapter.get("pending")).toMatchObject({ status: "cancelled", cancellationRequested: true, concurrencyAdmitted: false, completedAt: now, updatedAt: now, revision: 1 });
    expect(await adapter.get("pending")).not.toHaveProperty("pausedAt");
    expect(await adapter.getHistory("pending")).toEqual([{ type: "cancellation-requested", eventIndex: 0, occurredAt: now }]);
    await setImmediate();
    expect(terminal).toEqual(await adapter.get("pending"));
    const cancelled = await adapter.get("pending");
    expect(await adapter.requestCancellation("pending")).toBe(false);
    expect(await adapter.get("pending")).toEqual(cancelled);
    expect(await adapter.get("holder")).toEqual(holder);
    expect((await adapter.get("still-pending"))?.status).toBe("pending");
    expect(adapter.inspectTasks().some(({ executionId }) => executionId === "pending")).toBe(false);
  });

  it("pauses/resumes idempotently without duplicating queued activations", async () => {
    let now = epoch;
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    await adapter.start(start("paused"));
    now = new Date(epoch.getTime() + 10);
    expect(await adapter.setPaused("paused", true)).toBe(true);
    const paused = await adapter.get("paused");
    expect(paused).toMatchObject({ pausedAt: now, updatedAt: now });
    now = new Date(epoch.getTime() + 20);
    expect(await adapter.setPaused("paused", true)).toBe(false);
    expect(await adapter.get("paused")).toEqual(paused);
    expect(await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 })).toEqual([]);
    expect(await adapter.setPaused("paused", false)).toBe(true);
    const resumed = await adapter.get("paused");
    expect(resumed).not.toHaveProperty("pausedAt");
    expect(resumed?.updatedAt).toEqual(now);
    now = new Date(epoch.getTime() + 30);
    expect(await adapter.setPaused("paused", false)).toBe(false);
    expect(await adapter.get("paused")).toEqual(resumed);
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "paused")).toHaveLength(1);
  });

  it("does not create activation work when resuming a capacity-pending execution", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => epoch });
    const concurrency = { keyed: { key: "held-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
    await adapter.start({ ...start("holder"), concurrency });
    await adapter.start({ ...start("pending"), concurrency });
    await adapter.setPaused("pending", true);
    expect(await adapter.setPaused("pending", false)).toBe(true);
    expect(await adapter.get("pending")).toMatchObject({ status: "pending", concurrencyAdmitted: false });
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "pending")).toEqual([]);
  });

  it("requests cancellation once, removes local commands and propagates to open children", async () => {
    let now = epoch;
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    await adapter.start(start("parent"));
    const [parent] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await adapter.commitActivation({ taskId: parent!.id, reservationToken: parent!.reservationToken, executionId: "parent", expectedRevision: 0,
      commands: [
        { kind: "activity", sequence: 0, target: "activity.run", payload: null },
        { kind: "timer", sequence: 1, target: "timer", payload: { durationMs: 60_000 } },
        { kind: "child", sequence: 2, target: "child.run", payload: { version: 1, input: null, executionId: "child" } },
      ], outcome: { status: "waiting" },
    });
    await adapter.start(start("unrelated"));
    const unrelated = await adapter.get("unrelated");
    const unrelatedTasks = adapter.inspectTasks().filter(({ executionId }) => executionId === "unrelated");
    await adapter.setPaused("parent", true);
    await adapter.setPaused("child", true);
    now = new Date(epoch.getTime() + 10);
    expect(await adapter.requestCancellation("parent")).toBe(true);
    expect(await adapter.get("parent")).toMatchObject({ status: "queued", cancellationRequested: true, updatedAt: now, revision: 4 });
    expect(await adapter.get("parent")).not.toHaveProperty("pausedAt");
    expect(await adapter.get("child")).toMatchObject({ status: "queued", cancellationRequested: true });
    expect(await adapter.get("child")).not.toHaveProperty("pausedAt");
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "parent")).toMatchObject([{ kind: "workflow" }]);
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "parent")).toHaveLength(1);
    expect((await adapter.getHistory("parent")).at(-1)).toEqual({ type: "cancellation-requested", eventIndex: 3, occurredAt: now });
    const history = await adapter.getHistory("parent");
    expect(await adapter.requestCancellation("parent")).toBe(false);
    expect(await adapter.getHistory("parent")).toEqual(history);
    expect(await adapter.get("unrelated")).toEqual(unrelated);
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "unrelated")).toEqual(unrelatedTasks);
  });

  it("terminates local/outbox work and open descendants while admitting a waiting keyed peer", async () => {
    let now = epoch;
    const adapter = new MemoryWorkflowAdapter({ now: () => now, activityDispatchMode: "outbox" });
    const concurrency = { keyed: { key: "one-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
    await adapter.start({ ...start("parent"), concurrency });
    await adapter.start({ ...start("waiting-peer"), concurrency });
    const [parent] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await adapter.commitActivation({ taskId: parent!.id, reservationToken: parent!.reservationToken, executionId: "parent", expectedRevision: 0,
      commands: [{ kind: "activity", sequence: 0, target: "activity.run", payload: null }, { kind: "timer", sequence: 1, target: "timer", payload: { durationMs: 60_000 } }, { kind: "child", sequence: 2, target: "child.run", payload: { version: 1, input: null, executionId: "child" } }], outcome: { status: "waiting" },
    });
    await adapter.start({ ...start("unrelated"), workflowName: "other.run" });
    const unrelated = adapter.inspectTasks().find(({ executionId }) => executionId === "unrelated");
    await adapter.setPaused("parent", true);
    let closed: unknown;
    void adapter.waitForTerminal("parent").then((result) => { closed = result; });
    expect(adapter.inspectActivityDispatches()).toHaveLength(1);
    now = new Date(epoch.getTime() + 10);
    expect(await adapter.forceTerminate("parent", "operator stop")).toBe(true);
    const terminated = await adapter.get("parent");
    expect(terminated).toMatchObject({ status: "terminated", concurrencyAdmitted: false, completedAt: now, updatedAt: now, error: { name: "WorkflowExecutionTerminatedError", message: "operator stop" } });
    expect(terminated).not.toHaveProperty("pausedAt");
    expect(await adapter.get("child")).toMatchObject({ status: "terminated", error: { message: "operator stop" } });
    expect(adapter.inspectActivityDispatches()).toEqual([]);
    expect(adapter.inspectTasks().some(({ executionId }) => executionId === "parent" || executionId === "child")).toBe(false);
    expect(await adapter.get("waiting-peer")).toMatchObject({ status: "queued", concurrencyAdmitted: true });
    expect(adapter.inspectTasks().find(({ executionId }) => executionId === "unrelated")).toEqual(unrelated);
    await setImmediate();
    expect(closed).toEqual(terminated);
    expect(await adapter.forceTerminate("parent", "different reason")).toBe(false);
    expect(await adapter.get("parent")).toEqual(terminated);
  });

  for (const terminal of ["completed", "failed", "cancelled", "terminated"] as const) {
    it(`preserves a ${terminal} execution under pause, cancellation and repeated termination`, async () => {
      const adapter = new MemoryWorkflowAdapter({ now: () => epoch });
      if (terminal === "cancelled") {
        const concurrency = { keyed: { key: "held-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
        await adapter.start({ ...start("holder"), concurrency });
        await adapter.start({ ...start("terminal"), concurrency });
        await adapter.requestCancellation("terminal");
      } else {
        await adapter.start(start("terminal"));
        if (terminal === "completed") adapter.completeExecution("terminal", { done: true });
        else if (terminal === "failed") adapter.failExecution("terminal", { name: "Failure", message: "original" });
        else await adapter.forceTerminate("terminal", "original");
      }
      const before = await adapter.get("terminal");
      expect(await adapter.setPaused("terminal", true)).toBe(false);
      expect(await adapter.requestCancellation("terminal")).toBe(false);
      expect(await adapter.forceTerminate("terminal", "new reason")).toBe(false);
      expect(await adapter.get("terminal")).toEqual(before);
    });
  }

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`notifies waiters with the final ${status} activation snapshot after permit release`, async () => {
      const adapter = new MemoryWorkflowAdapter({ now: () => epoch });
      const concurrency = { keyed: { key: "one-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
      await adapter.start({ ...start("closing"), concurrency });
      await adapter.start({ ...start("waiting-peer"), concurrency });
      const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
      let notified: unknown;
      void adapter.waitForTerminal("closing").then((result) => { notified = result; });
      const outcome = status === "failed" ? { status, error: { name: "Failure", message: "terminal failure" } } : { status };
      await adapter.commitActivation({ taskId: task!.id, reservationToken: task!.reservationToken, executionId: "closing", expectedRevision: 0, commands: [], outcome });
      await setImmediate();
      expect(notified).toEqual(await adapter.get("closing"));
      expect(notified).toMatchObject({ status, concurrencyAdmitted: false });
      expect(await adapter.get("waiting-peer")).toMatchObject({ status: "queued", concurrencyAdmitted: true });
    });
  }

  it("reports a missing root without changing unrelated execution state", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => epoch });
    await adapter.start(start("unrelated"));
    const before = await adapter.get("unrelated");
    await expect(adapter.setPaused("missing", true)).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await expect(adapter.requestCancellation("missing")).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await expect(adapter.forceTerminate("missing")).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    expect(await adapter.get("unrelated")).toEqual(before);
  });

  it("traverses a closed child to terminate its still-open grandchild", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => epoch });
    await adapter.start(start("terminal-parent"));
    const [parent] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });
    await adapter.commitActivation({ taskId: parent!.id, reservationToken: parent!.reservationToken, executionId: "terminal-parent", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "child.run", payload: { version: 1, input: null, executionId: "closed-child" } }], outcome: { status: "waiting" },
    });
    const [child] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });
    await adapter.commitActivation({ taskId: child!.id, reservationToken: child!.reservationToken, executionId: "closed-child", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "grandchild.run", payload: { version: 1, input: null, executionId: "open-grandchild" } }], outcome: { status: "failed", error: { name: "ChildFailure", message: "child failed" } },
    });
    const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });
    const resumed = tasks.find(({ executionId }) => executionId === "terminal-parent")!;
    expect(resumed).toBeDefined();
    await adapter.commitActivation({ taskId: resumed.id, reservationToken: resumed.reservationToken, executionId: "terminal-parent", expectedRevision: (await adapter.get("terminal-parent"))!.revision, commands: [], outcome: { status: "failed", error: { name: "ParentFailure", message: "parent failed" } } });
    const parentBefore = await adapter.get("terminal-parent");
    const childBefore = await adapter.get("closed-child");
    // Reserving the parent's wake-up also leases its still-open grandchild.
    expect((await adapter.get("open-grandchild"))?.status).toBe("running");
    expect(await adapter.forceTerminate("terminal-parent", "close remaining descendants")).toBe(false);
    expect(await adapter.get("terminal-parent")).toEqual(parentBefore);
    expect(await adapter.get("closed-child")).toEqual(childBefore);
    expect(await adapter.get("open-grandchild")).toMatchObject({ status: "terminated", error: { message: "close remaining descendants" } });
    expect(adapter.inspectTasks().some(({ executionId }) => executionId === "open-grandchild")).toBe(false);
  });

  it("terminates open descendants even when their failed parent is already terminal", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => epoch });
    await adapter.start(start("terminal-parent"));
    const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await adapter.commitActivation({ taskId: task!.id, reservationToken: task!.reservationToken, executionId: "terminal-parent", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "child.run", payload: { version: 1, input: null, executionId: "open-child" } }],
      outcome: { status: "failed", error: { name: "ParentFailure", message: "Parent failed before child compensation." } },
    });
    const parentBefore = await adapter.get("terminal-parent");
    expect(await adapter.get("open-child")).toMatchObject({ status: "queued", cancellationRequested: true });
    expect(await adapter.forceTerminate("terminal-parent", "operator escalation")).toBe(false);
    expect(await adapter.get("terminal-parent")).toEqual(parentBefore);
    expect(await adapter.get("open-child")).toMatchObject({ status: "terminated", error: { name: "WorkflowExecutionTerminatedError", message: "operator escalation" } });
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === "open-child")).toEqual([]);
  });
});
