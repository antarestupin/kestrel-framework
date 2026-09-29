import {
  describe,
  expect,
  it,
} from "vitest";

import { MemoryWorkerAdapter } from "./adapter.js";
import { WorkerJobIdentityConflictError } from "../../errors.js";

function createSequence(prefix: string): () => string {
  let value = 0;

  return () => `${prefix}-${++value}`;
}

describe("MemoryWorkerAdapter", () => {
  it("deduplicates matching stable identities and rejects conflicting reuse", async () => {
    const adapter = new MemoryWorkerAdapter({
      createId: createSequence("job"),
    });
    const request = {
      identity: "workflow/activity/1",
      queue: "queue",
      payload: { value: 1 },
      correlation: { namespace: "workflow.activity", id: "execution/1" },
    } as const;

    await expect(adapter.enqueue([request, request]))
      .resolves.toEqual(["job-1", "job-1"]);
    expect(adapter.inspectJobs()).toHaveLength(1);
    await expect(adapter.enqueue([{ ...request, payload: { value: 2 } }]))
      .rejects.toBeInstanceOf(WorkerJobIdentityConflictError);
    expect(adapter.inspectJobs()).toHaveLength(1);
  });

  it("pauses reservations and reports ready and scheduled jobs", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryWorkerAdapter({
      createId: createSequence("job"),
      now: () => now,
    });
    await adapter.enqueue([
      { queue: "queue", payload: 1 },
      {
        queue: "queue",
        payload: 2,
        availableAt: new Date("2026-01-01T00:01:00.000Z"),
      },
    ]);

    await expect(adapter.listQueueStatistics(["queue", "empty"]))
      .resolves.toEqual([
        {
          queue: "queue",
          enabled: true,
          ready: 1,
          scheduled: 1,
          reserved: 0,
        },
        {
          queue: "empty",
          enabled: true,
          ready: 0,
          scheduled: 0,
          reserved: 0,
        },
      ]);

    // A live lease is reported separately from jobs that are still waiting.
    await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 60_000,
    });
    await adapter.enqueue([{ queue: "queue", payload: 3 }]);

    await adapter.setQueueEnabled("queue", false);

    await expect(adapter.listReadyQueues(["queue"])).resolves.toEqual([]);
    await expect(adapter.listQueueStatistics(["queue"]))
      .resolves.toMatchObject([{
        enabled: false,
        ready: 1,
        scheduled: 1,
        reserved: 1,
      }]);
  });

  it("enqueues multiple jobs and returns their identifiers", async () => {
    const adapter = new MemoryWorkerAdapter({
      createId: createSequence("job"),
    });

    await expect(adapter.enqueue([
      { queue: "queue", payload: 1 },
      { queue: "queue", payload: 2 },
    ])).resolves.toEqual(["job-1", "job-2"]);
    expect(adapter.inspectJobs().map((job) => job.payload)).toEqual([1, 2]);
  });

  it("honors queue allocations before filling unused capacity", async () => {
    const adapter = new MemoryWorkerAdapter({
      createId: createSequence("job"),
      createReservationToken: createSequence("token"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    for (let index = 0; index < 4; index += 1) {
      await adapter.enqueue([{ queue: "first", payload: index }]);
      await adapter.enqueue([{ queue: "second", payload: index }]);
    }

    const jobs = await adapter.reserve({
      queues: [
        { queue: "first", reservationLimit: 1, allowOverflow: true },
        { queue: "second", reservationLimit: 2, allowOverflow: false },
      ],
      totalLimit: 5,
      leaseMs: 1_000,
    });

    expect(jobs.map((job) => job.queue)).toEqual([
      "first",
      "second",
      "second",
      "first",
      "first",
    ]);
  });

  it("rejects mutations from an expired reservation generation", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryWorkerAdapter({
      createId: () => "job",
      createReservationToken: createSequence("token"),
      now: () => now,
    });
    await adapter.enqueue([{ queue: "queue", payload: "payload" }]);
    const [first] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 100,
    });
    now = new Date("2026-01-01T00:00:00.101Z");
    const [second] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 100,
    });

    await expect(adapter.ack([{
      jobId: first!.id,
      reservationToken: first!.reservationToken,
    }])).resolves.toEqual([]);
    await expect(adapter.ack([{
      jobId: second!.id,
      reservationToken: second!.reservationToken,
    }])).resolves.toHaveLength(1);
    expect(adapter.inspectJobs()).toHaveLength(0);
  });

  it("defers an unstarted reservation without consuming an attempt", async () => {
    const adapter = new MemoryWorkerAdapter({
      createId: () => "job",
      createReservationToken: () => "token",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await adapter.enqueue([{ queue: "queue", payload: "payload" }]);
    const [job] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 1_000,
    });
    const availableAt = new Date("2026-01-01T00:01:00.000Z");

    // A stale scheduler must not defer a reservation owned by another process.
    await expect(adapter.defer([{
      jobId: job!.id,
      reservationToken: "stale-token",
      availableAt,
    }])).resolves.toEqual([]);
    await expect(adapter.defer([{
      jobId: job!.id,
      reservationToken: job!.reservationToken,
      availableAt,
    }])).resolves.toHaveLength(1);
    expect(adapter.inspectJobs()).toMatchObject([{
      attempt: 0,
      availableAt,
    }]);
    expect(adapter.inspectJobs()[0]).not.toHaveProperty("reservationToken");
  });

  it("moves only the current reservation to the dead-letter queue", async () => {
    const adapter = new MemoryWorkerAdapter({
      createId: createSequence("id"),
      createReservationToken: () => "token",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await adapter.enqueue([{
      queue: "queue",
      payload: { value: true },
      executionId: "00000000-0000-4000-8000-000000000001",
    }]);
    const [job] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 100,
    });

    const moved = await adapter.deadLetter([{
      jobId: job!.id,
      reservationToken: job!.reservationToken,
      error: { name: "Error", message: "failed" },
    }]);

    expect(moved).toHaveLength(1);
    expect(adapter.inspectJobs()).toHaveLength(0);
    expect(adapter.inspectDeadLetters()).toMatchObject([{
      originalJobId: job!.id,
      executionId: "00000000-0000-4000-8000-000000000001",
      attempt: 1,
      error: { message: "failed" },
    }]);
  });
});
