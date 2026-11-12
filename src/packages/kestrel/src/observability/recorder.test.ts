import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { BatchBuffer } from "../concurrency/index.js";
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
    expect(onError.mock.lastCall?.[1]).not.toHaveProperty("retryDelayMs");
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
    expect(bestEffort.getHealth().consecutiveStorageFailures).toBe(1);
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

it("reports a fail-fast rejection even when the writer did not supply a reason", async () => {
  const recorder = new BufferedObservationRecorder({ append: async () => Promise.reject() }, {
    failurePolicy: "fail-fast", maxAttempts: 1, flushIntervalMs: 60_000,
  });
  try {
    recorder.enqueue(observation("undelivered"));
    await expect(recorder.flush()).rejects.toBeUndefined();
    expect(recorder.getHealth().droppedByStorageFailure).toBe(1);
  } finally {
    await recorder.close();
  }
});

it("reports a queued event's preparation error without invoking the writer", async () => {
  const failure = new Error("cannot initialize writer");
  const append = vi.fn(async () => {});
  const recorder = new BufferedObservationRecorder({ append }, {
    ready: Promise.reject(failure), failurePolicy: "fail-fast", maxAttempts: 1, flushIntervalMs: 60_000,
  });
  try {
    recorder.enqueue(observation("queued"));
    await expect(recorder.flush()).rejects.toBe(failure);
    expect(append).not.toHaveBeenCalled();
  } finally {
    await recorder.close();
  }
  recorder.enqueue(observation("closed"));
  expect(recorder.getHealth()).toMatchObject({ status: "closed", pendingCount: 0, droppedByStorageFailure: 1 });
});

it("aggregates several failed batches at one fail-fast boundary", async () => {
  const first = new Error("first batch failed");
  const second = new Error("second batch failed");
  const append = vi.fn<ObservationWriter["append"]>().mockRejectedValueOnce(first).mockRejectedValueOnce(second);
  const recorder = new BufferedObservationRecorder({ append }, {
    batchSize: 1, failurePolicy: "fail-fast", maxAttempts: 1, flushIntervalMs: 60_000,
  });
  try {
    recorder.enqueue(observation("first"));
    recorder.enqueue(observation("second"));
    await expect(recorder.flush()).rejects.toMatchObject({
      message: "Several observation batches failed.",
      errors: [first, second],
    });
    expect(recorder.getHealth().droppedByStorageFailure).toBe(2);
  } finally {
    await recorder.close();
  }
});

it("drops further events after saturation without a diagnostics callback", async () => {
  const pending = Promise.withResolvers<void>();
  const recorder = new BufferedObservationRecorder({ append: async () => pending.promise }, {
    batchSize: 1, maxQueueSize: 1, flushIntervalMs: 60_000,
  });
  try {
    recorder.enqueue(observation("accepted"));
    recorder.enqueue(observation("first-drop"));
    recorder.enqueue(observation("second-drop"));
    expect(recorder.getHealth()).toMatchObject({ pendingCount: 1, droppedByOverflow: 2 });
  } finally {
    pending.resolve();
    await recorder.close();
  }
});

it.each([
  [{ initialRetryDelayMs: -1 }, "initial retry delay"],
  [{ failurePolicy: "ignore" }, "failure policy"],
  [{ overflowPolicy: "drop-old" }, "overflow policy"],
])("rejects invalid recorder options at the runtime boundary", (options, diagnostic) => {
  expect(() => new BufferedObservationRecorder({ append: async () => {} }, options as never)).toThrow(diagnostic);
});

it("flushes a partial batch on the default interval and releases the timer on close", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  const run = vi.spyOn(BatchBuffer.prototype, "run");
  const append = vi.fn<ObservationWriter["append"]>(async () => {});
  const recorder = new BufferedObservationRecorder({ append });

  try {
    recorder.enqueue(observation("scheduled"));
    await vi.advanceTimersByTimeAsync(99);
    expect(recorder.getHealth().oldestPendingAgeMs).toBe(99);
    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(append).toHaveBeenCalledExactlyOnceWith([observation("scheduled")]);
    expect(run).toHaveBeenCalledOnce();
    await recorder.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await recorder.close();
    run.mockRestore();
    vi.useRealTimers();
  }
});

it("does not keep the process alive for a periodic drain", async () => {
  const schedule = vi.spyOn(globalThis, "setInterval");
  const recorder = new BufferedObservationRecorder({ append: async () => {} });
  try {
    expect(schedule.mock.results[0]?.value.hasRef()).toBe(false);
  } finally {
    await recorder.close();
    schedule.mockRestore();
  }
});

