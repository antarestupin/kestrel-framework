import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ObservationEvent } from "./observer.js";
import {
  BufferedObservationRecorder,
  type ObservationWriter,
} from "./recorder.js";

function observation(id: string): ObservationEvent {
  return {
    id,
    executionId: "execution-1",
    occurredAt: new Date("2026-08-07T10:00:00.000Z"),
    name: "example.recorded",
    category: "example",
    schemaVersion: 1,
    data: {},
  };
}

describe("BufferedObservationRecorder", () => {
  it("uses BatchBuffer boundaries and flushes remaining events on close", async () => {
    const append = vi.fn<ObservationWriter["append"]>(async () => {});
    const recorder = new BufferedObservationRecorder(
      { append },
      { batchSize: 2, flushIntervalMs: 60_000 },
    );

    recorder.enqueue(observation("first"));
    recorder.enqueue(observation("second"));
    await recorder.flush();
    recorder.enqueue(observation("third"));
    await recorder.close();

    expect(append).toHaveBeenNthCalledWith(
      1,
      [observation("first"), observation("second")],
    );
    expect(append).toHaveBeenNthCalledWith(2, [observation("third")]);
    expect(recorder.getHealth()).toMatchObject({
      status: "closed",
      pendingCount: 0,
      droppedCount: 0,
    });
  });

  it("retries storage failures with bounded exponential delays", async () => {
    const failure = new Error("Unavailable");
    const append = vi.fn<ObservationWriter["append"]>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const sleep = vi.fn(async () => {});
    const onError = vi.fn();
    const recorder = new BufferedObservationRecorder(
      { append },
      {
        batchSize: 10,
        flushIntervalMs: 60_000,
        maxAttempts: 4,
        initialRetryDelayMs: 25,
        maxRetryDelayMs: 40,
        onError,
        sleep,
      },
    );

    recorder.enqueue(observation("first"));
    await recorder.flush();

    expect(append).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[25], [40]]);
    expect(onError).toHaveBeenNthCalledWith(1, failure, {
      attempt: 1,
      batchSize: 1,
      policy: "best-effort",
      retryDelayMs: 25,
      terminal: false,
    });
    expect(onError).toHaveBeenNthCalledWith(2, failure, {
      attempt: 2,
      batchSize: 1,
      policy: "best-effort",
      retryDelayMs: 40,
      terminal: false,
    });
    expect(recorder.getHealth()).toMatchObject({
      status: "healthy",
      pendingCount: 0,
      droppedCount: 0,
      consecutiveStorageFailures: 0,
    });
    await recorder.close();
  });

  it("drops a terminal failed batch explicitly in best-effort mode", async () => {
    const failure = new Error("Unavailable");
    const onError = vi.fn();
    const recorder = new BufferedObservationRecorder(
      { append: vi.fn(async () => Promise.reject(failure)) },
      {
        batchSize: 10,
        flushIntervalMs: 60_000,
        maxAttempts: 2,
        initialRetryDelayMs: 10,
        maxRetryDelayMs: 10,
        onError,
        sleep: async () => {},
      },
    );

    recorder.enqueue(observation("first"));

    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenLastCalledWith(failure, {
      attempt: 2,
      batchSize: 1,
      policy: "best-effort",
      terminal: true,
    });
    expect(recorder.getHealth()).toMatchObject({
      status: "degraded",
      pendingCount: 0,
      droppedCount: 1,
      droppedByStorageFailure: 1,
      consecutiveStorageFailures: 2,
    });
    await expect(recorder.close()).resolves.toBeUndefined();
  });

  it("surfaces each terminal storage error at one fail-fast boundary", async () => {
    const failure = new Error("Unavailable");
    const recorder = new BufferedObservationRecorder(
      { append: vi.fn(async () => Promise.reject(failure)) },
      {
        batchSize: 10,
        failurePolicy: "fail-fast",
        flushIntervalMs: 60_000,
        maxAttempts: 1,
        onError: vi.fn(),
      },
    );

    recorder.enqueue(observation("first"));

    await expect(recorder.flush()).rejects.toBe(failure);
    await expect(recorder.close()).resolves.toBeUndefined();

    const closingRecorder = new BufferedObservationRecorder(
      { append: vi.fn(async () => Promise.reject(failure)) },
      {
        batchSize: 10,
        failurePolicy: "fail-fast",
        flushIntervalMs: 60_000,
        maxAttempts: 1,
        onError: vi.fn(),
      },
    );
    closingRecorder.enqueue(observation("second"));

    const firstClose = closingRecorder.close();
    const secondClose = closingRecorder.close();

    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toBe(failure);
    expect(closingRecorder.getHealth()).toMatchObject({
      status: "closed",
      droppedByStorageFailure: 1,
    });
  });

  it("bounds admitted values across pending and active batches", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const append = vi.fn<ObservationWriter["append"]>()
      .mockImplementationOnce(async () => firstWrite)
      .mockResolvedValue(undefined);
    let now = 100;
    const onOverflow = vi.fn();
    const recorder = new BufferedObservationRecorder(
      { append },
      {
        batchSize: 1,
        flushIntervalMs: 60_000,
        maxQueueSize: 2,
        now: () => now,
        onOverflow,
      },
    );

    recorder.enqueue(observation("active"));
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
    now = 125;
    recorder.enqueue(observation("pending"));
    recorder.enqueue(observation("dropped"));

    expect(recorder.getHealth()).toEqual({
      status: "degraded",
      pendingCount: 2,
      droppedCount: 1,
      droppedByOverflow: 1,
      droppedByStorageFailure: 0,
      consecutiveStorageFailures: 0,
      oldestPendingAgeMs: 25,
    });
    expect(onOverflow).toHaveBeenCalledOnce();
    expect(onOverflow).toHaveBeenCalledWith(recorder.getHealth());

    releaseFirst?.();
    await recorder.close();

    expect(append.mock.calls.map(([events]) => events)).toEqual([
      [observation("active")],
      [observation("pending")],
    ]);
  });

  it("contains reporter failures without changing best-effort behavior", async () => {
    const recorder = new BufferedObservationRecorder(
      { append: vi.fn(async () => Promise.reject(new Error("Unavailable"))) },
      {
        flushIntervalMs: 60_000,
        maxAttempts: 1,
        onError: () => {
          throw new Error("Reporter failed");
        },
      },
    );

    recorder.enqueue(observation("first"));

    await expect(recorder.flush()).resolves.toBeUndefined();
    await recorder.close();
  });

  it("applies the selected policy to preparation failures without events", async () => {
    const failure = new Error("Preparation failed");
    const bestEffortReporter = vi.fn();
    const bestEffort = new BufferedObservationRecorder(
      { append: vi.fn(async () => {}) },
      {
        failurePolicy: "best-effort",
        flushIntervalMs: 60_000,
        onError: bestEffortReporter,
        ready: Promise.reject(failure),
      },
    );
    const failFast = new BufferedObservationRecorder(
      { append: vi.fn(async () => {}) },
      {
        failurePolicy: "fail-fast",
        flushIntervalMs: 60_000,
        onError: vi.fn(),
        ready: Promise.reject(failure),
      },
    );

    await expect(bestEffort.close()).resolves.toBeUndefined();
    expect(bestEffortReporter).toHaveBeenCalledWith(failure, {
      attempt: 1,
      batchSize: 0,
      policy: "best-effort",
      terminal: true,
    });
    await expect(failFast.close()).rejects.toBe(failure);
  });

  it("validates capacity, timing and retry boundaries", () => {
    const writer = { append: vi.fn(async () => {}) };

    expect(() => new BufferedObservationRecorder(writer, {
      maxQueueSize: 0,
    })).toThrow("maximum queue size must be a positive integer");
    expect(() => new BufferedObservationRecorder(writer, {
      flushIntervalMs: 0,
    })).toThrow("flush interval must be a positive integer");
    expect(() => new BufferedObservationRecorder(writer, {
      initialRetryDelayMs: 2,
      maxRetryDelayMs: 1,
    })).toThrow("initial retry delay cannot exceed");
  });
});
