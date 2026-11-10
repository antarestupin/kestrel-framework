import { setImmediate } from "node:timers/promises";

import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { WorkerAcknowledgementBuffer } from "./acknowledgement_buffer.js";
import type { JobReservationRef } from "./types.js";

function reservation(jobId: string): JobReservationRef {
  return { jobId, reservationToken: `token-${jobId}` };
}

describe("WorkerAcknowledgementBuffer", () => {
  it("groups acknowledgements from different queues for global adapters", async () => {
    const adapter = new MemoryWorkerAdapter();
    const acknowledge = vi.spyOn(adapter, "ack")
      .mockImplementation(async (jobs) => jobs);
    const buffer = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: 10,
      flushIntervalMs: 1_000,
      grouping: "global",
    });

    buffer.enqueue("first-queue", reservation("first"));
    buffer.enqueue("second-queue", reservation("second"));
    await buffer.flush();

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith([
      reservation("first"),
      reservation("second"),
    ]);
  });

  it("creates one acknowledgement batch per queue when required", async () => {
    const adapter = new MemoryWorkerAdapter({
      acknowledgementGrouping: "queue",
    });
    const acknowledge = vi.spyOn(adapter, "ack")
      .mockImplementation(async (jobs) => jobs);
    const buffer = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: 10,
      flushIntervalMs: 1_000,
      grouping: adapter.acknowledgementGrouping,
    });

    buffer.enqueue("first-queue", reservation("first"));
    buffer.enqueue("second-queue", reservation("second"));
    buffer.enqueue("first-queue", reservation("third"));
    await buffer.flush();

    expect(acknowledge.mock.calls.map(([jobs]) => jobs)).toEqual([
      [reservation("first"), reservation("third")],
      [reservation("second")],
    ]);
  });

  it("flushes in the background when the size threshold is reached", async () => {
    const adapter = new MemoryWorkerAdapter();
    const acknowledge = vi.spyOn(adapter, "ack")
      .mockImplementation(async (jobs) => jobs);
    const buffer = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: 2,
      flushIntervalMs: 1_000,
      grouping: "global",
    });

    buffer.enqueue("queue", reservation("first"));
    buffer.enqueue("queue", reservation("second"));

    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    await buffer.flush();
  });

  it("splits several ready acknowledgement batches at the size boundary", async () => {
    const adapter = new MemoryWorkerAdapter();
    const acknowledge = vi.spyOn(adapter, "ack")
      .mockImplementation(async (jobs) => jobs);
    const buffer = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: 2,
      flushIntervalMs: 1_000,
      grouping: "global",
    });

    for (const jobId of ["first", "second", "third", "fourth", "fifth"]) {
      buffer.enqueue("queue", reservation(jobId));
    }

    await buffer.flush();

    expect(acknowledge.mock.calls.map(([jobs]) => jobs)).toEqual([
      [reservation("first"), reservation("second")],
      [reservation("third"), reservation("fourth")],
      [reservation("fifth")],
    ]);
  });

  it("flushes after the time threshold when the buffer stays small", async () => {
    const adapter = new MemoryWorkerAdapter();
    const acknowledge = vi.spyOn(adapter, "ack")
      .mockImplementation(async (jobs) => jobs);
    const buffer = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: 10,
      flushIntervalMs: 1,
      grouping: "global",
    });

    buffer.enqueue("queue", reservation("first"));

    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    await buffer.flush();
  });

  it("surfaces background acknowledgement failures at the flush boundary", async () => {
    const adapter = new MemoryWorkerAdapter();
    const failure = new Error("ack failed");
    vi.spyOn(adapter, "ack").mockRejectedValue(failure);
    const buffer = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: 1,
      flushIntervalMs: 1_000,
      grouping: "global",
    });

    buffer.enqueue("queue", reservation("first"));

    await expect(buffer.flush()).rejects.toBe(failure);
  });

  it("keeps draining sibling queue acknowledgements after another queue rejects", async () => {
    const adapter = new MemoryWorkerAdapter();
    const gate = Promise.withResolvers<void>();
    const failure = new Error("first queue failed");
    const onAcknowledged = vi.fn();
    vi.spyOn(adapter, "ack").mockImplementation(async (jobs) => {
      if (jobs[0]!.jobId === "first") throw failure;
      await gate.promise;
      return jobs;
    });
    const buffer = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: 10, flushIntervalMs: 1_000, grouping: "queue", onAcknowledged,
    });
    buffer.enqueue("first-queue", reservation("first"));
    buffer.enqueue("second-queue", reservation("second"));
    let settled = false;
    const draining = buffer.flush().then(() => undefined, (error: unknown) => error)
      .finally(() => { settled = true; });
    try {
      // A completed drain must imply that every started storage call has settled.
      await setImmediate();
      expect(settled).toBe(false);
      expect(onAcknowledged).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await draining;
    }
    expect(await draining).toBe(failure);
    expect(onAcknowledged).toHaveBeenCalledExactlyOnceWith([reservation("second")]);
  });

  it("preserves every queue-group failure in the same bounded batch", async () => {
    const adapter = new MemoryWorkerAdapter();
    const first = new Error("first queue failed");
    const second = new Error("second queue failed");
    vi.spyOn(adapter, "ack").mockImplementation(async (jobs) => {
      throw jobs[0]!.jobId === "first" ? first : second;
    });
    const buffer = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: 10, flushIntervalMs: 1_000, grouping: "queue",
    });
    buffer.enqueue("first-queue", reservation("first"));
    buffer.enqueue("second-queue", reservation("second"));
    await expect(buffer.flush()).rejects.toMatchObject({ errors: [first, second] });
    await expect(buffer.flush()).resolves.toBeUndefined();
  });

  it("reports every failed background batch once at the flush boundary", async () => {
    const adapter = new MemoryWorkerAdapter();
    const first = new Error("first batch failed");
    const second = new Error("second batch failed");
    vi.spyOn(adapter, "ack").mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const buffer = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: 1, flushIntervalMs: 1_000, grouping: "global",
    });
    buffer.enqueue("queue", reservation("first"));
    buffer.enqueue("queue", reservation("second"));
    await expect(buffer.flush()).rejects.toMatchObject({ errors: [first, second] });
    await expect(buffer.flush()).resolves.toBeUndefined();
  });


  it("exposes queued acknowledgement count and clears it after a drain", async () => {
    const adapter = new MemoryWorkerAdapter();
    vi.spyOn(adapter, "ack").mockImplementation(async (jobs) => jobs);
    const buffer = new WorkerAcknowledgementBuffer(adapter, { maxSize: 10, flushIntervalMs: 1_000, grouping: "global" });
    try {
      expect(buffer.pendingCount).toBe(0);
      buffer.enqueue("queue", reservation("pending"));
      expect(buffer.pendingCount).toBe(1);
    } finally { await buffer.flush(); }
    expect(buffer.pendingCount).toBe(0);
  });

});
