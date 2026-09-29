import { describe, expect, it, vi } from "vitest";
import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { WorkerDeferralBuffer } from "./deferral_buffer.js";
import type { DeferJobRequest } from "./types.js";

function request(jobId: string, milliseconds: number): DeferJobRequest {
  return { jobId, reservationToken: `token-${jobId}`, availableAt: new Date(milliseconds) };
}

describe("WorkerDeferralBuffer", () => {
  it("shares batches across invocations and preserves per-job dates and stale results", async () => {
    const adapter = new MemoryWorkerAdapter();
    const defer = vi.spyOn(adapter, "defer")
      .mockImplementation(async (jobs) => jobs.filter((job) => job.jobId !== "stale"));
    const onDeferred = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    const buffer = new WorkerDeferralBuffer(adapter, {
      maxSize: 3,
      flushIntervalMs: 100,
      onDeferred,
    });
    buffer.enqueue([request("first", 100), request("stale", 200)], first);
    buffer.enqueue([request("third", 300), request("fourth", 400)], second);
    await buffer.flush();
    expect(defer.mock.calls.map(([jobs]) => jobs)).toEqual([
      [request("first", 100), request("stale", 200), request("third", 300)],
      [request("fourth", 400)],
    ]);
    expect(onDeferred.mock.calls.map(([jobs]) => jobs)).toEqual([
      [request("first", 100), request("third", 300)],
      [request("fourth", 400)],
    ]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("flushes a small batch while peer handlers are still running", async () => {
    vi.useFakeTimers();
    const adapter = new MemoryWorkerAdapter();
    const defer = vi.spyOn(adapter, "defer").mockResolvedValue([]);
    const persisted = vi.fn();
    const buffer = new WorkerDeferralBuffer(adapter, {
      maxSize: 100,
      flushIntervalMs: 10,
      onDeferred: () => undefined,
    });
    try {
      buffer.enqueue([request("job", 100)], persisted);
      await vi.advanceTimersByTimeAsync(9);
      expect(defer).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(persisted).toHaveBeenCalledOnce();
    } finally {
      await buffer.flush();
      vi.useRealTimers();
    }
  });

  it("does not confirm failed writes and reports them once at the drain boundary", async () => {
    const adapter = new MemoryWorkerAdapter();
    const failure = new Error("storage unavailable");
    vi.spyOn(adapter, "defer").mockRejectedValue(failure);
    const onDeferred = vi.fn();
    const persisted = vi.fn();
    const buffer = new WorkerDeferralBuffer(adapter, {
      maxSize: 1,
      flushIntervalMs: 10,
      onDeferred,
    });
    buffer.enqueue([request("job", 100)], persisted);
    await expect(buffer.flush()).rejects.toBe(failure);
    expect(onDeferred).not.toHaveBeenCalled();
    expect(persisted).not.toHaveBeenCalled();
    await expect(buffer.flush()).resolves.toBeUndefined();
  });
});
