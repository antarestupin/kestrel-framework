import { setImmediate } from "node:timers/promises";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  WorkflowExecutionClosedError,
  WorkflowConcurrencyConflictError,
  WorkflowExecutionConflictError,
  WorkflowExecutionNotFoundError,
  WorkflowSignalConflictError,
} from "../../index.js";
import type { WorkflowPayload } from "../../serialization.js";
import { MemoryWorkflowAdapter } from "./index.js";

const startRequest = {
  executionId: "execution-1",
  workflowName: "example.run",
  workflowVersion: 1,
  input: { value: "input" },
} as const;

describe("MemoryWorkflowAdapter", () => {
  it.each(["workflow", "dispatch"] as const)("leaves the %s batch untouched when allocating a later reservation token fails", async (kind) => {
    let failIn = Infinity;
    let next = 0;
    const failure = new Error("No reservation token available.");
    const adapter = new MemoryWorkflowAdapter({
      activityDispatchMode: "outbox",
      createReservationToken: () => {
        if (--failIn === 0) throw failure;
        return `token-${++next}`;
      },
    });
    await adapter.start(startRequest);
    if (kind === "dispatch") {
      const [activation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 });
      await adapter.commitActivation({
        taskId: activation!.id, reservationToken: activation!.reservationToken,
        executionId: startRequest.executionId, expectedRevision: 0,
        commands: [0, 1].map((sequence) => ({
          sequence, kind: "activity", target: "example.work", payload: null,
        })),
        outcome: { status: "waiting" },
      });
    } else {
      await adapter.start({ ...startRequest, executionId: "second" });
    }
    const reserve = () => kind === "dispatch"
      ? adapter.reserveActivityDispatches({ limit: 2, leaseMs: 1000 })
      : adapter.reserveTasks({ kinds: ["workflow"], limit: 2, leaseMs: 1000 });
    const inspect = () => kind === "dispatch" ? adapter.inspectActivityDispatches() : adapter.inspectTasks();
    const initial = inspect();
    expect(initial).toHaveLength(2);
    failIn = 2;
    await expect(reserve()).rejects.toBe(failure);
    expect(inspect()).toEqual(initial);

    failIn = Infinity;
    const retried = await reserve();
    expect(retried.map(({ attempt }) => attempt)).toEqual([1, 1]);
  });

  it("takes ownership of dates returned by the adapter clock", async () => {
    const time = new Date("2026-01-01T00:00:00Z");
    const original = new Date(time);
    const adapter = new MemoryWorkflowAdapter({ now: () => time });
    await adapter.start(startRequest);
    time.setUTCFullYear(2030);

    await expect(adapter.get(startRequest.executionId)).resolves.toMatchObject({
      createdAt: original, updatedAt: original,
    });
    const stored = await adapter.get(startRequest.executionId);
    for (const key of ["output", "error", "pausedAt", "completedAt", "concurrency"]) {
      expect(stored).not.toHaveProperty(key);
    }
    expect(adapter.inspectTasks()).toMatchObject([{ createdAt: original, availableAt: original }]);
  });

  it("returns detached timestamps from the signal inspection seam", async () => {
    const time = new Date("2026-01-01T00:00:00Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => time });
    await adapter.start(startRequest);
    await adapter.sendSignal({
      executionId: startRequest.executionId, workflowName: startRequest.workflowName,
      signalName: "ready", payload: null,
    });
    adapter.inspectSignals()[0]!.receivedAt.setUTCFullYear(2030);
    expect(adapter.inspectSignals()).toMatchObject([{ receivedAt: new Date("2026-01-01T00:00:00Z") }]);
  });

  it("does not record a signal when scheduling its wake-up fails", async () => {
    let next = 0;
    let rejectWake = false;
    const failure = new Error("No workflow task ID available.");
    const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
      if (rejectWake) throw failure;
      return `task-${++next}`;
    } });
    await adapter.start(startRequest);
    const [activation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 });
    await adapter.commitActivation({
      taskId: activation!.id, reservationToken: activation!.reservationToken,
      executionId: startRequest.executionId, expectedRevision: 0,
      commands: [], outcome: { status: "waiting" },
    });
    const signal = {
      executionId: startRequest.executionId, workflowName: startRequest.workflowName,
      signalName: "ready", idempotencyKey: "one", payload: { delivered: true },
    };
    rejectWake = true;
    await expect(adapter.sendSignal(signal)).rejects.toBe(failure);
    expect(adapter.inspectSignals()).toEqual([]);
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toEqual([]);
    await expect(adapter.get(startRequest.executionId)).resolves.toMatchObject({ revision: 0, status: "waiting" });

    rejectWake = false;
    await expect(adapter.sendSignal(signal)).resolves.toMatchObject({ accepted: true });
    await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 }))
      .resolves.toMatchObject([{ executionId: startRequest.executionId }]);
  });

  it("declines external activity results for missing executions", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    await expect(adapter.completeExternalActivity({
      executionId: "missing", sequence: 0, sourceId: "worker", status: "completed",
    })).resolves.toBe(false);
  });

  it("accepts only current activity results and appends them in delivery order", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now, activityDispatchMode: "outbox" });
    const executionId = startRequest.executionId;
    await adapter.start(startRequest);
    const reserve = async () => (await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 }))[0]!;
    const ref = (task: Awaited<ReturnType<typeof reserve>>) => ({ taskId: task.id, reservationToken: task.reservationToken });
    const activation = await reserve();
    const complete = (sequence: number, sourceId: string, result?: null) => adapter.completeExternalActivity({
      executionId, sequence, sourceId, status: "completed", ...(result === undefined ? {} : { result }),
    });
    await expect(complete(0, "too-soon")).resolves.toBe(false);
    await expect(adapter.commitActivation({
      ...ref(activation), executionId, expectedRevision: 0, outcome: { status: "waiting" },
      commands: [
        { sequence: 0, kind: "activity", target: "first", payload: null },
        { sequence: 1, kind: "timer", target: "sleep", payload: { durationMs: 20_000 } },
        { sequence: 2, kind: "activity", target: "second", payload: null },
      ],
    })).resolves.toBe(true);
    await expect(complete(1, "timer-is-not-an-activity")).resolves.toBe(false);
    await expect(complete(3, "unknown-command")).resolves.toBe(false);

    now = new Date(now.getTime() + 10);
    await expect(complete(2, "second-finished-first", null)).resolves.toBe(true);
    await expect(complete(0, "first-finished-second")).resolves.toBe(true);
    await expect(complete(0, "duplicate-callback", null)).resolves.toBe(true);
    const history = await adapter.getHistory(executionId);
    expect(history).toHaveLength(5);
    expect(history.slice(3)).toEqual([
      { type: "command-completed", eventIndex: 3, sequence: 2, completionOrder: 0, sourceId: "second-finished-first", result: null, occurredAt: now },
      { type: "command-completed", eventIndex: 4, sequence: 0, completionOrder: 1, sourceId: "first-finished-second", occurredAt: now },
    ]);
    await expect(adapter.get(executionId)).resolves.toMatchObject({ status: "queued", revision: 5, updatedAt: now });
    await expect(adapter.commitActivation({
      ...ref(await reserve()), executionId, expectedRevision: 5, commands: [], outcome: { status: "completed" },
    })).resolves.toBe(true);
    await expect(complete(3, "closed-execution")).resolves.toBe(true);
    await expect(adapter.getHistory(executionId)).resolves.toEqual(history);
  });

  it.each(["capture", "signal"] as const)("keeps a synchronous %s activation retryable when allocating its successor fails", async (kind) => {
    let rejectWake = false;
    let nextTask = 0;
    const failure = new Error("No successor task ID available.");
    const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
      if (rejectWake) throw failure;
      return `task-${++nextTask}`;
    } });
    await adapter.start(startRequest);
    const executionId = startRequest.executionId;
    if (kind === "signal") {
      await adapter.sendSignal({ executionId, workflowName: startRequest.workflowName, signalName: "ready", payload: 7 });
    }
    const [activation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 });
    const initialHistory = await adapter.getHistory(executionId);
    const initialSignals = adapter.inspectSignals();
    const initialTasks = adapter.inspectTasks();
    const request = {
      taskId: activation!.id, reservationToken: activation!.reservationToken, executionId,
      expectedRevision: initialHistory.length,
      commands: [{ sequence: 0, kind, target: "ready", payload: kind === "signal" ? {} : 7 }],
      outcome: { status: "waiting" },
    } as const;

    rejectWake = true;
    await expect(adapter.commitActivation(request)).rejects.toBe(failure);
    await expect(adapter.getHistory(executionId)).resolves.toEqual(initialHistory);
    await expect(adapter.get(executionId)).resolves.toMatchObject({ revision: initialHistory.length, status: "running" });
    expect(adapter.inspectSignals()).toEqual(initialSignals);
    expect(adapter.inspectTasks()).toEqual(initialTasks);

    rejectWake = false;
    await expect(adapter.commitActivation(request)).resolves.toBe(true);
    expect((await adapter.getHistory(executionId)).at(-1)).toMatchObject({ type: "command-completed", sequence: 0, result: 7 });
    await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 }))
      .resolves.toMatchObject([{ executionId, attempt: 1 }]);
  });

  it.each(["embedded", "outbox"] as const)("keeps an activity retryable when the %s wake-up cannot be scheduled", async (activityDispatchMode) => {
    let next = 0;
    let rejectWake = false;
    const failure = new Error("No workflow task ID available.");
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode, createTaskId: () => {
      if (rejectWake) throw failure;
      return `task-${++next}`;
    } });
    await adapter.start(startRequest);
    const [activation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 });
    await adapter.commitActivation({
      taskId: activation!.id, reservationToken: activation!.reservationToken,
      executionId: startRequest.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "example.work", payload: null }],
      outcome: { status: "waiting" },
    });
    const outcome = { executionId: startRequest.executionId, sequence: 0, status: "completed", result: null } as const;
    const [activity] = activityDispatchMode === "embedded"
      ? await adapter.reserveTasks({ kinds: ["activity"], limit: 1, leaseMs: 1000 }) : [];
    const complete = async () => activity === undefined
      ? adapter.completeExternalActivity({ ...outcome, sourceId: "worker" })
      : (await adapter.completeActivities([{
          ...outcome, taskId: activity.id, reservationToken: activity.reservationToken,
        }])).length === 1;

    rejectWake = true;
    await expect(complete()).rejects.toBe(failure);
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toMatchObject([{ type: "command-scheduled" }]);
    await expect(adapter.get(startRequest.executionId)).resolves.toMatchObject({ revision: 1, status: "waiting" });
    rejectWake = false;
    await expect(complete()).resolves.toBe(true);
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toMatchObject([
      { type: "command-scheduled" }, { type: "command-completed", result: null },
    ]);
    await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 }))
      .resolves.toMatchObject([{ executionId: startRequest.executionId }]);
  });

  it("validates query limits and reservation bounds before selecting work", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    for (const limit of [0, -1, 201, 1.5, Infinity, NaN]) {
      await expect(adapter.listExecutions({ limit })).rejects.toThrow("limit must be between 1 and 200");
    }
    await expect(adapter.listExecutions({ limit: 200 })).resolves.toMatchObject({ items: [{ executionId: startRequest.executionId }] });
    await expect(adapter.start({ ...startRequest, executionId: "" })).rejects.toThrow("Workflow execution IDs cannot be empty.");
    for (const invalid of [0, -1, 1.5, Infinity]) {
      await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: invalid, leaseMs: 1_000 }))
        .rejects.toThrow("Workflow task reservation limit must be positive.");
      await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: invalid }))
        .rejects.toThrow("Workflow task leaseMs must be positive.");
      await expect(adapter.reserveActivityDispatches({ limit: 1, leaseMs: invalid }))
        .rejects.toThrow("Workflow activity dispatch leaseMs must be positive.");
      await expect(adapter.reserveActivityDispatches({ limit: invalid, leaseMs: 1 }))
        .rejects.toThrow("Workflow activity dispatch limit must be positive.");
    }
    await expect(adapter.reserveActivityDispatches({ limit: 1, leaseMs: 1 })).resolves.toEqual([]);
    // Validation failures leave the first delivery and its attempt unchanged.
    await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1 }))
      .resolves.toMatchObject([{ executionId: startRequest.executionId, attempt: 1 }]);
  });

  it("detaches payloads and dates from journal reads and activation snapshots", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now, activityDispatchMode: "outbox" });
    const executionId = startRequest.executionId;
    await adapter.start(startRequest);
    const [first] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 });
    await adapter.commitActivation({
      taskId: first!.id, reservationToken: first!.reservationToken,
      executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "example.work", payload: { value: "command" } }],
      outcome: { status: "waiting" },
    });
    await adapter.sendSignal({ executionId, workflowName: startRequest.workflowName, signalName: "ready", payload: { value: "signal" } });
    await adapter.completeExternalActivity({ executionId, sequence: 0, sourceId: "worker", status: "completed", result: { value: "result" } });
    const expected = [
      { type: "command-scheduled", payload: { value: "command" }, occurredAt: now },
      { type: "signal-received", payload: { value: "signal" }, occurredAt: now },
      { type: "command-completed", result: { value: "result" }, occurredAt: now },
    ];
    const history = await adapter.getHistory(executionId);
    expect(history).toMatchObject(expected);
    for (const event of history) {
      event.occurredAt.setUTCFullYear(2030);
      if ("payload" in event) (event.payload as { value: string }).value = "changed";
      if ("result" in event) (event.result as { value: string }).value = "changed";
    }
    const [second] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 });
    const [loaded] = await adapter.loadActivations([{ taskId: second!.id, reservationToken: second!.reservationToken }]);
    expect(loaded?.snapshot.history).toMatchObject(expected);
    expect(loaded?.snapshot.history).toStrictEqual(await adapter.getHistory(executionId));
  });

  it("summarizes multiple executions by definition, version and status", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const fixtures = [
      { ...startRequest, executionId: "queued-2a", workflowVersion: 2 },
      { ...startRequest, executionId: "queued-2b", workflowVersion: 2 },
      { ...startRequest, executionId: "failed-2", workflowVersion: 2 },
      { ...startRequest, executionId: "queued-1" },
      { ...startRequest, executionId: "other", workflowName: "other.run" },
    ];
    await adapter.startMany(fixtures);
    adapter.failExecution("failed-2", { name: "FixtureFailure", message: "Closed." });
    await expect(adapter.summarizeExecutionVersions()).resolves.toEqual([
      { workflowName: "example.run", workflowVersion: 1, status: "queued", count: 1 },
      { workflowName: "example.run", workflowVersion: 2, status: "failed", count: 1 },
      { workflowName: "example.run", workflowVersion: 2, status: "queued", count: 2 },
      { workflowName: "other.run", workflowVersion: 1, status: "queued", count: 1 },
    ]);
  });

  it("continues from self-contained keys even when the boundary execution is absent", async () => {
    const now = () => new Date("2026-09-18T12:00:00.123Z");
    const original = new MemoryWorkflowAdapter({ now });
    for (const executionId of ["a", "b", "c"]) {
      await original.start({ ...startRequest, executionId });
    }
    const first = await original.listExecutions({ limit: 2 });
    expect(first.items.map(({ executionId }) => executionId)).toEqual(["c", "b"]);
    expect(first.nextCursor).not.toBe("b");

    // A reconstructed store has no boundary row, just the surviving older row
    // and a newly inserted row before the boundary in descending order.
    const restored = new MemoryWorkflowAdapter({ now });
    await restored.start({ ...startRequest, executionId: "a" });
    await restored.start({ ...startRequest, executionId: "d" });
    const last = await restored.listExecutions({ limit: 1, cursor: first.nextCursor! });
    expect(last.items.map(({ executionId }) => executionId)).toEqual(["a"]);
    expect(last.nextCursor).toBeUndefined();
    await expect(restored.listExecutions({ limit: 1, cursor: "b" })).rejects.toThrow(TypeError);
  });

  it("combines execution search, lineage, definition, status, pause and date bounds", async () => {
    const boundary = new Date("2026-01-01T00:00:00.000Z");
    let now = boundary;
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const base = {
      ...startRequest, workflowVersion: 3, parentExecutionId: "parent", rootExecutionId: "root",
      concurrency: { keyed: { key: "Mix_%", limit: 10, scope: "execution", conflict: "enqueue" } },
    } as const;
    for (const request of [base,
      { ...base, executionId: "wrong-definition", workflowName: "other.run" },
      { ...base, executionId: "wrong-version", workflowVersion: 4 },
      { ...base, executionId: "wrong-root", rootExecutionId: "other-root" },
      { ...base, executionId: "wrong-parent", parentExecutionId: "other-parent" },
      { ...base, executionId: "unpaused" },
      { ...base, executionId: "closed" },
    ]) {
      await adapter.start(request);
      if (request.executionId !== "unpaused") await adapter.setPaused(request.executionId, true);
    }
    adapter.failExecution("closed", { name: "FixtureFailure", message: "Closed." });
    now = new Date(boundary.getTime() - 1);
    await adapter.start({ ...base, executionId: "too-old" });
    await adapter.setPaused("too-old", true);
    now = new Date(boundary.getTime() + 1);
    await adapter.start({ ...base, executionId: "too-new" });
    await adapter.setPaused("too-new", true);

    const query = {
      limit: 20, search: "mIx_%", workflowNames: [base.workflowName], workflowVersions: [3],
      statuses: ["queued"] as const, parentExecutionId: "parent", rootExecutionId: "root",
      paused: true, createdAfter: boundary, createdBefore: boundary,
    };
    await expect(adapter.listExecutions(query)).resolves.toEqual({ items: [await adapter.get(base.executionId)] });
    const unpaused = await adapter.listExecutions({ ...query, paused: false });
    expect(unpaused.items.map(({ executionId }) => executionId)).toEqual(["unpaused"]);
  });

  it("finds retry lineage and searches execution IDs, workflow names and keys independently", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const source = { ...startRequest, executionId: "source", workflowName: "catalog.invoice" };
    await adapter.start(source);
    adapter.failExecution(source.executionId, { name: "Failure", message: "Retryable." });
    await adapter.retryExecution({ sourceExecutionId: source.executionId, executionId: "renewed-invoice", workflowVersion: 2 });
    await adapter.start({
      ...startRequest, executionId: "other", workflowName: "catalog.other",
      concurrency: { keyed: { key: "customer-42", limit: 1, scope: "execution", conflict: "enqueue" } },
    });

    const ids = async (query: Parameters<typeof adapter.listExecutions>[0]) =>
      (await adapter.listExecutions(query)).items.map(({ executionId }) => executionId);
    expect(await ids({ limit: 10, retryOfExecutionId: "source" })).toEqual(["renewed-invoice"]);
    expect(await ids({ limit: 10, retryOfExecutionId: "other" })).toEqual([]);
    expect(await ids({ limit: 10, search: "RENEWED" })).toEqual(["renewed-invoice"]);
    expect(await ids({ limit: 10, search: "CATALOG.INVOICE" })).toEqual(expect.arrayContaining(["source", "renewed-invoice"]));
    expect(await ids({ limit: 10, search: "CUSTOMER-42" })).toEqual(["other"]);
  });

  it("buffers independent unkeyed signals for a pending execution without claiming its permit", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const concurrency = { keyed: { key: "permit", limit: 1, scope: "execution", conflict: "enqueue" } } as const;
    await adapter.start({ ...startRequest, executionId: "holder", concurrency });
    await adapter.start({ ...startRequest, executionId: "pending", concurrency });
    const request = { executionId: "pending", workflowName: startRequest.workflowName, signalName: "ready", payload: null };
    const first = await adapter.sendSignal(request);
    const second = await adapter.sendSignal(request);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(adapter.inspectSignals("pending")).toHaveLength(2);
    for (const signal of adapter.inspectSignals("pending")) expect(signal).not.toHaveProperty("idempotencyKey");
    expect(adapter.inspectTasks().map(({ executionId }) => executionId)).toEqual(["holder"]);
    await expect(adapter.get("pending")).resolves.toMatchObject({ status: "pending", revision: 2 });
  });

  it("keeps activity inspection data detached and rejects an activity lease as an activation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const executionId = startRequest.executionId;
    await adapter.start(startRequest);
    const [workflow] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 });
    await adapter.commitActivation({
      taskId: workflow!.id, reservationToken: workflow!.reservationToken, executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "example.work", payload: { value: "stable" } }],
      outcome: { status: "waiting" },
    });
    const [activity] = await adapter.reserveTasks({ kinds: ["activity"], limit: 1, leaseMs: 1000 });
    const [view] = adapter.inspectTasks();
    (view!.payload as { value: string }).value = "changed";
    view!.reservedAt!.setTime(0);
    expect(adapter.inspectTasks()).toMatchObject([{ payload: { value: "stable" }, reservedAt: activity!.reservedAt }]);
    await expect(adapter.loadActivations([{ taskId: activity!.id, reservationToken: activity!.reservationToken }]))
      .resolves.toEqual([]);
    await expect(adapter.get(executionId)).resolves.toMatchObject({ status: "waiting" });
  });

  it("orders equally eligible tasks by identity and preserves active lease capacity", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const identities = ["task-c", "task-a", "task-b"];
    const adapter = new MemoryWorkflowAdapter({ now: () => now, createTaskId: () => identities.shift()! });
    const concurrency = { definitionLimit: 1 };
    await adapter.startMany(["c", "a", "b"].map((executionId) => ({ ...startRequest, executionId, concurrency })));
    expect((await adapter.get("a"))?.concurrency).toStrictEqual({ definitionLimit: 1 });
    const reserve = () => adapter.reserveTasks({ kinds: ["workflow"], limit: 3, leaseMs: 10 });
    const [first] = await reserve();
    expect(first).toMatchObject({ id: "task-a", executionId: "a", attempt: 1, createdAt: now, reservedAt: now });
    for (const key of ["parentExecutionId", "commandSequence", "target", "payload"]) {
      expect(first).not.toHaveProperty(key);
    }
    expect(first!.availableAt.getTime()).toBe(now.getTime() + 10);
    await expect(reserve()).resolves.toEqual([]);
    now = new Date(now.getTime() + 10);
    await expect(reserve()).resolves.toMatchObject([{ id: "task-b", executionId: "b", attempt: 1 }]);
  });

  it("starts an ordered batch and resolves return-existing within it", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const concurrency = {
      keyed: {
        key: "user-1",
        limit: 1,
        conflict: "return-existing" as const,
        scope: "execution" as const,
      },
    };

    await expect(adapter.startMany([
      { ...startRequest, executionId: "batch-first", concurrency },
      { ...startRequest, executionId: "batch-second", concurrency },
    ])).resolves.toMatchObject([
      { created: true, execution: { executionId: "batch-first" } },
      { created: false, execution: { executionId: "batch-first" } },
    ]);
    await expect(adapter.get("batch-second")).resolves.toBeUndefined();
  });

  it("attaches return-existing to the admitted execution ahead of an older pending request", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const start = (executionId: string, limit = 1, conflict: "enqueue" | "return-existing" = "enqueue") =>
      adapter.start({ ...startRequest, executionId, concurrency: { keyed: { key: "retained", scope: "execution", limit, conflict } } });
    await expect(adapter.startMany([])).resolves.toEqual([]);
    await expect(start("old-admitted")).resolves.toMatchObject({ execution: { status: "queued" } });
    await expect(start("older-pending")).resolves.toMatchObject({ execution: { status: "pending" } });
    await expect(start("new-admitted", 2)).resolves.toMatchObject({ execution: { status: "queued" } });
    await expect(adapter.forceTerminate("old-admitted", "Released.")).resolves.toBe(true);

    await expect(start("attaching", 1, "return-existing")).resolves.toMatchObject({
      created: false, execution: { executionId: "new-admitted", concurrencyAdmitted: true },
    });
    await expect(adapter.get("older-pending")).resolves.toMatchObject({ status: "pending", concurrencyAdmitted: false });
    await expect(adapter.get("attaching")).resolves.toBeUndefined();
  });

  it("rolls back the complete start batch on a concurrency rejection", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const concurrency = {
      keyed: {
        key: "user-1",
        limit: 1,
        conflict: "reject" as const,
        scope: "execution" as const,
      },
    };

    await expect(adapter.startMany([
      { ...startRequest, executionId: "batch-first", concurrency },
      { ...startRequest, executionId: "batch-second", concurrency },
    ])).rejects.toBeInstanceOf(WorkflowConcurrencyConflictError);
    await expect(adapter.get("batch-first")).resolves.toBeUndefined();
    await expect(adapter.get("batch-second")).resolves.toBeUndefined();
  });

  it("keeps a shared business key local to each definition and honors the reservation limit", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const concurrency = { keyed: { key: "shared", limit: 1, scope: "execution", conflict: "reject" } } as const;
    await expect(adapter.startMany([
      { ...startRequest, concurrency },
      { ...startRequest, executionId: "other-definition", workflowName: "other.run", concurrency },
    ])).resolves.toMatchObject([{ created: true }, { created: true }]);
    const reserve = () => adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    const first = await reserve();
    const second = await reserve();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect([first[0]!.executionId, second[0]!.executionId].sort()).toEqual([startRequest.executionId, "other-definition"].sort());
  });

  it("rejects incompatible repeated requests even when both would attach to a keyed execution", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const concurrency = {
      keyed: { key: "account", limit: 1, conflict: "return-existing", scope: "execution" },
    } as const;
    await adapter.start({ ...startRequest, concurrency });
    const duplicate = { ...startRequest, executionId: "duplicate", concurrency };
    await expect(adapter.startMany([
      { ...startRequest, executionId: "unrelated-prefix" },
      duplicate,
      { ...duplicate, input: { value: "incompatible" } },
    ])).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    await expect(adapter.get("unrelated-prefix")).resolves.toBeUndefined();
    await expect(adapter.get("duplicate")).resolves.toBeUndefined();
    await expect(adapter.startMany([duplicate, duplicate])).resolves.toMatchObject([
      { created: false, execution: { executionId: startRequest.executionId } },
      { created: false, execution: { executionId: startRequest.executionId } },
    ]);
  });

  it("keeps a start batch atomic when a later task identity cannot be allocated", async () => {
    let allocations = 0;
    let fail = true;
    const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
      allocations += 1;
      if (fail && allocations === 2) throw new Error("Could not allocate a task ID.");
      return `task-${allocations}`;
    } });
    const first = { ...startRequest, executionId: "first-allocation" };
    const second = { ...startRequest, executionId: "second-allocation" };
    await expect(adapter.startMany([first, second])).rejects.toThrow("Could not allocate a task ID.");
    await expect(adapter.get(first.executionId)).resolves.toBeUndefined();
    await expect(adapter.get(second.executionId)).resolves.toBeUndefined();
    expect(adapter.inspectTasks()).toEqual([]);

    fail = false;
    await expect(adapter.startMany([first, second])).resolves.toMatchObject([{ created: true }, { created: true }]);
    expect(adapter.inspectTasks()).toMatchObject([{ executionId: first.executionId }, { executionId: second.executionId }]);
  });

  it("starts once and returns a compatible existing execution", async () => {
    const adapter = new MemoryWorkflowAdapter();

    await expect(adapter.start(startRequest)).resolves.toMatchObject({
      created: true,
      execution: {
        executionId: "execution-1",
        workflowVersion: 1,
        status: "queued",
      },
    });
    await expect(adapter.start({
      ...startRequest,
      workflowVersion: 2,
    })).resolves.toMatchObject({
      created: false,
      execution: { workflowVersion: 1 },
    });
  });

  it("rejects incompatible reuse of an execution ID", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);

    await expect(adapter.start({
      ...startRequest,
      input: { value: "different" },
    })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    await expect(adapter.start({
      ...startRequest,
      workflowName: "other.run",
    })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
  });

  it("isolates stored payloads from callers", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const input = { value: "input" };
    const output = { value: "output" };

    const started = await adapter.start({ ...startRequest, input });
    input.value = "mutated";
    (started.execution.input as { value: string }).value = "mutated again";

    adapter.completeExecution(startRequest.executionId, output);
    output.value = "mutated";
    const completed = await adapter.get(startRequest.executionId);

    expect(completed).toMatchObject({
      input: { value: "input" },
      output: { value: "output" },
    });
  });

  it("waits for and deduplicates terminal completion", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);

    let result: Awaited<ReturnType<typeof adapter.waitForTerminal>> | undefined;
    void adapter.waitForTerminal(startRequest.executionId).then((execution) => { result = execution; });
    expect(adapter.completeExecution(startRequest.executionId, { id: "result" }))
      .toBe(true);
    expect(adapter.completeExecution(startRequest.executionId, { id: "other" }))
      .toBe(false);

    // This fixture has only the in-memory completion and its Promise continuations left to drain.
    await setImmediate();
    expect(result).toMatchObject({
      status: "completed",
      output: { id: "result" },
    });

    let settledAgain: typeof result;
    void adapter.waitForTerminal(startRequest.executionId).then((execution) => { settledAgain = execution; });
    await setImmediate();
    expect(settledAgain).toEqual(result);
  });

  it("deduplicates signals and rejects conflicting idempotency reuse", async () => {
    let signalId = 0;
    const adapter = new MemoryWorkflowAdapter({
      createSignalId: () => `signal-${++signalId}`,
    });
    await adapter.start(startRequest);
    const request = {
      executionId: startRequest.executionId,
      workflowName: startRequest.workflowName,
      signalName: "approval.received",
      payload: { approved: true },
      idempotencyKey: "approval-1",
    };

    await expect(adapter.sendSignal(request)).resolves.toEqual({
      id: "signal-1",
      accepted: true,
    });
    request.payload.approved = false;
    expect(adapter.inspectSignals()).toMatchObject([
      { payload: { approved: true } },
    ]);
    request.payload.approved = true;
    await expect(adapter.sendSignal(request)).resolves.toEqual({
      id: "signal-1",
      accepted: false,
    });
    await expect(adapter.sendSignal({
      ...request,
      payload: { approved: false },
    })).rejects.toBeInstanceOf(WorkflowSignalConflictError);
    await expect(adapter.sendSignal({ ...request, signalName: "different.signal" })).rejects.toBeInstanceOf(WorkflowSignalConflictError);
    expect(adapter.inspectSignals()).toHaveLength(1);

    adapter.completeExecution(startRequest.executionId, undefined);
    await expect(adapter.sendSignal(request)).resolves.toEqual({
      id: "signal-1",
      accepted: false,
    });
  });

  it("rejects signals for closed, unknown, or mismatched executions", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);

    await expect(adapter.sendSignal({
      executionId: startRequest.executionId,
      workflowName: "other.run",
      signalName: "approval.received",
      payload: {},
    })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);

    adapter.completeExecution(startRequest.executionId, undefined);
    await expect(adapter.sendSignal({
      executionId: startRequest.executionId,
      workflowName: startRequest.workflowName,
      signalName: "approval.received",
      payload: {},
    })).rejects.toBeInstanceOf(WorkflowExecutionClosedError);

    await expect(adapter.waitForTerminal("unknown"))
      .rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
  });

  it("commits commands and activity completion through owned task leases", async () => {
    let taskId = 0;
    let token = 0;
    const adapter = new MemoryWorkflowAdapter({
      createTaskId: () => `task-${++taskId}`,
      createReservationToken: () => `token-${++token}`,
    });
    await adapter.start(startRequest);
    const [activation] = await adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 1_000,
    });

    expect(activation).toBeDefined();
    expect(activation).toMatchObject({
      workflowName: startRequest.workflowName,
      workflowVersion: startRequest.workflowVersion,
      historyGeneration: 1,
      rootExecutionId: startRequest.executionId,
      kind: "workflow",
    });
    const [loaded] = await adapter.loadActivations([{
      taskId: activation!.id,
      reservationToken: activation!.reservationToken,
    }]);
    const snapshot = loaded?.snapshot;
    expect(snapshot).toMatchObject({ revision: 0, history: [] });
    await expect(adapter.commitActivation({
      taskId: activation!.id,
      reservationToken: activation!.reservationToken,
      executionId: startRequest.executionId,
      expectedRevision: 0,
      commands: [{
        sequence: 0,
        kind: "activity",
        target: "example.read",
        payload: { id: 1 },
      }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);

    const [activity] = await adapter.reserveTasks({
      kinds: ["activity"],
      limit: 1,
      leaseMs: 1_000,
    });
    expect(activity).toMatchObject({
      workflowName: startRequest.workflowName,
      workflowVersion: startRequest.workflowVersion,
      historyGeneration: 1,
      rootExecutionId: startRequest.executionId,
      kind: "activity",
    });
    await expect(adapter.completeActivities([{
      taskId: activity!.id,
      reservationToken: activity!.reservationToken,
      executionId: startRequest.executionId,
      sequence: 0,
      status: "completed",
      result: { value: "result" },
    }])).resolves.toEqual([{
      taskId: activity!.id,
      reservationToken: activity!.reservationToken,
    }]);

    await expect(adapter.getHistory(startRequest.executionId))
      .resolves.toMatchObject([
        { type: "command-scheduled", sequence: 0 },
        { type: "command-completed", sequence: 0, completionOrder: 0 },
      ]);
    await expect(adapter.get(startRequest.executionId)).resolves.toMatchObject({
      status: "queued",
      revision: 2,
    });
  });

  it("loads owned workflow activations as one batch", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    await adapter.start({
      ...startRequest,
      executionId: "execution-2",
    });
    const tasks = await adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 2,
      leaseMs: 1_000,
    });
    const loaded = await adapter.loadActivations([
      ...tasks.map((task) => ({
        taskId: task.id,
        reservationToken: task.reservationToken,
      })),
      { taskId: "stale-task", reservationToken: "stale-token" },
    ]);

    expect(loaded.map(({ taskId }) => taskId).sort())
      .toEqual(tasks.map(({ id }) => id).sort());
    expect(loaded.map(({ snapshot }) => snapshot.executionId).sort())
      .toEqual(["execution-1", "execution-2"]);
  });

  it("rejects stale, wrong-kind and cross-task activity completions", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    await adapter.start(startRequest);
    const [activation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    const ref = (task: { id: string; reservationToken: string }) => ({ taskId: task.id, reservationToken: task.reservationToken });
    await expect(adapter.commitActivation({
      ...ref(activation!), executionId: startRequest.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "example.read", payload: null }], outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const reserveActivity = async () => (await adapter.reserveTasks({ kinds: ["activity"], limit: 1, leaseMs: 100 }))[0]!;
    const former = await reserveActivity();
    await expect(adapter.get(startRequest.executionId)).resolves.toMatchObject({ status: "waiting", revision: 1 });
    now = new Date(now.getTime() + 100);
    const current = await reserveActivity();
    await adapter.sendSignal({
      executionId: startRequest.executionId, workflowName: startRequest.workflowName,
      signalName: "unrelated", payload: null,
    });
    const [workflow] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    const completion = { ...ref(current), executionId: startRequest.executionId, sequence: 0, status: "completed", result: null } as const;
    const tasks = adapter.inspectTasks();
    for (const invalid of [
      { ...completion, ...ref(former) },
      { ...completion, ...ref(workflow!) },
      { ...completion, executionId: "another-execution" },
      { ...completion, sequence: 1 },
    ]) {
      await expect(adapter.completeActivities([invalid])).resolves.toEqual([]);
    }
    const retryAt = new Date(now.getTime() + 1_000);
    const error = { name: "InfrastructureFailure", message: "Retry." };
    await expect(adapter.retryTask({ ...ref(former), retryAt, error })).resolves.toBe(false);
    await expect(adapter.retryTask({ ...ref(workflow!), retryAt, error })).resolves.toBe(false);
    expect(adapter.inspectTasks()).toEqual(tasks);
    await expect(adapter.completeActivities([completion])).resolves.toEqual([ref(current)]);
    await expect(adapter.completeActivities([completion])).resolves.toEqual([]);
    expect((await adapter.getHistory(startRequest.executionId)).at(-1)).toMatchObject({ type: "command-completed", sequence: 0, result: null });
  });

  it("reschedules an owned activity at a detached retry time", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const executionId = startRequest.executionId;
    const reserve = (kind: "workflow" | "activity") => adapter.reserveTasks({ kinds: [kind], limit: 1, leaseMs: 100 });
    await adapter.start(startRequest);
    const [workflow] = await reserve("workflow");
    await expect(adapter.commitActivation({
      taskId: workflow!.id, reservationToken: workflow!.reservationToken, executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "work", payload: null }], outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const [activity] = await reserve("activity");
    const dueAt = new Date(now.getTime() + 1000);
    const retryAt = new Date(dueAt);
    const request = { taskId: activity!.id, reservationToken: activity!.reservationToken, retryAt, error: { name: "Retry", message: "Temporary." } };
    await expect(adapter.retryTask(request)).resolves.toBe(true);
    retryAt.setTime(0);
    await expect(adapter.retryTask(request)).resolves.toBe(false);
    const [stored] = adapter.inspectTasks();
    expect(stored).toMatchObject({ id: activity!.id, availableAt: dueAt, attempt: 1 });
    expect(stored).not.toHaveProperty("reservedAt");
    expect(stored).not.toHaveProperty("reservationToken");
    await expect(reserve("activity")).resolves.toEqual([]);
    now = dueAt;
    const [reclaimed] = await reserve("activity");
    expect(reclaimed).toMatchObject({ id: activity!.id, attempt: 2, reservedAt: dueAt });
    expect(reclaimed!.reservationToken).not.toBe(activity!.reservationToken);
  });

  it("keeps the reservation and journal intact when a later child conflicts", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    await adapter.start(startRequest);
    const [activation] = await adapter.reserveTasks({
      kinds: ["workflow"], limit: 1, leaseMs: 1_000,
    });
    const occupiedId = "occupied-child";
    await adapter.start({ ...startRequest, executionId: occupiedId });
    const commit = {
      taskId: activation!.id,
      reservationToken: activation!.reservationToken,
      executionId: startRequest.executionId,
      expectedRevision: 0,
      outcome: { status: "waiting" },
    } as const;
    const commands = [
      { sequence: 0, kind: "activity", target: "example.read", payload: null },
      { sequence: 1, kind: "child", target: "example.child", payload: { input: null, version: 1 } },
    ] as const;

    // Both the outbox row and the valid child must remain invisible on rejection.
    await expect(adapter.commitActivation({
      ...commit,
      commands: [...commands, {
        sequence: 2,
        kind: "child",
        target: startRequest.workflowName,
        payload: { input: startRequest.input, version: 1, executionId: occupiedId },
      }],
    })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toEqual([]);
    await expect(adapter.get(`${startRequest.executionId}:1`)).resolves.toBeUndefined();
    await expect(adapter.loadActivations([commit])).resolves.toMatchObject([
      { snapshot: { revision: 0, history: [] } },
    ]);
    expect(adapter.inspectActivityDispatches()).toEqual([]);

    await expect(adapter.commitActivation({ ...commit, commands })).resolves.toBe(true);
    await expect(adapter.get(`${startRequest.executionId}:1`)).resolves.toMatchObject({
      parentExecutionId: startRequest.executionId,
      parentCommandSequence: 1,
      status: "queued",
    });
    expect(adapter.inspectActivityDispatches()).toMatchObject([{ sequence: 0 }]);
  });

  it("rejects a linked child whose definition or input differs from the scheduled command", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const [activation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    const child = {
      executionId: "linked-child",
      workflowName: "example.child",
      workflowVersion: 2,
      input: { value: "child input" },
      parentExecutionId: startRequest.executionId,
      parentCommandSequence: 0,
    };
    await adapter.start(child);

    const command = {
      sequence: 0,
      kind: "child",
      target: child.workflowName,
      payload: { executionId: child.executionId, version: child.workflowVersion, input: child.input },
    } as const;
    const commit = {
      taskId: activation!.id,
      reservationToken: activation!.reservationToken,
      executionId: startRequest.executionId,
      expectedRevision: 0,
      outcome: { status: "waiting" },
    } as const;

    // Matching lineage alone cannot establish the identity of an existing child.
    for (const incompatible of [
      { ...command, sequence: 1 },
      { ...command, target: "example.wrong-child" },
      { ...command, payload: { ...command.payload, version: 1 } },
      { ...command, payload: { ...command.payload, input: { value: "different input" } } },
    ]) {
      const commands = incompatible.sequence === 0 ? [incompatible] : [
        { sequence: 0, kind: "capture", target: "first", payload: null },
        incompatible,
      ];
      await expect(adapter.commitActivation({ ...commit, commands }))
        .rejects.toBeInstanceOf(WorkflowExecutionConflictError);
      await expect(adapter.getHistory(startRequest.executionId)).resolves.toEqual([]);
    }

    await expect(adapter.commitActivation({ ...commit, commands: [command] })).resolves.toBe(true);
    await expect(adapter.get(child.executionId)).resolves.toMatchObject(child);
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === child.executionId)).toHaveLength(1);
  });

  it("validates every sequence and timer payload before scheduling work", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const [activation] = await adapter.reserveTasks({
      kinds: ["workflow"], limit: 1, leaseMs: 1_000,
    });
    const commit = {
      taskId: activation!.id,
      reservationToken: activation!.reservationToken,
      executionId: startRequest.executionId,
      expectedRevision: 0,
      outcome: { status: "waiting" },
    } as const;
    const originalTasks = adapter.inspectTasks();
    const activity = { sequence: 0, kind: "activity", target: "example.read", payload: null } as const;
    const timer = { sequence: 1, kind: "timer", target: "sleep", payload: { durationMs: 10 } } as const;

    await expect(adapter.commitActivation({ ...commit, commands: [activity, { ...timer, sequence: 2 }] }))
      .rejects.toThrow("Expected workflow command sequence 1, received 2.");
    await expect(adapter.commitActivation({ ...commit, commands: [activity, { ...timer, payload: {} }] }))
      .rejects.toThrow('Workflow command field "durationMs" must be non-negative.');
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toEqual([]);
    expect(adapter.inspectTasks()).toEqual(originalTasks);
    await expect(adapter.commitActivation({ ...commit, commands: [activity, timer] })).resolves.toBe(true);
    expect(adapter.inspectTasks().map(({ commandSequence, kind }) => ({ commandSequence, kind })))
      .toEqual([{ commandSequence: 0, kind: "activity" }, { commandSequence: 1, kind: "timer" }]);
  });

  it("rejects malformed command metadata without publishing an activation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    const request = {
      taskId: task!.id, reservationToken: task!.reservationToken,
      executionId: startRequest.executionId, expectedRevision: 0, outcome: { status: "waiting" },
    } as const;
    const keyed = { key: "account", limit: 1, conflict: "enqueue", scope: "execution" } as const;
    const invalid: [string, WorkflowPayload, string?][] = [
      ["unknown", null, 'Unsupported workflow command kind "unknown".'],
      ["timer", null, "Workflow command payload must be an object."],
      ["timer", []], ["timer", "duration", "Workflow command payload must be an object."],
      ["timer", { durationMs: -1 }, 'Workflow command field "durationMs" must be non-negative.'],
      ["timer", { durationMs: 0.5 }], ["signal", { timeoutMs: "soon" }],
      ["child", { version: 1 }, 'Workflow command field "input" is required.'],
      ["child", { input: null, version: 1, executionId: "" }, 'Workflow command field "executionId" must be non-empty.'],
      ["child", { version: 1, input: null, executionId: 5 }],
      ["child", { input: null, version: 1, concurrency: null }, "Workflow child concurrency must be an object."],
      ["child", { version: 1, input: null, concurrency: [] }],
      ["child", { input: null, version: 1, concurrency: { definitionLimit: "1" } }, "Workflow definition concurrency limit is invalid."],
      ["child", { version: 1, input: null, concurrency: { definitionLimit: 0 } }],
      ["child", { version: 1, input: null, concurrency: { definitionLimit: 1.5 } }],
      ["child", { version: 1, input: null, concurrency: { keyed: true } }],
      ["child", { input: null, version: 1, concurrency: { keyed: null } }, "Workflow keyed concurrency must be an object."],
      ["child", { input: null, version: 1, concurrency: { keyed: [] } }, "Workflow keyed concurrency must be an object."],
    ];
    // The PostgreSQL adapter normalizes every child conflict policy to enqueue.
    for (const patch of [{ key: "" }, { key: 1 }, { limit: "1" }, { limit: 0 }, { limit: 1.5 }, { conflict: "unknown" }, { scope: "unknown" }]) {
      invalid.push(["child", { version: 1, input: null, concurrency: { keyed: { ...keyed, ...patch } } }, "Workflow keyed concurrency metadata is invalid."]);
    }
    const tasks = adapter.inspectTasks();
    for (const [kind, payload, diagnostic] of invalid) {
      await expect(adapter.commitActivation({ ...request, commands: [{ kind, payload, sequence: 0, target: "invalid" }] }))
        .rejects.toThrow(diagnostic ?? TypeError);
    }
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toEqual([]);
    expect(adapter.inspectTasks()).toEqual(tasks);
  });

  it("admits prepared children in command order under a shared retained permit", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const [parent] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    const childConcurrency = { definitionLimit: 2, keyed: { key: "same-key", limit: 1, scope: "execution", conflict: "return-existing" } };
    await expect(adapter.commitActivation({
      taskId: parent!.id, reservationToken: parent!.reservationToken,
      executionId: startRequest.executionId, expectedRevision: 0, outcome: { status: "waiting" },
      commands: [0, 1].map((sequence) => ({
        sequence, kind: "child", target: "example.child",
        payload: { input: null, version: 2, concurrency: childConcurrency },
      })),
    })).resolves.toBe(true);
    childConcurrency.keyed.key = "outside change";

    const firstId = `${startRequest.executionId}:0`;
    const secondId = `${startRequest.executionId}:1`;
    await expect(adapter.get(firstId)).resolves.toMatchObject({
      workflowVersion: 2, status: "queued", concurrencyAdmitted: true, parentCommandSequence: 0,
      concurrency: { definitionLimit: 2, keyed: { key: "same-key", limit: 1, conflict: "enqueue", scope: "execution" } },
    });
    await expect(adapter.get(secondId)).resolves.toMatchObject({ status: "pending", concurrencyAdmitted: false });
    const [first] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await expect(adapter.commitActivation({
      taskId: first!.id, reservationToken: first!.reservationToken, executionId: firstId,
      expectedRevision: 0, commands: [], outcome: { status: "completed", output: null },
    })).resolves.toBe(true);
    await expect(adapter.get(secondId)).resolves.toMatchObject({ status: "queued", concurrencyAdmitted: true });
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === secondId)).toHaveLength(1);
  });

  it("creates a distinct default child after the parent continues as new", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const executionId = startRequest.executionId;
    const reserve = async () => (await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 }))[0];
    const ref = (task: { id: string; reservationToken: string }) => ({ taskId: task.id, reservationToken: task.reservationToken });
    const spawnChild = async () => {
      const parent = await reserve();
      await expect(adapter.commitActivation({
        ...ref(parent!), executionId, expectedRevision: 0,
        commands: [{ sequence: 0, kind: "child", target: "example.child", payload: { version: 1, input: null } }],
        outcome: { status: "waiting" },
      })).resolves.toBe(true);
      return reserve();
    };
    const first = await spawnChild();
    expect(first).toMatchObject({ executionId: `${executionId}:0`, parentExecutionId: executionId });
    await expect(adapter.commitActivation({
      ...ref(first!), executionId: first!.executionId, expectedRevision: 0,
      commands: [], outcome: { status: "completed", output: null },
    })).resolves.toBe(true);
    const continuation = await reserve();
    await expect(adapter.continueAsNew({
      ...ref(continuation!), executionId, expectedRevision: 2, workflowVersion: 1, input: null,
    })).resolves.toBe(true);

    const second = await spawnChild();
    expect(second).toMatchObject({ executionId: `${executionId}:0:generation-2`, parentExecutionId: executionId });
    await expect(adapter.get(first!.executionId)).resolves.toMatchObject({ status: "completed", output: null });
  });

  it("rejects a valid reservation of the wrong task kind or execution", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const reserve = () => adapter.reserveTasks({ kinds: ["workflow", "activity"], limit: 2, leaseMs: 1_000 });
    const [initial] = await reserve();
    const initialCommit = {
      taskId: initial!.id,
      reservationToken: initial!.reservationToken,
      executionId: startRequest.executionId,
      expectedRevision: 0,
    };
    await expect(adapter.commitActivation({
      ...initialCommit,
      commands: [
        { sequence: 0, kind: "activity", target: "example.read", payload: null },
        { sequence: 1, kind: "capture", target: "snapshot", payload: 5 },
      ],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);

    const tasks = await reserve();
    const workflow = tasks.find(({ kind }) => kind === "workflow")!;
    const activity = tasks.find(({ kind }) => kind === "activity")!;
    const outcome = { status: "completed" } as const;
    const request = { ...initialCommit, expectedRevision: 3, commands: [], outcome };
    const tasksBefore = adapter.inspectTasks();
    await expect(adapter.commitActivation({ ...request, taskId: activity.id, reservationToken: activity.reservationToken }))
      .resolves.toBe(false);
    await expect(adapter.commitActivation({
      ...request,
      taskId: workflow.id,
      reservationToken: workflow.reservationToken,
      executionId: "different-execution",
    })).resolves.toBe(false);
    expect(adapter.inspectTasks()).toEqual(tasksBefore);
    await expect(adapter.get(startRequest.executionId)).resolves.toMatchObject({ status: "running", revision: 3 });
  });

  it.each([
    { status: "completed" },
    { status: "failed", error: { name: "ActivationFailure", message: "Failed." } },
    { status: "cancelled" },
  ] as const)("removes pending tasks and cancels open children when a parent is $status", async (outcome) => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const reserve = async () => (await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 }))
      .find(({ executionId }) => executionId === startRequest.executionId)!;
    const initial = await reserve();
    await expect(adapter.commitActivation({
      taskId: initial.id,
      reservationToken: initial.reservationToken,
      executionId: startRequest.executionId,
      expectedRevision: 0,
      commands: [
        { sequence: 0, kind: "activity", target: "example.read", payload: null },
        { sequence: 1, kind: "child", target: "example.child", payload: { input: null, version: 1 } },
      ],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    await adapter.sendSignal({
      executionId: startRequest.executionId, workflowName: startRequest.workflowName,
      signalName: "example.wake", payload: null,
    });

    const next = await reserve();
    await expect(adapter.commitActivation({
      taskId: next.id,
      reservationToken: next.reservationToken,
      executionId: startRequest.executionId,
      expectedRevision: 3,
      commands: [],
      outcome,
    })).resolves.toBe(true);
    const terminal = await adapter.get(startRequest.executionId);
    expect(terminal).toMatchObject({ ...outcome, completedAt: expect.any(Date), revision: 3 });
    expect(terminal).not.toHaveProperty("output");
    expect(adapter.inspectTasks().filter(({ executionId }) => executionId === startRequest.executionId)).toEqual([]);
    await expect(adapter.get(`${startRequest.executionId}:1`)).resolves.toMatchObject({ cancellationRequested: true });
  });

  it("wakes a waiting parent when its running child commits cancellation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const reserve = async () => (await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 }))[0]!;
    const reference = (task: { id: string; reservationToken: string }) => ({ taskId: task.id, reservationToken: task.reservationToken });
    const parent = await reserve();
    await expect(adapter.commitActivation({
      ...reference(parent), executionId: startRequest.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "child", target: "example.child", payload: { input: null, version: 1 } }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const child = await reserve();
    await expect(adapter.commitActivation({
      ...reference(child), executionId: child.executionId, expectedRevision: 0, commands: [], outcome: { status: "cancelled" },
    })).resolves.toBe(true);
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toMatchObject([
      { type: "command-scheduled", sequence: 0 },
      { type: "command-completed", sequence: 0, completionOrder: 0, error: { name: "WorkflowCancellationError", details: { executionId: child.executionId } } },
    ]);
    await expect(reserve()).resolves.toMatchObject({ executionId: startRequest.executionId });
  });

  it("records a buffered signal but keeps a blocked activation blocked", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const reserve = async () => (await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 }))[0]!;
    const commit = async (request: Pick<Parameters<typeof adapter.commitActivation>[0], "expectedRevision" | "commands" | "outcome">) => {
      const task = await reserve();
      return adapter.commitActivation({
        ...request, taskId: task.id, reservationToken: task.reservationToken, executionId: startRequest.executionId,
      });
    };
    await expect(commit({
      expectedRevision: 0,
      commands: [{ sequence: 0, kind: "signal", target: "example.signal", payload: { timeoutMs: 100 } }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const receipt = await adapter.sendSignal({
      executionId: startRequest.executionId, workflowName: startRequest.workflowName,
      signalName: "example.signal", payload: null,
    });

    const error = { name: "WorkflowNondeterminismError", message: "Replay diverged." };
    await expect(commit({ expectedRevision: 2, commands: [], outcome: { status: "blocked", error } })).resolves.toBe(true);
    await expect(adapter.get(startRequest.executionId)).resolves.toMatchObject({
      status: "blocked", revision: 3, error, concurrencyAdmitted: true,
    });
    expect(adapter.inspectTasks()).toEqual([]);
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toMatchObject([
      { type: "command-scheduled", sequence: 0 },
      { type: "signal-received", signalId: receipt.id },
      { type: "command-completed", sequence: 0, result: null, sourceId: receipt.id },
    ]);
  });

  it("recovers only the requested version-blocked execution and clears its error", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    await adapter.start({ ...startRequest, executionId: "incompatible-history" });
    const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 2, leaseMs: 1_000 });
    for (const task of tasks) {
      const name = task.executionId === startRequest.executionId
        ? "WorkflowExecutionVersionUnsupportedError" : "WorkflowNondeterminismError";
      await expect(adapter.commitActivation({
        taskId: task.id, reservationToken: task.reservationToken, executionId: task.executionId,
        expectedRevision: 0, commands: [], outcome: { status: "blocked", error: { name, message: "Blocked." } },
      })).resolves.toBe(true);
    }
    const request = { executionId: startRequest.executionId, workflowName: startRequest.workflowName, workflowVersion: 1 };
    for (const invalid of [{ ...request, executionId: "missing" }, { ...request, workflowName: "wrong" },
      { ...request, workflowVersion: 2 }, { ...request, executionId: "incompatible-history" }]) {
      await expect(adapter.recoverVersionBlockedExecution(invalid)).resolves.toBe(false);
    }
    expect(adapter.inspectTasks()).toEqual([]);
    await expect(adapter.recoverVersionBlockedExecution(request)).resolves.toBe(true);
    await expect(adapter.recoverVersionBlockedExecution(request)).resolves.toBe(false);
    const recovered = await adapter.get(request.executionId);
    expect(recovered).toMatchObject({ status: "queued", revision: 0 });
    expect(recovered).not.toHaveProperty("error");
    expect(adapter.inspectTasks()).toMatchObject([{ executionId: request.executionId, kind: "workflow" }]);
  });

  it("preserves earlier compensation work when a later activation adds more", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    const commit = async (commands: Parameters<typeof adapter.commitActivation>[0]["commands"]) => {
      const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
      const reservation = { taskId: task!.id, reservationToken: task!.reservationToken };
      const [loaded] = await adapter.loadActivations([reservation]);
      return adapter.commitActivation({
        ...reservation,
        executionId: startRequest.executionId,
        expectedRevision: loaded!.snapshot.revision,
        commands,
        outcome: { status: "waiting" },
      });
    };
    await expect(commit([{ sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 60_000 } }]))
      .resolves.toBe(true);
    await expect(adapter.requestCancellation(startRequest.executionId)).resolves.toBe(true);
    await expect(commit([
      { sequence: 1, kind: "activity", target: "undo.first", payload: null },
      { sequence: 2, kind: "capture", target: "checkpoint", payload: 1 },
    ])).resolves.toBe(true);

    await expect(commit([{ sequence: 3, kind: "activity", target: "undo.second", payload: null }]))
      .resolves.toBe(true);
    expect(adapter.inspectTasks()).toMatchObject([
      { kind: "activity", commandSequence: 1, target: "undo.first" },
      { kind: "activity", commandSequence: 3, target: "undo.second" },
    ]);
  });

  it("dispatches Worker compensation while keeping pre-cancellation outbox work idle", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    await adapter.start(startRequest);
    const [original] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await expect(adapter.commitActivation({
      taskId: original!.id, reservationToken: original!.reservationToken,
      executionId: startRequest.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "effect.original", payload: null }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    await expect(adapter.requestCancellation(startRequest.executionId)).resolves.toBe(true);

    const dispatchOptions = { limit: 10, leaseMs: 1_000 };
    await expect(adapter.reserveActivityDispatches(dispatchOptions)).resolves.toEqual([]);
    const [compensation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await expect(adapter.commitActivation({
      taskId: compensation!.id, reservationToken: compensation!.reservationToken,
      executionId: startRequest.executionId, expectedRevision: 2,
      commands: [{ sequence: 1, kind: "activity", target: "effect.undo", payload: null }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    await expect(adapter.reserveActivityDispatches(dispatchOptions)).resolves.toMatchObject([
      { sequence: 1, target: "effect.undo", historyGeneration: 1 },
    ]);
  });

  it.each(["versioned", "legacy"] as const)("fences old Worker results after continue-as-new (%s)", async (format) => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    await adapter.start(startRequest);
    const reserve = async () => (await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 }))[0]!;
    const activity = { sequence: 0, kind: "activity", target: "example.read", payload: null } as const;
    const activation = await reserve();
    const request = { executionId: startRequest.executionId, expectedRevision: 0, commands: [activity], outcome: { status: "waiting" } } as const;
    await expect(adapter.commitActivation({ ...request, taskId: activation.id, reservationToken: activation.reservationToken })).resolves.toBe(true);
    const [firstDispatch] = await adapter.reserveActivityDispatches({ limit: 2, leaseMs: 1_000 });
    const previous = { executionId: startRequest.executionId, sequence: 0, sourceId: "old-job", dispatchId: firstDispatch!.id, status: "completed", result: "first" } as const;
    await expect(adapter.completeExternalActivity(previous)).resolves.toBe(true);

    const rotation = await reserve();
    await expect(adapter.continueAsNew({
      taskId: rotation.id, reservationToken: rotation.reservationToken,
      executionId: startRequest.executionId, expectedRevision: 2, workflowVersion: 1, input: null,
    })).resolves.toBe(true);
    const successor = await reserve();
    await expect(adapter.commitActivation({ ...request, taskId: successor.id, reservationToken: successor.reservationToken })).resolves.toBe(true);
    const current = await adapter.getHistory(startRequest.executionId);
    await expect(adapter.completeExternalActivity(previous)).resolves.toBe(true);
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toEqual(current);
    await expect(adapter.completeExternalActivity({ ...previous, historyGeneration: 3 })).resolves.toBe(false);
    const [currentDispatch] = await adapter.reserveActivityDispatches({ limit: 2, leaseMs: 1_000 });
    expect(currentDispatch).toMatchObject({ historyGeneration: 2, sequence: 0 });
    await expect(adapter.completeExternalActivity({ ...previous, dispatchId: currentDispatch!.id, sequence: 99 }))
      .resolves.toBe(true);
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toEqual(current);
    await expect(adapter.completeExternalActivity({
      ...previous, ...(format === "versioned" ? { historyGeneration: 2 } : { dispatchId: currentDispatch!.id }),
      sourceId: "new-job", result: "second",
    })).resolves.toBe(true);
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toMatchObject([
      { type: "command-scheduled", sequence: 0 },
      { type: "command-completed", sequence: 0, sourceId: "new-job", result: "second" },
    ]);
  });

  it.each(["embedded", "outbox"] as const)("owns error details in %s completions", async (activityDispatchMode) => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode });
    await adapter.start(startRequest);
    const [activation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await expect(adapter.commitActivation({
      taskId: activation!.id, reservationToken: activation!.reservationToken,
      executionId: startRequest.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "example.read", payload: null }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const details = { executionId: startRequest.executionId, sequence: 0 };
    const failure = {
      executionId: startRequest.executionId, sequence: 0, status: "failed",
      error: { name: "ActivityFailure", message: "Failed.", details },
    } as const;
    if (activityDispatchMode === "outbox") {
      await expect(adapter.completeExternalActivity({ ...failure, sourceId: "worker" })).resolves.toBe(true);
    } else {
      const [task] = await adapter.reserveTasks({ kinds: ["activity"], limit: 1, leaseMs: 1_000 });
      const reservation = { taskId: task!.id, reservationToken: task!.reservationToken };
      await expect(adapter.completeActivities([{ ...failure, ...reservation }])).resolves.toEqual([reservation]);
    }

    details.sequence = 42;
    await expect(adapter.getHistory(startRequest.executionId)).resolves.toMatchObject([
      { type: "command-scheduled" },
      { type: "command-completed", error: { details: { executionId: startRequest.executionId, sequence: 0 } } },
    ]);
  });

  it("only retries or publishes outbox work for the current reservation", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now, activityDispatchMode: "outbox" });
    await adapter.start(startRequest);
    const [activation] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await expect(adapter.commitActivation({
      taskId: activation!.id, reservationToken: activation!.reservationToken,
      executionId: startRequest.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "example.read", payload: { value: "stable" } }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const dispatches = () => adapter.reserveActivityDispatches({ limit: 1, leaseMs: 100 });
    await adapter.setPaused(startRequest.executionId, true);
    await expect(dispatches()).resolves.toEqual([]);
    await adapter.setPaused(startRequest.executionId, false);
    const [first] = await dispatches();
    const firstRef = { dispatchId: first!.id, reservationToken: first!.reservationToken };
    adapter.inspectActivityDispatches()[0]!.reservedAt!.setUTCFullYear(2030);
    expect(adapter.inspectActivityDispatches()[0]!.reservedAt).toEqual(now);
    await expect(dispatches()).resolves.toEqual([]);

    now = new Date(now.getTime() + 100);
    const [second] = await dispatches();
    expect(second).toMatchObject({ id: first!.id, attempt: 2, reservedAt: now, payload: { value: "stable" } });
    expect(second!.reservationToken).not.toBe(first!.reservationToken);
    const secondRef = { dispatchId: second!.id, reservationToken: second!.reservationToken };
    const retryAt = new Date(now.getTime() + 10_000);
    await expect(adapter.markActivityDispatchesPublished([firstRef])).resolves.toEqual([]);
    await expect(adapter.retryActivityDispatches([{ ...firstRef, retryAt }])).resolves.toEqual([]);
    await expect(adapter.retryActivityDispatches([{ ...secondRef, retryAt }])).resolves.toEqual([secondRef]);
    expect(adapter.inspectActivityDispatches()[0]).toMatchObject({ availableAt: retryAt, attempt: 2 });
    expect(adapter.inspectActivityDispatches()[0]).not.toHaveProperty("reservationToken");
    await expect(adapter.markActivityDispatchesPublished([secondRef])).resolves.toEqual([]);
    await expect(dispatches()).resolves.toEqual([]);

    now = retryAt;
    const [third] = await dispatches();
    const thirdRef = { dispatchId: third!.id, reservationToken: third!.reservationToken };
    await expect(adapter.markActivityDispatchesPublished([thirdRef])).resolves.toEqual([thirdRef]);
    expect(adapter.inspectActivityDispatches()[0]).toMatchObject({ attempt: 3, publishedAt: now });
    adapter.inspectActivityDispatches()[0]!.publishedAt!.setUTCFullYear(2030);
    expect(adapter.inspectActivityDispatches()[0]!.publishedAt).toEqual(now);
    expect(adapter.inspectActivityDispatches()[0]).not.toHaveProperty("reservedAt");
    now = new Date(now.getTime() + 100);
    await expect(dispatches()).resolves.toEqual([]);
  });

  it("keeps the original generation retryable when allocating a continuation task fails", async () => {
    let rejectWake = false;
    let nextTask = 0;
    const failure = new Error("No continuation task ID available.");
    const adapter = new MemoryWorkflowAdapter({ createTaskId: () => {
      if (rejectWake) throw failure;
      return `task-${++nextTask}`;
    } });
    await adapter.start(startRequest);
    const executionId = startRequest.executionId;
    const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1000 });
    const signalRequest = { executionId, workflowName: startRequest.workflowName, signalName: "ready", payload: 7, idempotencyKey: "ready" };
    const signal = await adapter.sendSignal(signalRequest);
    const request = { taskId: task!.id, reservationToken: task!.reservationToken, executionId, expectedRevision: 1, workflowVersion: 2, input: "new input" };
    const initial = await adapter.get(executionId);
    const history = await adapter.getHistory(executionId);
    const tasks = adapter.inspectTasks();

    rejectWake = true;
    await expect(adapter.continueAsNew(request)).rejects.toBe(failure);
    await expect(adapter.get(executionId)).resolves.toEqual(initial);
    await expect(adapter.getHistory(executionId)).resolves.toEqual(history);
    await expect(adapter.getHistoryArchives(executionId)).resolves.toEqual([]);
    await expect(adapter.sendSignal(signalRequest)).resolves.toEqual({ ...signal, accepted: false });
    expect(adapter.inspectTasks()).toEqual(tasks);

    rejectWake = false;
    await expect(adapter.continueAsNew(request)).resolves.toBe(true);
    await expect(adapter.getHistoryArchives(executionId)).resolves.toMatchObject([{ historyGeneration: 1, history }]);
    await expect(adapter.get(executionId)).resolves.toMatchObject({ historyGeneration: 2, workflowVersion: 2, revision: 0, input: "new input" });
    expect(adapter.inspectTasks()).toMatchObject([{ executionId, attempt: 0 }]);
  });

  it("rejects rotation while work is pending and resets only the continued execution", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const executionId = startRequest.executionId;
    const peer = "unrelated-execution";
    const reserve = async () => (await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 }))
      .find((task) => task.executionId === executionId)!;
    const reference = (task: { id: string; reservationToken: string }) => ({
      taskId: task.id, reservationToken: task.reservationToken,
    });
    await adapter.start(startRequest);
    await adapter.start({ ...startRequest, executionId: peer });
    const original = await reserve();
    await expect(adapter.commitActivation({
      ...reference(original), executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 10 } }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const signal = (id: string) => adapter.sendSignal({
      executionId: id, workflowName: startRequest.workflowName,
      signalName: "event.ready", idempotencyKey: "source", payload: { data: "before" },
    });
    const receivedAt = new Date(now);
    const oldSignal = await signal(executionId);
    const otherSignal = await signal(peer);
    const continuation = await reserve();
    const request = { ...reference(continuation), executionId, expectedRevision: 2, workflowVersion: 2, input: { generation: 2 } };
    const tasks = adapter.inspectTasks();

    await expect(adapter.continueAsNew(request)).rejects.toThrow("pending command 0");
    await expect(adapter.continueAsNew({ ...request, expectedRevision: 1 })).rejects.toThrow("journal revision");
    await expect(adapter.continueAsNew({ ...request, reservationToken: "obsolete" })).resolves.toBe(false);
    await expect(adapter.continueAsNew({ ...request, executionId: peer })).resolves.toBe(false);
    expect(adapter.inspectTasks()).toEqual(tasks);
    await expect(adapter.getHistoryArchives(executionId)).resolves.toEqual([]);

    now = new Date(now.getTime() + 10);
    const [timer] = await adapter.reserveTasks({ kinds: ["timer"], limit: 1, leaseMs: 1_000 });
    await expect(adapter.completeActivities([{
      ...reference(timer!), executionId, sequence: 0, status: "completed", result: null,
    }])).resolves.toEqual([reference(timer!)]);
    await expect(adapter.continueAsNew({ ...request, expectedRevision: 3 })).resolves.toBe(true);

    const [archive] = await adapter.getHistoryArchives(executionId);
    expect(archive).toMatchObject({
      executionId, historyGeneration: 1, workflowVersion: 1, input: startRequest.input, continuedAt: now,
      history: [
        { type: "command-scheduled", eventIndex: 0 },
        { type: "signal-received", eventIndex: 1, signalId: oldSignal.id },
        { type: "command-completed", eventIndex: 2, result: null },
      ],
    });
    archive!.continuedAt.setTime(0);
    (archive!.input as { value: string }).value = "changed";
    const archivedSignal = archive!.history[1]!;
    archivedSignal.occurredAt.setTime(0);
    if (archivedSignal.type !== "signal-received") throw new Error("Expected an archived signal.");
    (archivedSignal.payload as { data: string }).data = "changed";
    await expect(adapter.getHistoryArchives(executionId)).resolves.toMatchObject([{
      continuedAt: now, input: { value: "input" },
      history: [
        { type: "command-scheduled" },
        { type: "signal-received", payload: { data: "before" }, occurredAt: receivedAt },
        { type: "command-completed" },
      ],
    }]);
    await expect(adapter.get(executionId)).resolves.toMatchObject({ historyGeneration: 2, workflowVersion: 2, revision: 0, input: request.input });
    await expect(adapter.getHistory(executionId)).resolves.toEqual([]);
    expect(adapter.inspectSignals(executionId)).toEqual([]);
    expect(adapter.inspectSignals(peer)).toMatchObject([{ id: otherSignal.id }]);
    await expect(adapter.loadActivations([reference(continuation)])).resolves.toEqual([]);
    await expect(signal(executionId)).resolves.toMatchObject({ id: expect.not.stringMatching(oldSignal.id), accepted: true });
    await expect(signal(peer)).resolves.toEqual({ id: otherSignal.id, accepted: false });
  });

  it("rejects stale reservation generations after lease recovery", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let token = 0;
    const adapter = new MemoryWorkflowAdapter({
      now: () => now,
      createReservationToken: () => `token-${++token}`,
    });
    await adapter.start(startRequest);
    const [first] = await adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 100,
    });
    now = new Date(now.getTime() + 101);
    const [recovered] = await adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 100,
    });

    expect(recovered!.reservationToken).not.toBe(first!.reservationToken);
    await expect(adapter.commitActivation({
      taskId: first!.id,
      reservationToken: first!.reservationToken,
      executionId: startRequest.executionId,
      expectedRevision: 0,
      commands: [],
      outcome: { status: "completed" },
    })).resolves.toBe(false);
  });

  it("reserves at most one workflow activation per execution", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start(startRequest);
    await adapter.sendSignal({
      executionId: startRequest.executionId,
      workflowName: startRequest.workflowName,
      signalName: "example.signal",
      payload: null,
    });

    await expect(adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 2,
      leaseMs: 1_000,
    })).resolves.toHaveLength(1);
  });
});