it("uses the native retry timer and the configured terminal attempt boundary", async () => {
  vi.useFakeTimers();
  const append = vi.fn<ObservationWriter["append"]>().mockRejectedValue(new Error("offline"));
  const onError = vi.fn();
  const recorder = new BufferedObservationRecorder({ append }, { flushIntervalMs: 60_000, onError });

  try {
    recorder.enqueue(observation("retry"));
    const flushed = recorder.flush();
    await vi.advanceTimersByTimeAsync(99);
    expect(append).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_401);
    await flushed;
    expect(append).toHaveBeenCalledTimes(5);
    expect(onError.mock.calls.map(([, context]) => context.retryDelayMs)).toEqual([100, 200, 400, 800, undefined]);
    expect(recorder.getHealth().droppedByStorageFailure).toBe(1);
  } finally {
    await recorder.close();
    vi.useRealTimers();
  }
});

it("accepts zero retry delay and does not wait after the last attempt", async () => {
  const append = vi.fn<ObservationWriter["append"]>().mockRejectedValue(new Error("offline"));
  const sleep = vi.fn(async (_delay: number) => {});
  const recorder = new BufferedObservationRecorder({ append }, {
    initialRetryDelayMs: 0, maxRetryDelayMs: 0, maxAttempts: 2, sleep,
  });

  try {
    recorder.enqueue(observation("retry"));
    await recorder.flush();
    expect(sleep).toHaveBeenCalledExactlyOnceWith(0);
    expect(append).toHaveBeenCalledTimes(2);
  } finally {
    await recorder.close();
  }
});

it.each(["best-effort", "fail-fast"] as const)("releases capacity after a rejected retry delay in %s mode", async (failurePolicy) => {
  const writeError = new Error("offline");
  const delayError = new Error("retry delay interrupted");
  const append = vi.fn<ObservationWriter["append"]>().mockRejectedValueOnce(writeError).mockResolvedValue(undefined);
  const sleep = vi.fn(async () => { throw delayError; });
  const onError = vi.fn();
  const recorder = new BufferedObservationRecorder({ append }, { failurePolicy, maxQueueSize: 1, sleep, onError });

  try {
    recorder.enqueue(observation("interrupted"));
    const flushed = recorder.flush();
    const failure = { message: "Observation retry delay failed.", errors: [writeError, delayError] };
    if (failurePolicy === "fail-fast") {
      await expect(flushed).rejects.toMatchObject(failure);
    } else {
      await expect(flushed).resolves.toBeUndefined();
    }
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining(failure), {
      attempt: 1, batchSize: 1, policy: failurePolicy, terminal: true,
    });
    expect(recorder.getHealth()).toMatchObject({ pendingCount: 0, droppedByStorageFailure: 1 });

    recorder.enqueue(observation("next"));
    await recorder.flush();
    expect(append).toHaveBeenLastCalledWith([observation("next")]);
    expect(recorder.getHealth()).toMatchObject({ status: "healthy", droppedByOverflow: 0 });
  } finally {
    await recorder.close();
  }
});

it("reports saturation once per episode even when the reporter throws", async () => {
  const append = vi.fn<ObservationWriter["append"]>(async () => {});
  const onOverflow = vi.fn(() => { throw new Error("overflow reporter failed"); });
  let now = 100;
  const recorder = new BufferedObservationRecorder({ append }, { maxQueueSize: 1, onOverflow, now: () => now });

  try {
    recorder.enqueue(observation("first"));
    now = 90;
    recorder.enqueue(observation("first-drop"));
    recorder.enqueue(observation("second-drop"));
    expect(onOverflow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      droppedByOverflow: 1, oldestPendingAgeMs: 0,
    }));
    await recorder.flush();

    recorder.enqueue(observation("second"));
    recorder.enqueue(observation("third-drop"));
    await recorder.flush();
    expect(onOverflow).toHaveBeenCalledTimes(2);
    expect(onOverflow).toHaveBeenLastCalledWith(expect.objectContaining({ droppedByOverflow: 3 }));
    expect(append.mock.calls).toEqual([[[observation("first")]], [[observation("second")]]]);
  } finally {
    await recorder.close();
  }
});

it("reports preparation failure through the queued batch when closing", async () => {
  const error = new Error("offline");
  const append = vi.fn<ObservationWriter["append"]>(async () => {});
  const onError = vi.fn();
  const recorder = new BufferedObservationRecorder({ append }, {
    ready: Promise.reject(error), failurePolicy: "fail-fast", maxAttempts: 1, onError,
  });

  recorder.enqueue(observation("queued"));
  await expect(recorder.close()).rejects.toBe(error);
  expect(append).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledExactlyOnceWith(error, {
    attempt: 1, batchSize: 1, policy: "fail-fast", terminal: true,
  });
});
