import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { WorkflowExecutionConflictError, WorkflowExecutionNotFoundError } from "../../index.js";
import { MemoryWorkflowAdapter } from "./index.js";

const request = {
  executionId: "admission-contract",
  workflowName: "example.admission",
  workflowVersion: 1,
  input: null,
} as const;

describe("Memory workflow admission boundaries", () => {
  it("leaves an empty start batch independent of clock availability", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => { throw new Error("Clock unavailable."); } });
    await expect(adapter.startMany([])).resolves.toEqual([]);
  });

  it("rejects incompatible duplicate requests before publishing any part of a start batch", async () => {
    const adapter = new MemoryWorkflowAdapter();
    for (const other of [{ ...request, input: "incompatible" }, { ...request, workflowName: "other.definition" }]) {
      await expect(adapter.startMany([request, other])).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    }
    await expect(adapter.get(request.executionId)).resolves.toBeUndefined();
    expect(adapter.inspectTasks()).toEqual([]);
  });

  it("searches definition-limited executions without treating them as keyed", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.startMany([
      { ...request, executionId: "other", concurrency: { definitionLimit: 1 } },
      { ...request, executionId: "matching", concurrency: { keyed: { key: "needle", limit: 1, conflict: "enqueue", scope: "execution" } } },
    ]);
    expect((await adapter.listExecutions({ search: "needle", limit: 10 })).items.map(({ executionId }) => executionId)).toEqual(["matching"]);
  });

  it("keeps independent parent metadata and applies the parent filter only when supplied", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.startMany([
      { ...request, executionId: "parent-only", parentExecutionId: "parent" },
      { ...request, executionId: "sequence-only", parentCommandSequence: 0 },
      request,
    ]);
    await expect(adapter.get("parent-only")).resolves.toMatchObject({ parentExecutionId: "parent" });
    await expect(adapter.get("sequence-only")).resolves.toMatchObject({ parentCommandSequence: 0 });
    expect((await adapter.get("parent-only"))).not.toHaveProperty("parentCommandSequence");
    expect((await adapter.get("sequence-only"))).not.toHaveProperty("parentExecutionId");
    expect((await adapter.listExecutions({ parentExecutionId: "parent", limit: 10 })).items.map(({ executionId }) => executionId)).toEqual(["parent-only"]);
    expect((await adapter.listExecutions({ limit: 10 })).items).toHaveLength(3);
    await expect(adapter.getHistory("missing")).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
  });

  it("keeps unkeyed signals independent of a literal idempotency key", async () => {
    let signalId = 0;
    const adapter = new MemoryWorkflowAdapter({ createSignalId: () => `signal-${++signalId}` });
    await adapter.start(request);
    const unkeyed = {
      executionId: request.executionId, workflowName: request.workflowName, signalName: "ready", payload: null,
    };
    const keyed = { ...unkeyed, idempotencyKey: "undefined" };
    await expect(adapter.sendSignal(unkeyed)).resolves.toEqual({ id: "signal-1", accepted: true });
    await expect(adapter.sendSignal(unkeyed)).resolves.toEqual({ id: "signal-2", accepted: true });
    await expect(adapter.sendSignal(keyed)).resolves.toEqual({ id: "signal-3", accepted: true });
    await expect(adapter.sendSignal(unkeyed)).resolves.toEqual({ id: "signal-4", accepted: true });
    await expect(adapter.sendSignal(keyed)).resolves.toEqual({ id: "signal-3", accepted: false });

    const [first, second, keyedSignal, third] = adapter.inspectSignals();
    expect(first).not.toHaveProperty("idempotencyKey");
    expect(second).not.toHaveProperty("idempotencyKey");
    expect(keyedSignal).toHaveProperty("idempotencyKey", "undefined");
    expect(third).not.toHaveProperty("idempotencyKey");
  });

  it("does not alias signal keys from distinct execution IDs across continuation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const first = { ...request, executionId: "first" };
    const second = { ...request, executionId: "first\u0000boundary" };
    await adapter.startMany([first, second]);
    const deliver = (executionId: string, idempotencyKey: string) => adapter.sendSignal({
      executionId, workflowName: request.workflowName, signalName: "ready", payload: executionId, idempotencyKey,
    });
    await expect(deliver(first.executionId, "boundary\u0000end")).resolves.toMatchObject({ accepted: true });
    const other = await deliver(second.executionId, "end");
    expect(other.accepted).toBe(true);

    const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 2, leaseMs: 1_000 });
    const task = tasks.find(({ executionId }) => executionId === first.executionId)!;
    await expect(adapter.continueAsNew({
      taskId: task.id, reservationToken: task.reservationToken, executionId: first.executionId,
      expectedRevision: 1, workflowVersion: 2, input: null,
    })).resolves.toBe(true);
    await expect(deliver(second.executionId, "end")).resolves.toEqual({ accepted: false, id: other.id });
    await expect(deliver(first.executionId, "boundary\u0000end")).resolves.toMatchObject({ accepted: true });
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

  it("keeps an owned lease batch unchanged when a later lease duration is invalid", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => new Date("2026-01-01T00:00:00Z") });
    await adapter.startMany([request, { ...request, executionId: "peer" }]);
    const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 2, leaseMs: 1_000 });
    const before = adapter.inspectTasks();
    const requests = tasks.map(({ id: taskId, reservationToken }, index) => ({ taskId, reservationToken, leaseMs: index === 0 ? 5_000 : 0 }));
    await expect(adapter.extendTaskLeases(requests)).rejects.toThrow("Workflow task leaseMs must be a positive integer.");
    expect(adapter.inspectTasks()).toEqual(before);
    await expect(adapter.extendTaskLeases(requests.map((reservation) => ({ ...reservation, leaseMs: 5_000 })))).resolves.toHaveLength(2);
    expect(adapter.inspectTasks().every(({ availableAt }) => availableAt.toISOString() === "2026-01-01T00:00:05.000Z")).toBe(true);
  });

  it("does not alias active-work limits for distinct definitions and business keys", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const concurrency = (key: string) => ({ keyed: { key, limit: 1, conflict: "enqueue", scope: "active-work" } } as const);
    await adapter.startMany([
      { ...request, executionId: "first", workflowName: "example", concurrency: concurrency("boundary\u0000end") },
      { ...request, executionId: "second", workflowName: "example\u0000boundary", concurrency: concurrency("end") },
    ]);
    const leases = await adapter.reserveTasks({ kinds: ["workflow"], limit: 2, leaseMs: 1_000 });
    expect(leases.map(({ executionId }) => executionId).sort()).toEqual(["first", "second"]);
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
    const waiter = adapter.waitForTerminal(request.executionId);
    const result = await Promise.race([waiter, setImmediate()]);
    expect(result).toMatchObject({ status: "terminated" });
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

  it.each(["poll", "release"] as const)("forgets a recovered permit handoff after successful %s", async (recovery) => {
    let nextTask = 0;
    let fail = false;
    const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
      if (fail) throw new Error("Wake unavailable.");
      return `task-${++nextTask}`;
    } });
    const concurrency = (limit: number) => ({ keyed: { key: "handoff", limit, scope: "execution", conflict: "enqueue" } } as const);
    const releasedLimit = recovery === "poll" ? 3 : 2;
    await adapter.startMany([
      { ...request, executionId: "holder", concurrency: concurrency(releasedLimit) },
      { ...request, executionId: "peer", concurrency: concurrency(releasedLimit) },
      { ...request, executionId: "pending", concurrency: concurrency(1) },
    ]);
    fail = true;
    await adapter.forceTerminate("holder");
    fail = false;
    // A successful release or poll consumes the saved permit handoff.
    const reserve = () => adapter.reserveTasks({ kinds: ["workflow"], limit: 3, leaseMs: 60_000 });
    if (recovery === "release") await adapter.forceTerminate("peer");
    else await reserve();
    await expect(adapter.get("pending")).resolves.toMatchObject({ concurrencyAdmitted: true });

    // A stale handoff would use the old limit and promote a later start under
    // its own stricter limit even though no permit was released in the meantime.
    await adapter.start({ ...request, executionId: "later", concurrency: concurrency(releasedLimit - 1) });
    await expect(adapter.get("later")).resolves.toMatchObject({ status: "pending" });
    expect((await reserve()).map(({ executionId }) => executionId)).not.toContain("later");
    await expect(adapter.get("later")).resolves.toMatchObject({ status: "pending" });
  });
});
