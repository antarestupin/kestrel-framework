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

    const result = adapter.waitForTerminal(startRequest.executionId);
    expect(adapter.completeExecution(startRequest.executionId, { id: "result" }))
      .toBe(true);
    expect(adapter.completeExecution(startRequest.executionId, { id: "other" }))
      .toBe(false);

    await expect(result).resolves.toMatchObject({
      status: "completed",
      output: { id: "result" },
    });
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
