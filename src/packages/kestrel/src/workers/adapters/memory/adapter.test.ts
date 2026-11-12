import {
  describe,
  expect,
  it,
} from "vitest";

import { MemoryWorkerAdapter } from "./adapter.js";
import { WorkerJobIdentityConflictError } from "../../errors.js";
import { workerPayloadConformance } from "../../testing/payload_conformance.js";
import { workerReservationConformance } from "../../testing/reservation_conformance.js";

function createSequence(prefix: string): () => string {
  let value = 0;

  return () => `${prefix}-${++value}`;
}

describe("MemoryWorkerAdapter", () => {
  workerPayloadConformance((budgets) => new MemoryWorkerAdapter(budgets));
  workerReservationConformance(() => new MemoryWorkerAdapter());

  it("isolates publication, reservation, inspection and dead-letter payloads", async () => {
    const adapter = new MemoryWorkerAdapter();
    const payload = { nested: { value: 1 } };
    const correlation = { namespace: "test", id: "1", data: { value: 1 } };
    await adapter.enqueue([{ queue: "queue", payload, correlation }]);
    payload.nested.value = 2;
    correlation.data.value = 2;
    const inspected = adapter.inspectJobs()[0]!;
    (inspected.payload as typeof payload).nested.value = 3;
    expect(adapter.inspectJobs()[0]!.payload).toEqual({ nested: { value: 1 } });
    expect(adapter.inspectJobs()[0]!.correlation?.data).toEqual({ value: 1 });

    const reservation = {
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1, leaseMs: 60_000,
    };
    const [first] = await adapter.reserve(reservation);
    (first!.payload as typeof payload).nested.value = 4;
    (first!.correlation!.data as { value: number }).value = 4;
    await adapter.release([{ jobId: first!.id, reservationToken: first!.reservationToken }]);
    const [second] = await adapter.reserve(reservation);
    expect(second!.payload).toEqual({ nested: { value: 1 } });
    expect(second!.correlation?.data).toEqual({ value: 1 });
    await adapter.deadLetter([{
      jobId: second!.id, reservationToken: second!.reservationToken,
      error: { name: "Error", message: "failed" },
    }]);
    (adapter.inspectDeadLetters()[0]!.payload as typeof payload).nested.value = 5;
    expect(adapter.inspectDeadLetters()[0]!.payload).toEqual({ nested: { value: 1 } });
  });

  it("owns transition timestamps and errors after the caller mutates them", async () => {
    const time = new Date("2026-01-01T00:00:00Z");
    const adapter = new MemoryWorkerAdapter({ now: () => time });
    const reserve = () => adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1, leaseMs: 60_000,
    });
    await adapter.enqueue([{ queue: "queue", payload: 1 }]);
    const [first] = await reserve();
    const retryAt = new Date(time);
    const error = { name: "Error", message: "first failure" };
    await adapter.retry([{ jobId: first!.id, reservationToken: first!.reservationToken, retryAt, error }]);
    retryAt.setUTCFullYear(2030);
    error.message = "caller changed the error";
    expect(adapter.inspectJobs()[0]).toMatchObject({
      availableAt: new Date("2026-01-01T00:00:00Z"), lastError: { message: "first failure" },
    });

    const [second] = await reserve();
    const availableAt = new Date(time);
    await adapter.defer([{ jobId: second!.id, reservationToken: second!.reservationToken, availableAt }]);
    availableAt.setUTCFullYear(2030);
    expect(adapter.inspectJobs()[0]!.availableAt).toEqual(time);

    const [third] = await reserve();
    error.message = "terminal failure";
    await adapter.deadLetter([{ jobId: third!.id, reservationToken: third!.reservationToken, error }]);
    error.message = "caller changed the terminal error";
    time.setUTCFullYear(2030);
    expect(adapter.inspectDeadLetters()[0]).toMatchObject({
      createdAt: new Date("2026-01-01T00:00:00Z"),
      failedAt: new Date("2026-01-01T00:00:00Z"), error: { message: "terminal failure" },
    });
  });

  it("retains the original reservation when preparing its dead letter fails", async () => {
    const failure = new Error("Dead-letter ID unavailable.");
    let created = false;
    const adapter = new MemoryWorkerAdapter({ createId: () => {
      if (created) throw failure;
      created = true;
      return "job";
    } });
    await adapter.enqueue([{ queue: "queue", payload: null }]);
    const [job] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1, leaseMs: 60_000,
    });
    const reservation = { jobId: job!.id, reservationToken: job!.reservationToken };
    await expect(adapter.deadLetter([{ ...reservation, error: { name: "Error", message: "failed" } }])).rejects.toBe(failure);
    expect(adapter.inspectJobs()).toMatchObject([{ id: job!.id, reservationToken: job!.reservationToken }]);
    expect(adapter.inspectDeadLetters()).toEqual([]);
    await expect(adapter.ack([reservation])).resolves.toEqual([reservation]);
  });

  it("keeps absent job metadata absent during storage, reservation and dead-letter delivery", async () => {
    const adapter = new MemoryWorkerAdapter();
    await adapter.enqueue([{ queue: "queue", payload: null }]);
    const [job] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1, leaseMs: 60_000,
    });
    const stored = adapter.inspectJobs()[0]!;
    await adapter.deadLetter([{ jobId: job!.id, reservationToken: job!.reservationToken, error: { name: "Error", message: "failed" } }]);
    for (const snapshot of [stored, job!, adapter.inspectDeadLetters()[0]!]) {
      for (const key of ["identity", "correlation", "groupId", "executionId"]) {
        expect(Object.hasOwn(snapshot, key), key).toBe(false);
      }
    }
  });

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

  for (const operation of ["ack", "retry", "defer", "deadLetter", "release", "extendLease"] as const) {
    it(`applies ${operation} only to the current matching reservation and preserves peer jobs`, async () => {
      let now = new Date("2026-01-01T00:00:00.000Z");
      const adapter = new MemoryWorkerAdapter({ now: () => now, createId: createSequence("owned-job"), createReservationToken: createSequence("owned-token") });
      await adapter.enqueue([
        { queue: "ownership", payload: "first", identity: "owned-first", groupId: "owned-group", correlation: { namespace: "test", id: "owned-first" } },
        { queue: "ownership", payload: "second" },
      ]);
      const reserve = { queues: [{ queue: "ownership", reservationLimit: 2, allowOverflow: true }], totalLimit: 2, leaseMs: 1_000 };
      const previous = await adapter.reserve(reserve);
      now = new Date(now.getTime() + 1_001);
      const current = await adapter.reserve(reserve);
      const first = current.find((job) => job.payload === "first")!;
      const second = current.find((job) => job.payload === "second")!;
      const oldFirst = previous.find((job) => job.payload === "first")!;
      const before = adapter.inspectJobs();
      const later = new Date(now.getTime() + 300_000);
      const error = { name: "StorageFixtureError", message: "retry fixture" };
      const request = (jobId: string, reservationToken: string) => ({ jobId, reservationToken, retryAt: later, availableAt: later, leaseMs: 300_000, error });
      // Mix a stale generation, a valid reference, a cross-job token and an unknown job.
      const changed = await adapter[operation]([
        request(oldFirst.id, oldFirst.reservationToken), request(first.id, first.reservationToken),
        request(second.id, first.reservationToken), request("missing-job", first.reservationToken),
      ]);
      expect(changed).toEqual([{ jobId: first.id, reservationToken: first.reservationToken }]);
      expect(adapter.inspectJobs().find((job) => job.id === second.id)).toEqual(before.find((job) => job.id === second.id));
      const updated = adapter.inspectJobs().find((job) => job.id === first.id);
      if (operation === "ack" || operation === "deadLetter") {
        expect(updated).toBeUndefined();
      } else {
        expect(updated?.payload).toBe("first");
        expect(updated?.identity).toBe("owned-first");
        expect(updated?.attempt).toBe(operation === "defer" ? 1 : 2);
        expect(updated?.availableAt).toEqual(operation === "release" ? now : later);
        if (operation === "extendLease") {
          expect(updated?.reservationToken).toBe(first.reservationToken);
          expect(updated?.reservedAt).toEqual(now);
        } else {
          expect(updated?.reservationToken).toBeUndefined();
          expect(updated?.reservedAt).toBeUndefined();
        }
        if (operation === "retry") expect(updated?.lastError).toEqual(error);
      }
      if (operation === "deadLetter") expect(adapter.inspectDeadLetters()).toMatchObject([{
        originalJobId: first.id, identity: "owned-first", payload: "first", correlation: { namespace: "test", id: "owned-first" }, groupId: "owned-group", attempt: 2, error,
      }]);
    });
  }

  it("returns no ownership transitions for empty mutation batches", async () => {
    const adapter = new MemoryWorkerAdapter();
    expect(adapter.acknowledgementGrouping).toBe("global");
    for (const operation of ["ack", "retry", "defer", "deadLetter", "release", "extendLease"] as const) {
      expect(await adapter[operation]([])).toEqual([]);
    }
    expect(adapter.inspectJobs()).toEqual([]);
    expect(adapter.inspectDeadLetters()).toEqual([]);
  });

  it("preserves publication metadata through reservation", async () => {
    const adapter = new MemoryWorkerAdapter();
    const request = { queue: "metadata", payload: { value: 1 }, identity: "logical", groupId: "group", executionId: "execution", correlation: { namespace: "owner", id: "correlation" } };
    await adapter.enqueue([request]);
    const [job] = await adapter.reserve({ queues: [{ queue: "metadata", reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 });
    expect(job).toMatchObject(request);
    expect(job!.attempt).toBe(1);
  });

  it.each(["queue", "groupId", "executionId", "payload", "correlation"] as const)("rejects identity reuse with a different %s atomically", async (key) => {
    const adapter = new MemoryWorkerAdapter();
    const request = { queue: "identity", payload: { value: 1 }, identity: "logical", groupId: "group", executionId: "execution", correlation: { namespace: "owner", id: "correlation" } };
    const [id] = await adapter.enqueue([request]);
    expect(await adapter.enqueue([request])).toEqual([id]);
    const value = key === "payload" ? { value: 2 } : key === "correlation" ? { namespace: "owner", id: "other" } : "other";
    await expect(adapter.enqueue([{ queue: "new", payload: null }, { ...request, [key]: value }])).rejects.toBeInstanceOf(WorkerJobIdentityConflictError);
    expect(adapter.inspectJobs()).toHaveLength(1);
  });

  it("keeps distinct logical identities separate and looks up each existing job independently", async () => {
    const adapter = new MemoryWorkerAdapter({ createId: createSequence("logical-job") });
    // Equal content does not make two explicitly different logical identities
    // interchangeable, including when replaying them in another input order.
    const first = { queue: "identity", payload: "same-content", identity: "first" };
    const second = { ...first, identity: "second" };
    expect(await adapter.enqueue([first, second])).toEqual(["logical-job-1", "logical-job-2"]);
    expect(await adapter.enqueue([second, first])).toEqual(["logical-job-2", "logical-job-1"]);
    expect(adapter.inspectJobs()).toHaveLength(2);
  });

  it("orders available jobs by due time and then identifier, excluding already selected jobs", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const ids = ["z", "b", "a"];
    const adapter = new MemoryWorkerAdapter({ now: () => now, createId: () => ids.shift()! });
    await adapter.enqueue([
      { queue: "ordered", payload: "later", availableAt: new Date(now.getTime() - 1) },
      { queue: "ordered", payload: "tie-b", availableAt: new Date(now.getTime() - 2) },
      { queue: "ordered", payload: "tie-a", availableAt: new Date(now.getTime() - 2) },
    ]);
    const jobs = await adapter.reserve({ queues: [{ queue: "ordered", reservationLimit: 1, allowOverflow: true }], totalLimit: 3, leaseMs: 100 });
    expect(jobs.map((job) => job.payload)).toEqual(["tie-a", "tie-b", "later"]);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(3);
  });

  it("stops allocation at total capacity and excludes empty or future queues", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryWorkerAdapter({ now: () => now });
    await adapter.enqueue([{ queue: "ready", payload: 1 }, { queue: "later", payload: 2, availableAt: new Date(now.getTime() + 1) }]);
    expect(await adapter.listReadyQueues(["empty", "ready", "later"])).toEqual(["ready"]);
    expect(await adapter.reserve({ queues: ["ready", "later"].map((queue) => ({ queue, reservationLimit: 1, allowOverflow: true })), totalLimit: 1, leaseMs: 100 })).toHaveLength(1);
  });

  it("classifies due, future and leased jobs at the exact clock boundary", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryWorkerAdapter({ now: () => now });
    await adapter.enqueue([{ queue: "stats", payload: "leased" }, { queue: "stats", payload: "scheduled", availableAt: new Date(now.getTime() + 1_000) }]);
    await adapter.reserve({ queues: [{ queue: "stats", reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 1_000 });
    expect(await adapter.listQueueStatistics(["stats"])).toEqual([{ queue: "stats", enabled: true, ready: 0, reserved: 1, scheduled: 1 }]);
    now = new Date(now.getTime() + 1_000);
    expect(await adapter.listQueueStatistics(["stats"])).toEqual([{ queue: "stats", enabled: true, ready: 2, reserved: 0, scheduled: 0 }]);
  });

  it.each(["totalLimit", "leaseMs", "reservationLimit"] as const)("rejects invalid reservation %s before changing ownership", async (key) => {
    const adapter = new MemoryWorkerAdapter();
    await adapter.enqueue([{ queue: "valid", payload: null }]);
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      const request = { queues: [{ queue: "valid", reservationLimit: key === "reservationLimit" ? value : 1, allowOverflow: true }], totalLimit: key === "totalLimit" ? value : 1, leaseMs: key === "leaseMs" ? value : 100 };
      await expect(adapter.reserve(request)).rejects.toThrow(`${key} must be a positive integer.`);
    }
    expect(adapter.inspectJobs()[0]!.attempt).toBe(0);
  });

});
