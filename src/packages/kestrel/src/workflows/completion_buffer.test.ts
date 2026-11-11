import { describe, expect, it, vi } from "vitest";

import type {
  CompleteWorkflowActivityRequest,
  WorkflowAdapter,
} from "./adapter.js";
import { WorkflowCompletionBuffer } from "./completion_buffer.js";

describe("WorkflowCompletionBuffer", () => {
  it("flushes a full batch and resolves each committed reservation", async () => {
    const completeActivities = vi.fn(async (
      requests: readonly CompleteWorkflowActivityRequest[],
    ) => requests.map(toReservation));
    const buffer = new WorkflowCompletionBuffer(
      { completeActivities } as never,
      { maxSize: 2, flushIntervalMs: 100 },
    );
    const requests = [completion("first"), completion("second")];

    await expect(Promise.all(requests.map((request) => buffer.enqueue(request))))
      .resolves.toEqual([true, true]);
    expect(completeActivities).toHaveBeenCalledOnce();
    expect(completeActivities).toHaveBeenCalledWith(requests);
  });

  it("resolves omitted adapter results as stale", async () => {
    const first = completion("first");
    const second = completion("second");
    const adapter = {
      completeActivities: async () => [toReservation(first)],
    } as unknown as WorkflowAdapter;
    const buffer = new WorkflowCompletionBuffer(adapter, {
      maxSize: 2,
      flushIntervalMs: 100,
    });

    await expect(Promise.all([
      buffer.enqueue(first),
      buffer.enqueue(second),
    ])).resolves.toEqual([true, false]);
  });

  it("matches both opaque reservation coordinates without delimiter collisions", async () => {
    // External adapters may choose any string identifiers and tokens.
    const first = { ...completion("part:one"), taskId: "part:one", reservationToken: "part-two" };
    const second = { ...completion("part"), taskId: "part", reservationToken: "one:part-two" };
    const completeActivities = vi.fn(async () => [toReservation(first)]);
    const buffer = new WorkflowCompletionBuffer({ completeActivities } as unknown as WorkflowAdapter, {
      maxSize: 2, flushIntervalMs: 100,
    });

    await expect(Promise.all([buffer.enqueue(first), buffer.enqueue(second)])).resolves.toEqual([true, false]);
  });

  it("preserves the failures of all queued completion batches", async () => {
    const first = new Error("first batch rejected");
    const second = new Error("second batch rejected");
    const completeActivities = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const buffer = new WorkflowCompletionBuffer({ completeActivities } as unknown as WorkflowAdapter, {
      maxSize: 1, flushIntervalMs: 100,
    });
    const individual = Promise.allSettled([buffer.enqueue(completion("first")), buffer.enqueue(completion("second"))]);
    await expect(buffer.flush()).rejects.toMatchObject({ name: "AggregateError", errors: [first, second] });
    await expect(individual).resolves.toEqual([
      { status: "rejected", reason: first }, { status: "rejected", reason: second },
    ]);
    await expect(buffer.flush()).resolves.toBeUndefined();
  });

  it("propagates a single failed batch without wrapping its cause", async () => {
    const failure = new Error("completion storage rejected the batch");
    const completeActivities = vi.fn().mockRejectedValue(failure);
    const buffer = new WorkflowCompletionBuffer({ completeActivities } as unknown as WorkflowAdapter, {
      maxSize: 1, flushIntervalMs: 100,
    });
    const pending = buffer.enqueue(completion("first")).catch((error: unknown) => error);
    await expect(buffer.flush()).rejects.toBe(failure);
    await expect(pending).resolves.toBe(failure);
  });

  it("flushes a partial batch explicitly", async () => {
    const completeActivities = vi.fn(async (
      requests: readonly CompleteWorkflowActivityRequest[],
    ) => requests.map(toReservation));
    const buffer = new WorkflowCompletionBuffer(
      { completeActivities } as never,
      { maxSize: 10, flushIntervalMs: 100 },
    );
    const pending = buffer.enqueue(completion("partial"));

    await buffer.flush();

    await expect(pending).resolves.toBe(true);
    expect(completeActivities).toHaveBeenCalledOnce();
  });

  it("flushes a partial batch after the configured interval", async () => {
    vi.useFakeTimers();
    try {
      const completeActivities = vi.fn(async (
        requests: readonly CompleteWorkflowActivityRequest[],
      ) => requests.map(toReservation));
      const buffer = new WorkflowCompletionBuffer(
        { completeActivities } as never,
        { maxSize: 10, flushIntervalMs: 100 },
      );
      const pending = buffer.enqueue(completion("timed"));

      await vi.advanceTimersByTimeAsync(99);
      expect(completeActivities).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBe(true);
      expect(completeActivities).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

function completion(id: string): CompleteWorkflowActivityRequest {
  return {
    taskId: id,
    reservationToken: `token-${id}`,
    executionId: `execution-${id}`,
    sequence: 0,
    status: "completed",
    result: null,
  };
}

function toReservation(request: CompleteWorkflowActivityRequest) {
  return {
    taskId: request.taskId,
    reservationToken: request.reservationToken,
  };
}
