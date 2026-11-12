import { describe, expect, it } from "vitest";

import { MemoryWorkflowAdapter } from "./index.js";

const request = {
  executionId: "admission-contract",
  workflowName: "example.admission",
  workflowVersion: 1,
  input: null,
} as const;

describe("Memory workflow admission boundaries", () => {
  it("keeps unkeyed signals independent of a literal idempotency key", async () => {
    let signalId = 0;
    const adapter = new MemoryWorkflowAdapter({ createSignalId: () => `signal-${++signalId}` });
    await adapter.start(request);
    const unkeyed = {
      executionId: request.executionId, workflowName: request.workflowName, signalName: "ready", payload: null,
    };
    const keyed = { ...unkeyed, idempotencyKey: "undefined" };
    await expect(adapter.sendSignal(unkeyed)).resolves.toEqual({ id: "signal-1", accepted: true });
    await expect(adapter.sendSignal(keyed)).resolves.toEqual({ id: "signal-2", accepted: true });
    await expect(adapter.sendSignal(unkeyed)).resolves.toEqual({ id: "signal-3", accepted: true });
    await expect(adapter.sendSignal(keyed)).resolves.toEqual({ id: "signal-2", accepted: false });

    const [first, second, third] = adapter.inspectSignals();
    expect(first).not.toHaveProperty("idempotencyKey");
    expect(second).toHaveProperty("idempotencyKey", "undefined");
    expect(third).not.toHaveProperty("idempotencyKey");
  });

  it("does not count a future unleased timer against a workflow's active capacity", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => new Date("2026-01-01T00:00:00Z") });
    await adapter.start({ ...request, concurrency: { definitionLimit: 1 } });
    const reserve = () => adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 });
    const [initial] = await reserve();
    await expect(adapter.commitActivation({
      taskId: initial!.id, reservationToken: initial!.reservationToken, executionId: request.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 5000 } }], outcome: { status: "waiting" },
    })).resolves.toBe(true);
    await adapter.sendSignal({ executionId: request.executionId, workflowName: request.workflowName, signalName: "ready", payload: null });
    await expect(reserve()).resolves.toMatchObject([{ executionId: request.executionId, kind: "workflow" }]);
    expect(adapter.inspectTasks().find(({ kind }) => kind === "timer")).not.toHaveProperty("reservationToken");
  });

  it("leases activity work even when the same execution has a live workflow lease", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => new Date("2026-01-01T00:00:00Z") });
    await adapter.start(request);
    const reserve = (kind: "workflow" | "activity") => adapter.reserveTasks({ kinds: [kind], limit: 1, leaseMs: 1000 });
    const [initial] = await reserve("workflow");
    await expect(adapter.commitActivation({
      taskId: initial!.id, reservationToken: initial!.reservationToken, executionId: request.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "example.activity", payload: null }], outcome: { status: "waiting" },
    })).resolves.toBe(true);
    await adapter.sendSignal({ executionId: request.executionId, workflowName: request.workflowName, signalName: "ready", payload: null });
    await expect(reserve("workflow")).resolves.toMatchObject([{ executionId: request.executionId, kind: "workflow" }]);
    await expect(reserve("activity")).resolves.toMatchObject([{ executionId: request.executionId, kind: "activity" }]);
  });

  it("filters by creation time before applying the cursor's execution identity", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    await adapter.start({ ...request, executionId: "older" });
    now = new Date(now.getTime() + 1);
    await adapter.start({ ...request, executionId: "boundary" });
    const first = await adapter.listExecutions({ limit: 1 });
    expect(first.items.map(({ executionId }) => executionId)).toEqual(["boundary"]);
    expect(first.nextCursor).toEqual(expect.any(String));

    // The new row sorts after the boundary by ID alone, but before it by timestamp.
    now = new Date(now.getTime() + 1);
    await adapter.start({ ...request, executionId: "a" });
    const second = await adapter.listExecutions({ limit: 10, cursor: first.nextCursor! });
    expect(second.items.map(({ executionId }) => executionId)).toEqual(["older"]);
    expect(second).not.toHaveProperty("nextCursor");
  });

  it("retries a retained-permit handoff after task allocation fails", async () => {
    let failIn = Infinity;
    let nextTask = 0;
    const failure = new Error("Unable to allocate a pending workflow's task.");
    const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
      if (--failIn === 0) throw failure;
      return `task-${++nextTask}`;
    } });
    const concurrency = (limit: number) => ({ keyed: { key: "handoff", limit, scope: "execution", conflict: "enqueue" } } as const);
    await adapter.start({ ...request, concurrency: concurrency(2) });
    for (const executionId of ["first-waiter", "second-waiter"]) {
      await expect(adapter.start({ ...request, executionId, concurrency: concurrency(1) }))
        .resolves.toMatchObject({ execution: { status: "pending" } });
    }
    await adapter.start({ ...request, executionId: "independent" });
    const waiting = async () => Promise.all([adapter.get("first-waiter"), adapter.get("second-waiter")]);

    // The second allocation fails. Neither successor should have been promoted yet.
    failIn = 2;
    await expect(adapter.forceTerminate(request.executionId, "Closed.")).resolves.toBe(true);
    await expect(adapter.waitForTerminal(request.executionId)).resolves.toMatchObject({ status: "terminated" });
    await expect(waiting()).resolves.toMatchObject([{ status: "pending" }, { status: "pending" }]);
    expect(adapter.inspectTasks().map(({ executionId }) => executionId)).toEqual(["independent"]);

    const reserve = () => adapter.reserveTasks({ kinds: ["workflow"], limit: 3, leaseMs: 60_000 });
    failIn = 1;
    await expect(reserve()).resolves.toMatchObject([{ executionId: "independent" }]);
    failIn = 1;
    await expect(reserve()).rejects.toBe(failure);
    await expect(waiting()).resolves.toMatchObject([{ status: "pending" }, { status: "pending" }]);

    failIn = Infinity;
    const leases = await reserve();
    expect(leases.map(({ executionId }) => executionId).sort()).toEqual(["first-waiter", "second-waiter"]);
    expect(leases.map(({ attempt }) => attempt)).toEqual([1, 1]);
  });
});
