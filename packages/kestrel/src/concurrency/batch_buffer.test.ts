import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type AggregatedResult,
  BatchBuffer,
  BatchBufferClosedError,
  BatchBufferResultNotFoundError,
  createAggregatedResult,
} from "./index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("BatchBuffer", () => {
  it("starts strictly bounded batches when the size boundary is reached", async () => {
    const handler = vi.fn(async (batch: readonly number[]) => batch.length);
    const buffer = new BatchBuffer({
      maxBatchSize: 2,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler,
    });

    for (const value of [1, 2, 3, 4, 5]) {
      buffer.add(value);
    }

    const result = await buffer.run();

    expect(handler.mock.calls.map(([batch]) => batch)).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(result).toEqual({
      status: "success",
      results: [
        { key: [1, 2], result: 2 },
        { key: [3, 4], result: 2 },
        { key: [5], result: 1 },
      ],
      errors: [],
      data: undefined,
    });
  });

  it("starts the timeout at the first value of an incomplete batch", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => undefined);
    const buffer = new BatchBuffer<number>({
      maxBatchSize: 10,
      maxWaitMs: 100,
      execution: "sequential",
      handler,
    });

    buffer.add(1);
    await vi.advanceTimersByTimeAsync(60);
    buffer.add(2);
    await vi.advanceTimersByTimeAsync(39);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith([1, 2]);
    await buffer.run();
  });

  it("executes ready batches sequentially", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = vi.fn(async (batch: readonly number[]) => {
      if (batch[0] === 1) {
        await firstPending;
      }
    });
    const buffer = new BatchBuffer<number>({
      maxBatchSize: 2,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler,
    });

    for (const value of [1, 2, 3, 4]) {
      buffer.add(value);
    }

    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await buffer.run();

    expect(handler.mock.calls.map(([batch]) => batch)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("executes ready batches in parallel", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => pending);
    const buffer = new BatchBuffer<number>({
      maxBatchSize: 2,
      maxWaitMs: 60_000,
      execution: "parallel",
      handler,
    });

    for (const value of [1, 2, 3, 4]) {
      buffer.add(value);
    }

    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(2);
    release?.();
    await buffer.run();
  });

  it("aggregates handler failures and continues later batches", async () => {
    const failure = new Error("Unavailable");
    const handler = vi.fn(async (batch: readonly number[]) => {
      if (batch[0] === 1) {
        throw failure;
      }

      return batch[0];
    });
    const buffer = new BatchBuffer({
      maxBatchSize: 1,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler,
    });

    buffer.add(1);
    buffer.add(2);

    await expect(buffer.run()).resolves.toEqual({
      status: "partial",
      results: [{ key: [2], result: 2 }],
      errors: [{ key: [1], error: failure }],
      data: undefined,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("returns the outcome associated with each added value", async () => {
    const failure = new Error("Unavailable");
    const buffer = new BatchBuffer<
      number,
      AggregatedResult<number, string, Error>
    >({
      maxBatchSize: 2,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler: async (batch) => createAggregatedResult({
        results: [{ key: batch[0] as number, result: "first" }],
        errors: [{ key: batch[1] as number, error: failure }],
      }),
    });

    const first = buffer.addAndWait(1);
    const second = buffer.addAndWait(2);

    await expect(first).resolves.toBe("first");
    await expect(second).rejects.toBe(failure);
  });

  it("rejects an awaited value omitted from its aggregated result", async () => {
    const buffer = new BatchBuffer<
      number,
      AggregatedResult<number, string, Error>
    >({
      maxBatchSize: 1,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler: async () => createAggregatedResult(),
    });

    await expect(buffer.addAndWait(1)).rejects.toBeInstanceOf(
      BatchBufferResultNotFoundError,
    );
  });

  it("matches repeated values to outcomes in admission order", async () => {
    const buffer = new BatchBuffer<
      number,
      AggregatedResult<number, string, never>
    >({
      maxBatchSize: 2,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler: async () => createAggregatedResult({
        results: [
          { key: 1, result: "unawaited" },
          { key: 1, result: "awaited" },
        ],
      }),
    });

    buffer.add(1);

    await expect(buffer.addAndWait(1)).resolves.toBe("awaited");
  });

  it("includes values added while a run is draining", async () => {
    let release: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async (batch: readonly number[]) => {
      if (batch[0] === 1) {
        await firstPending;
      }
    });
    const buffer = new BatchBuffer<number>({
      maxBatchSize: 1,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler,
    });

    buffer.add(1);
    const run = buffer.run();
    await Promise.resolve();
    buffer.add(2);
    release?.();

    const result = await run;
    expect(result.results.map(({ key }) => key)).toEqual([[1], [2]]);
  });

  it("consumes completed automatic outcomes at one run boundary", async () => {
    const buffer = new BatchBuffer<number>({
      maxBatchSize: 1,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler: async () => undefined,
    });

    buffer.add(1);
    await vi.waitFor(() => expect(buffer.activeBatchCount).toBe(0));

    expect((await buffer.run()).results).toHaveLength(1);
    expect((await buffer.run()).results).toHaveLength(0);
  });

  it("closes admission synchronously and shares the terminal result", async () => {
    const buffer = new BatchBuffer<number>({
      maxBatchSize: 10,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler: async () => undefined,
    });
    buffer.add(1);

    const firstClose = buffer.close();
    const secondClose = buffer.close();

    expect(secondClose).toBe(firstClose);
    expect(() => buffer.add(2)).toThrow(BatchBufferClosedError);
    await expect(firstClose).resolves.toMatchObject({ status: "success" });
  });

  it("validates size and wait boundaries", () => {
    expect(() => new BatchBuffer({
      maxBatchSize: 0,
      maxWaitMs: 1,
      execution: "sequential",
      handler: async () => undefined,
    })).toThrow("Batch buffer size must be a positive integer.");
    expect(() => new BatchBuffer({
      maxBatchSize: 1,
      maxWaitMs: Number.NaN,
      execution: "sequential",
      handler: async () => undefined,
    })).toThrow("Batch buffer wait must be a non-negative finite number.");
  });
});
