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

  it("orders equally eligible tasks by identity and preserves active lease capacity", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const identities = ["task-c", "task-a", "task-b"];
    const adapter = new MemoryWorkflowAdapter({ now: () => now, createTaskId: () => identities.shift()! });
    const concurrency = { definitionLimit: 1 };
    await adapter.startMany(["c", "a", "b"].map((executionId) => ({ ...startRequest, executionId, concurrency })));
    const reserve = () => adapter.reserveTasks({ kinds: ["workflow"], limit: 3, leaseMs: 10 });
    const [first] = await reserve();
    expect(first).toMatchObject({ id: "task-a", executionId: "a", attempt: 1, createdAt: now, reservedAt: now });
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
    const invalid: [string, WorkflowPayload][] = [
      ["unknown", null], ["timer", null], ["timer", []], ["timer", "duration"],
      ["timer", { durationMs: -1 }], ["timer", { durationMs: 0.5 }],
      ["signal", { timeoutMs: "soon" }],
      ["child", { version: 1 }], ["child", { version: 1, input: null, executionId: "" }],
      ["child", { version: 1, input: null, executionId: 5 }],
      ["child", { version: 1, input: null, concurrency: [] }],
      ["child", { version: 1, input: null, concurrency: { definitionLimit: 0 } }],
      ["child", { version: 1, input: null, concurrency: { definitionLimit: 1.5 } }],
      ["child", { version: 1, input: null, concurrency: { keyed: true } }],
    ];
    const keyed = { key: "account", limit: 1, conflict: "enqueue", scope: "execution" } as const;
    for (const patch of [{ key: "" }, { key: 1 }, { limit: 0 }, { limit: 1.5 }, { conflict: "unknown" }, { scope: "unknown" }]) {
      invalid.push(["child", { version: 1, input: null, concurrency: { keyed: { ...keyed, ...patch } } }]);
    }
    const tasks = adapter.inspectTasks();
    for (const [kind, payload] of invalid) {
      await expect(adapter.commitActivation({ ...request, commands: [{ kind, payload, sequence: 0, target: "invalid" }] }))
        .rejects.toBeInstanceOf(TypeError);
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
    expect(adapter.inspectActivityDispatches()[0]).not.toHaveProperty("reservedAt");
    now = new Date(now.getTime() + 100);
    await expect(dispatches()).resolves.toEqual([]);
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
    await expect(adapter.getHistoryArchives(executionId)).resolves.toMatchObject([{ continuedAt: now }]);
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
