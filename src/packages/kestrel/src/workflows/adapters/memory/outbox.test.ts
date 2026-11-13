import { describe, expect, it } from "vitest";

import type { CompleteWorkflowActivityRequest } from "../../adapter.js";
import { MemoryWorkflowAdapter } from "./index.js";

const start = (executionId: string) => ({
  executionId, workflowName: "outbox.run", workflowVersion: 1, input: null,
});
const workflowReservation = { kinds: ["workflow"] as const, limit: 1, leaseMs: 1_000 };
const dispatchReservation = { limit: 10, leaseMs: 1_000 };

function reservation(task: { id: string; reservationToken: string }) {
  return { taskId: task.id, reservationToken: task.reservationToken };
}

async function scheduleActivities(adapter: MemoryWorkflowAdapter, executionId: string, sequences: readonly number[]) {
  const [task] = await adapter.reserveTasks(workflowReservation);
  expect(task?.executionId).toBe(executionId);
  const reference = reservation(task!);
  const [activation] = await adapter.loadActivations([reference]);
  await expect(adapter.commitActivation({
    ...reference, executionId, expectedRevision: activation!.snapshot.revision,
    commands: sequences.map((sequence) => ({
      kind: "activity", sequence, target: "outbox.send", payload: { input: { sequence } },
    })),
    outcome: { status: "waiting" },
  })).resolves.toBe(true);
}

