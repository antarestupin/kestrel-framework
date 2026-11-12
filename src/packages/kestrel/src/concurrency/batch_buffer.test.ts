import { setImmediate } from "node:timers/promises";
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
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(39);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith([1, 2]);
    await buffer.run();
  });

  it("keeps a long batch wait beyond the native timer range", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const maximumNativeDelayMs = 2_147_483_647;
    const handler = vi.fn(async () => undefined);
    const buffer = new BatchBuffer<number>({
      maxBatchSize: 10,
      maxWaitMs: maximumNativeDelayMs + 50,
      execution: "sequential",
      handler,
    });

    try {
      // A buffer can be created long after the monotonic clock started.
      await vi.advanceTimersByTimeAsync(100);
      buffer.add(1);
      // A native timer outside its supported range would fire after one millisecond.
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(maximumNativeDelayMs + 48);
      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledExactlyOnceWith([1]);
    } finally {
      await buffer.close();
    }
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

  it("retains parallel outcomes in admission order despite reverse completion", async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const buffer = new BatchBuffer<number, number>({
      maxBatchSize: 1,
      maxWaitMs: 100,
      execution: "parallel",
      handler: async ([value]) => {
        await gates[value!]!.promise;
        return value!;
      },
    });
    for (const value of [0, 1, 2]) buffer.add(value);
    const draining = buffer.run();
    // Complete each handler in reverse order, then read the admission-ordered snapshot.
    for (const gate of [...gates].reverse()) {
      gate.resolve();
      await setImmediate();
    }
    expect((await draining).results).toEqual([
      { key: [0], result: 0 }, { key: [1], result: 1 }, { key: [2], result: 2 },
    ]);
  });

  it("cancels the age timer when the size boundary consumes its values", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => undefined);
    const buffer = new BatchBuffer<number>({ maxBatchSize: 2, maxWaitMs: 100, execution: "parallel", handler });
    try {
      buffer.add(1);
      expect(vi.getTimerCount()).toBe(1);
      buffer.add(2);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledExactlyOnceWith([1, 2]);
    } finally {
      await buffer.close();
    }
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

    const fulfilled = vi.fn();
    const rejected = vi.fn();
    void buffer.addAndWait(1).then(fulfilled, rejected);
    void buffer.addAndWait(2).then(fulfilled, rejected);
    await buffer.close();
    expect(fulfilled).toHaveBeenCalledExactlyOnceWith("first");
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
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

    const fulfilled = vi.fn();
    const rejected = vi.fn();
    void buffer.addAndWait(1).then(fulfilled, rejected);
    await buffer.close();
    expect(fulfilled).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: "BatchBufferResultNotFoundError",
      message: "The batch handler returned no outcome for an awaited value.",
    }));
    expect(rejected.mock.calls[0]?.[0]).toBeInstanceOf(BatchBufferResultNotFoundError);
  });

  it("reports one failed batch if reading the handler aggregate throws", async () => {
    const failure = new Error("cannot read aggregate outcomes");
    const buffer = new BatchBuffer<number, AggregatedResult<number, string, Error>>({
      maxBatchSize: 1,
      maxWaitMs: 60_000,
      execution: "parallel",
      handler: () => ({
        status: "success",
        get results(): never { throw failure; },
        errors: [],
        data: undefined,
      }),
    });

    const fulfilled = vi.fn();
    const rejected = vi.fn();
    void buffer.addAndWait(1).then(fulfilled, rejected);
    // A handler invocation owns one aggregate outcome even when item settlement fails.
    const result = await buffer.close();
    expect(result.status).toBe("error");
    expect(result.results).toHaveLength(0);
    expect(result.errors).toEqual([{ key: [1], error: failure }]);
    expect(fulfilled).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
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

    const fulfilled = vi.fn();
    const rejected = vi.fn();
    void buffer.addAndWait(1).then(fulfilled, rejected);
    await buffer.close();
    expect(fulfilled).toHaveBeenCalledExactlyOnceWith("awaited");
    expect(rejected).not.toHaveBeenCalled();
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
    expect(() => buffer.add(2)).toThrow(expect.objectContaining({
      name: "BatchBufferClosedError",
      message: "Cannot add a value to a closed batch buffer.",
    }));
    await expect(firstClose).resolves.toMatchObject({ status: "success" });
    expect(buffer.close()).toBe(firstClose);
  });

  it("drains a value accepted between an idle run and close", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async (batch: readonly number[]) => batch.length);
    const buffer = new BatchBuffer({
      maxBatchSize: 10,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler,
    });

    const run = buffer.run();
    buffer.add(1);
    const closing = buffer.close();

    expect(buffer.run()).toBe(closing);
    await expect(closing).resolves.toMatchObject({
      results: [{ key: [1], result: 1 }],
    });
    await run;
    expect(buffer.pendingCount).toBe(0);
    expect(handler).toHaveBeenCalledExactlyOnceWith([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares an active drain while forcing the incomplete batch at the run boundary", async () => {
    const handler = vi.fn(async (batch: readonly number[]) => batch.length);
    const buffer = new BatchBuffer({
      maxBatchSize: 10,
      maxWaitMs: 60_000,
      execution: "sequential",
      handler,
    });
    buffer.add(1);
    const draining = buffer.run();
    buffer.add(2);

    expect(buffer.run()).toBe(draining);
    await expect(buffer.close()).resolves.toMatchObject({
      results: [{ key: [1], result: 1 }, { key: [2], result: 1 }],
    });
    expect(buffer.pendingCount).toBe(0);
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
    expect(() => new BatchBuffer({
      maxBatchSize: 1,
      maxWaitMs: -1,
      execution: "parallel",
      handler: () => undefined,
    })).toThrow("Batch buffer wait must be a non-negative finite number.");
    expect(() => new BatchBuffer({
      maxBatchSize: 1,
      maxWaitMs: 0,
      execution: "parallel",
      handler: () => undefined,
    })).not.toThrow();
    expect(() => new BatchBuffer({
      maxBatchSize: 1,
      maxWaitMs: 1,
      // @ts-expect-error Untyped callers still receive a clear validation error.
      execution: "invalid",
      handler: async () => undefined,
    })).toThrow('Batch buffer execution must be either "parallel" or "sequential".');
  });
});
