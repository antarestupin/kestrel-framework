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
});