describe("Memory workflow activity outbox", () => {
  it("rejects a malformed activity completion that presents an owned workflow lease", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const executionId = "activation-is-not-an-activity";
    await adapter.start(start(executionId));
    const [task] = await adapter.reserveTasks(workflowReservation);
    const reference = reservation(task!);
    const request = { ...reference, executionId, sequence: undefined, status: "completed" } as unknown as CompleteWorkflowActivityRequest;
    await expect(adapter.completeActivities([request])).resolves.toEqual([]);
    await expect(adapter.getHistory(executionId)).resolves.toEqual([]);
    await expect(adapter.loadActivations([reference])).resolves.toHaveLength(1);
  });

  it("reserves only the earliest due dispatch and returns detached publication timestamps", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox", now: () => now });
    for (const executionId of ["later", "earlier"]) {
      await adapter.start(start(executionId));
      await scheduleActivities(adapter, executionId, [0]);
    }
    for (const dispatch of adapter.inspectActivityDispatches()) {
      expect(dispatch).not.toHaveProperty("publishedAt");
    }
    const original = await adapter.reserveActivityDispatches(dispatchReservation);
    const retries = original.map((dispatch) => ({
      dispatchId: dispatch.id, reservationToken: dispatch.reservationToken,
      retryAt: new Date(now.getTime() + (dispatch.executionId === "later" ? 40 : 20)),
    }));
    await expect(adapter.retryActivityDispatches(retries)).resolves.toHaveLength(2);
    now.setTime(now.getTime() + 40);

    // The first inserted row is due later, so insertion order cannot determine the next lease.
    const due = await adapter.reserveActivityDispatches({ ...dispatchReservation, limit: 1 });
    expect(due).toMatchObject([{ executionId: "earlier", attempt: 2 }]);
    await expect(adapter.markActivityDispatchesPublished([{
      dispatchId: due[0]!.id, reservationToken: due[0]!.reservationToken,
    }])).resolves.toHaveLength(1);
    const published = adapter.inspectActivityDispatches().find(({ executionId }) => executionId === "earlier")!;
    expect(published.publishedAt).toEqual(now);
    published.publishedAt!.setTime(0);
    expect(adapter.inspectActivityDispatches().find(({ executionId }) => executionId === "earlier")?.publishedAt).toEqual(now);
    await expect(adapter.reserveActivityDispatches(dispatchReservation)).resolves.toMatchObject([{ executionId: "later", attempt: 2 }]);
  });

  it("dispatches compensation only, even when a pre-cancellation publication completed late", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const executionId = "cancelled-outbox";
    await adapter.start(start(executionId));
    await scheduleActivities(adapter, executionId, [0, 1]);
    await expect(adapter.requestCancellation(executionId)).resolves.toBe(true);

    // A Worker can finish an already published job while its durable publication acknowledgement is still pending.
    await expect(adapter.completeExternalActivity({
      executionId, sequence: 0, sourceId: "late-original-job", status: "completed", result: null,
    })).resolves.toBe(true);
    await scheduleActivities(adapter, executionId, [2]);
    expect(adapter.inspectActivityDispatches().map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    await expect(adapter.reserveActivityDispatches(dispatchReservation)).resolves.toMatchObject([
      { executionId, sequence: 2, historyGeneration: 1 },
    ]);
  });

  it("acknowledges an external result for a terminal execution without waking it", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const executionId = "finished-outbox";
    await adapter.start(start(executionId));
    const [task] = await adapter.reserveTasks(workflowReservation);
    await adapter.commitActivation({
      ...reservation(task!), executionId, expectedRevision: 0,
      commands: [], outcome: { status: "completed" },
    });
    const execution = await adapter.get(executionId);

    await expect(adapter.completeExternalActivity({
      executionId, historyGeneration: 1, sequence: 9, sourceId: "terminal-job", status: "completed",
    })).resolves.toBe(true);
    await expect(adapter.get(executionId)).resolves.toEqual(execution);
    await expect(adapter.getHistory(executionId)).resolves.toEqual([]);
    expect(adapter.inspectTasks()).toEqual([]);
  });

  it("preserves another execution's outbox while rotating the selected generation", async () => {
    const adapter = new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" });
    const executionId = "rotate-outbox";
    const peerId = "peer-outbox";
    for (const id of [executionId, peerId]) {
      await adapter.start(start(id));
      await scheduleActivities(adapter, id, [0]);
    }
    const peerDispatch = adapter.inspectActivityDispatches().find((entry) => entry.executionId === peerId)!;
    await adapter.completeExternalActivity({ executionId, sequence: 0, sourceId: "first-job", status: "completed" });
    const [task] = await adapter.reserveTasks(workflowReservation);
    await expect(adapter.continueAsNew({
      ...reservation(task!), executionId, expectedRevision: 2, workflowVersion: 2, input: null,
    })).resolves.toBe(true);

    expect(adapter.inspectActivityDispatches()).toEqual([peerDispatch]);
    await expect(adapter.reserveActivityDispatches(dispatchReservation)).resolves.toMatchObject([{ executionId: peerId }]);

    await scheduleActivities(adapter, executionId, [0]);
    const currentDispatch = adapter.inspectActivityDispatches().find((entry) => entry.executionId === executionId)!;
    const history = await adapter.getHistory(executionId);
    const late = { executionId, sequence: 0, sourceId: "late-old-generation", status: "completed" } as const;
    // An explicit old generation cannot borrow a current dispatch ID. Legacy results without an ID are only acknowledged.
    await expect(adapter.completeExternalActivity({ ...late, historyGeneration: 1, dispatchId: currentDispatch.id })).resolves.toBe(true);
    await expect(adapter.completeExternalActivity(late)).resolves.toBe(true);
    await expect(adapter.completeExternalActivity({ ...late, historyGeneration: 3 })).resolves.toBe(false);
    await expect(adapter.getHistory(executionId)).resolves.toEqual(history);
    // Legacy jobs carrying the current dispatch identity may finish after the
    // upgrade. Explicitly old or unidentified jobs above must remain fenced.
    await expect(adapter.completeExternalActivity({ ...late, dispatchId: currentDispatch.id, result: "current" })).resolves.toBe(true);
    expect((await adapter.getHistory(executionId)).at(-1)).toMatchObject({ type: "command-completed", result: "current" });
  });

  it("protects a reserved task snapshot and rejects continuation using an activity lease", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const executionId = "owned-activity";
    await adapter.start(start(executionId));
    expect(adapter.inspectTasks()[0]).not.toHaveProperty("payload");
    await scheduleActivities(adapter, executionId, [0]);
    expect(adapter.inspectTasks()[0]).not.toHaveProperty("reservedAt");
    const [task] = await adapter.reserveTasks({ kinds: ["activity"], limit: 1, leaseMs: 1_000 });
    const snapshot = adapter.inspectTasks()[0]!;
    await expect(adapter.extendTaskLeases([{ ...reservation(task!), leaseMs: 0 }]))
      .rejects.toEqual(new TypeError("Workflow task leaseMs must be a positive integer."));
    expect(adapter.inspectTasks()).toEqual([snapshot]);
    snapshot.reservedAt!.setTime(0);
    (snapshot.payload as { input: { sequence: number } }).input.sequence = 99;
    expect(adapter.inspectTasks()).toMatchObject([{ reservedAt: now, payload: { input: { sequence: 0 } } }]);

    // An activity's otherwise-valid reservation cannot rotate the workflow's journal.
    await expect(adapter.continueAsNew({
      ...reservation(task!), executionId, expectedRevision: 1, workflowVersion: 2, input: null,
    })).resolves.toBe(false);
    await expect(adapter.getHistoryArchives(executionId)).resolves.toEqual([]);
  });

  it("records an absent embedded activity result without materializing an undefined value", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const executionId = "embedded-results";
    await adapter.start(start(executionId));
    await scheduleActivities(adapter, executionId, [0, 1, 2]);
    const tasks = await adapter.reserveTasks({ kinds: ["activity"], limit: 3, leaseMs: 1_000 });
    const earlier = tasks.find(({ commandSequence }) => commandSequence === 0)!;
    const omitted = tasks.find(({ commandSequence }) => commandSequence === 1)!;
    const explicit = tasks.find(({ commandSequence }) => commandSequence === 2)!;
    await expect(adapter.completeActivities([
      { ...reservation(earlier), executionId, sequence: 0, status: "completed", result: "earlier" },
    ])).resolves.toEqual([reservation(earlier)]);
    await expect(adapter.completeActivities([
      { ...reservation(omitted), executionId, sequence: 1, status: "completed" },
      { ...reservation(explicit), executionId, sequence: 2, status: "completed", result: null },
    ])).resolves.toEqual([reservation(omitted), reservation(explicit)]);

    const results = (await adapter.getHistory(executionId)).filter((event) => event.type === "command-completed");
    expect(results).toMatchObject([
      { eventIndex: 3, sequence: 0, completionOrder: 0, result: "earlier" },
      { eventIndex: 4, sequence: 1, completionOrder: 1 },
      { eventIndex: 5, sequence: 2, completionOrder: 2, result: null },
    ]);
    expect(results[1]).not.toHaveProperty("result");
  });
});
