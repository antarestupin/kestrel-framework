import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  LockAcquisitionAbortedError,
  LockAcquisitionTimeoutError,
  LockBatchAcquisitionAbortedError,
  LockBatchAcquisitionTimeoutError,
  LockLostError,
  LockReleasedError,
} from "./errors.js";
import { LockManager } from "./lock_manager.js";
import { MemoryLockAdapter } from "./adapters/memory/index.js";
import {
  lockAcquisitionObservation,
  lockBatchAcquisitionObservation,
  lockExtensionObservation,
  lockReleaseObservation,
  type LockInstrumentationEvent,
} from "./observations.js";
import type {
  LockAcquireRequest,
  LockAdapter,
  LockExtendRequest,
  LockLease,
  LockReleaseRequest,
} from "./types.js";

describe("LockManager", () => {
  afterEach(() => vi.useRealTimers());

  it("namespaces keys and caps the requested TTL", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter, { maxTtlMs: 2_000 });

    const lock = await locks.tryAcquire("job", { ttlMs: 10_000 });

    expect(adapter.acquireRequests).toEqual([{
      key: "test:job",
      ownerId: "owner-1",
      ttlMs: 2_000,
    }]);
    expect(lock).toMatchObject({
      key: "job",
      fencingToken: 1n,
    });
  });

  it("returns undefined immediately when a lock is contended", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    const locks = createManager(adapter);

    await expect(locks.tryAcquire("job")).resolves.toBeUndefined();

    expect(adapter.acquireRequests).toHaveLength(1);
  });

  it("waits and retries until a lock becomes available", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    let nowMs = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
      adapter.available = true;
    });
    const locks = createManager(adapter, {
      now: () => new Date(nowMs),
      sleep,
    });

    await expect(locks.acquire("job", {
      waitTimeoutMs: 100,
      retryIntervalMs: 20,
    })).resolves.toMatchObject({ key: "job" });

    expect(sleep).toHaveBeenCalledWith(20, undefined);
    expect(adapter.acquireRequests).toHaveLength(2);
  });

  it("throws a typed error when the waiting deadline is reached", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    let nowMs = 0;
    const locks = createManager(adapter, {
      now: () => new Date(nowMs),
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
    });

    await expect(locks.acquire("job", {
      waitTimeoutMs: 40,
      retryIntervalMs: 25,
    })).rejects.toEqual(new LockAcquisitionTimeoutError("job"));
  });

  it("does not retry when the wait timeout is zero", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    const sleep = vi.fn(async () => undefined);
    const locks = createManager(adapter, { sleep });

    await expect(locks.acquire("job", { waitTimeoutMs: 0 }))
      .rejects.toBeInstanceOf(LockAcquisitionTimeoutError);
    expect(sleep).not.toHaveBeenCalled();
    expect(adapter.acquireRequests).toHaveLength(1);
  });

  it("honors an aborted acquisition signal", async () => {
    const locks = createManager(new RecordingAdapter());
    const controller = new AbortController();
    controller.abort();

    await expect(locks.acquire("job", { signal: controller.signal }))
      .rejects.toEqual(new LockAcquisitionAbortedError("job"));
  });

  it("acquires many locks in input order through the adapter fallback", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);

    const handles = await locks.acquireMany(["second", "first"]);

    expect(handles.map((handle) => handle.key)).toEqual(["second", "first"]);
    expect(adapter.acquireRequests.map((request) => request.key)).toEqual([
      "test:first",
      "test:second",
    ]);
  });

  it("releases a partial fallback batch before retrying", async () => {
    const adapter = new RecordingAdapter();
    adapter.contendedKeys.add("test:second");
    let nowMs = 0;
    const locks = createManager(adapter, {
      now: () => new Date(nowMs),
      sleep: async (delayMs) => {
        nowMs += delayMs;
        adapter.contendedKeys.clear();
      },
    });

    await expect(locks.acquireMany(["first", "second"], {
      waitTimeoutMs: 100,
      retryIntervalMs: 10,
    })).resolves.toHaveLength(2);
    expect(adapter.releaseRequests[0]).toMatchObject({ key: "test:first" });
  });

  it("uses an adapter batch operation when one is available", async () => {
    const adapter = new BatchRecordingAdapter();
    const locks = createManager(adapter);

    await locks.acquireMany(["second", "first"]);

    expect(adapter.batchRequests).toHaveLength(1);
    expect(adapter.acquireRequests).toHaveLength(0);
  });

  it("acquires an empty batch without calling the adapter", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);

    await expect(locks.acquireMany([])).resolves.toEqual([]);
    expect(adapter.acquireRequests).toHaveLength(0);
  });

  it("propagates partial fallback cleanup failures", async () => {
    const adapter = new RecordingAdapter();
    adapter.contendedKeys.add("test:second");
    adapter.releaseError = new Error("cleanup failed");
    const locks = createManager(adapter);

    const acquisition = locks.acquireMany(["first", "second"], {
      waitTimeoutMs: 0,
    });

    await expect(acquisition).rejects.toBeInstanceOf(AggregateError);
    await expect(acquisition).rejects.toMatchObject({
      errors: [adapter.releaseError],
    });
  });

  it("times out, aborts and rejects duplicate lock batches", async () => {
    const adapter = new RecordingAdapter();
    adapter.available = false;
    const locks = createManager(adapter, {
      now: () => new Date(0),
    });

    await expect(locks.acquireMany(["first", "second"], {
      waitTimeoutMs: 0,
    })).rejects.toBeInstanceOf(LockBatchAcquisitionTimeoutError);

    const controller = new AbortController();
    controller.abort();
    await expect(locks.acquireMany(["first", "second"], {
      signal: controller.signal,
    })).rejects.toBeInstanceOf(LockBatchAcquisitionAbortedError);
    await expect(locks.acquireMany(["same", "same"]))
      .rejects.toThrow("duplicate keys");
  });

  it("extends a handle and updates it only after adapter confirmation", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);
    const lock = await locks.acquire("job");
    const originalExpiration = lock.expiresAt;
    adapter.extendResult = undefined;

    await expect(lock.extend(2_000)).rejects.toEqual(
      new LockLostError("job"),
    );
    expect(lock.expiresAt).toEqual(originalExpiration);
  });

  it("makes release idempotent and prevents later extension", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);
    const lock = await locks.acquire("job");

    await lock.release();
    await lock.release();

    expect(adapter.releaseRequests).toHaveLength(1);
    await expect(lock.extend()).rejects.toEqual(
      new LockReleasedError("job"),
    );
  });

  it("releases after successful and failed exclusive operations", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);

    await expect(locks.runExclusive("success", async () => "result"))
      .resolves.toBe("result");
    await expect(locks.runExclusive("failure", async () => {
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");

    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("extends a lock automatically while an exclusive handler runs", async () => {
    vi.useFakeTimers();
    const adapter = new RecordingAdapter();
    adapter.extendResult = {
      key: "test:job",
      ownerId: "owner-1",
      expiresAt: new Date(2_000),
      fencingToken: 1n,
    };
    const locks = createManager(adapter);
    const started = deferred();
    const finish = deferred();
    let handlerSignal: AbortSignal | undefined;
    const operation = locks.runExclusive("job", async (_lock, context) => {
      handlerSignal = context.signal;
      started.resolve();
      await finish.promise;
      return "result";
    });
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    expect(adapter.extendRequests).toHaveLength(1);
    expect(handlerSignal?.aborted).toBe(false);
    finish.resolve();
    await expect(operation).resolves.toBe("result");
    expect(adapter.releaseRequests).toHaveLength(1);
  });

  it("aborts the handler signal and reports a lost heartbeat lease", async () => {
    vi.useFakeTimers();
    const adapter = new RecordingAdapter();
    adapter.extendResult = undefined;
    const locks = createManager(adapter);
    const started = deferred();
    let abortReason: unknown;
    const operation = locks.runExclusive("job", async (_lock, { signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener(
        "abort",
        () => {
          abortReason = signal.reason;
          resolve();
        },
        { once: true },
      ));
    });
    const outcome = expect(operation).rejects.toBeInstanceOf(LockLostError);
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    await outcome;
    expect(abortReason).toBeInstanceOf(LockLostError);
    expect(adapter.releaseRequests).toHaveLength(1);
  });

  it("preserves operation and release failures in an AggregateError", async () => {
    const adapter = new RecordingAdapter();
    adapter.releaseError = new Error("release failed");
    const locks = createManager(adapter);

    const result = locks.runExclusive("job", async () => {
      throw new Error("operation failed");
    });

    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "operation failed" }),
        adapter.releaseError,
      ],
    });
  });

  it("runs with many locks and releases all handles after failure", async () => {
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter);
    const operation = locks.runExclusiveMany(
      ["second", "first"],
      async (handles) => {
        expect(handles.map((handle) => handle.key)).toEqual([
          "second",
          "first",
        ]);
        throw new Error("operation failed");
      },
    );

    await expect(operation).rejects.toThrow("operation failed");
    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("uses adapter batch extension for a running lock batch", async () => {
    vi.useFakeTimers();
    const adapter = new BatchRecordingAdapter();
    const locks = createManager(adapter);
    const started = deferred();
    const finish = deferred();
    const operation = locks.runExclusiveMany(
      ["second", "first"],
      async (_handles, { signal }) => {
        expect(signal.aborted).toBe(false);
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    expect(adapter.extensionBatchRequests).toHaveLength(1);
    expect(adapter.extendRequests).toHaveLength(0);
    finish.resolve();
    await expect(operation).resolves.toBeUndefined();
  });

  it("aborts a batch handler when adapter batch extension loses ownership", async () => {
    vi.useFakeTimers();
    const adapter = new BatchRecordingAdapter();
    adapter.extensionBatchAvailable = false;
    const locks = createManager(adapter);
    const started = deferred();
    let abortReason: unknown;
    const operation = locks.runExclusiveMany(
      ["first", "second"],
      async (_handles, { signal }) => {
        started.resolve();
        await new Promise<void>((resolve) => signal.addEventListener(
          "abort",
          () => {
            abortReason = signal.reason;
            resolve();
          },
          { once: true },
        ));
      },
    );
    const outcome = expect(operation).rejects.toBeInstanceOf(AggregateError);
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    await outcome;
    expect(abortReason).toBeInstanceOf(AggregateError);
    expect(adapter.extensionBatchRequests).toHaveLength(1);
    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("falls back to all individual extensions for a lock batch", async () => {
    vi.useFakeTimers();
    const adapter = new RecordingAdapter();
    adapter.extendResults.set("test:first", {
      key: "test:first",
      ownerId: "owner-1",
      expiresAt: new Date(2_000),
      fencingToken: 1n,
    });
    adapter.extendResults.set("test:second", undefined);
    const locks = createManager(adapter);
    const started = deferred();
    const operation = locks.runExclusiveMany(
      ["first", "second"],
      async (_handles, { signal }) => {
        started.resolve();
        await new Promise<void>((resolve) => signal.addEventListener(
          "abort",
          () => resolve(),
          { once: true },
        ));
      },
    );
    const outcome = expect(operation).rejects.toBeInstanceOf(LockLostError);
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    await outcome;
    expect(adapter.extendRequests).toHaveLength(2);
    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("aggregates a handler error with every batch release failure", async () => {
    const adapter = new RecordingAdapter();
    adapter.releaseError = new Error("release failed");
    const locks = createManager(adapter);

    const operation = locks.runExclusiveMany(
      ["first", "second"],
      async () => {
        throw new Error("operation failed");
      },
    );

    await expect(operation).rejects.toBeInstanceOf(AggregateError);
    await expect(operation).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "operation failed" }),
        adapter.releaseError,
        adapter.releaseError,
      ],
    });
    expect(adapter.releaseRequests).toHaveLength(2);
  });

  it("aggregates handler, heartbeat and release failures", async () => {
    vi.useFakeTimers();
    const adapter = new RecordingAdapter();
    adapter.extendResult = undefined;
    adapter.releaseError = new Error("release failed");
    const locks = createManager(adapter);
    const started = deferred();
    const operation = locks.runExclusive("job", async (_lock, { signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener(
        "abort",
        () => resolve(),
        { once: true },
      ));
      throw new Error("handler aborted");
    });
    const outcome = expect(operation).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "handler aborted" }),
        expect.any(LockLostError),
        adapter.releaseError,
      ],
    });
    await started.promise;

    await vi.advanceTimersByTimeAsync(500);

    await outcome;
  });

  it("rejects invalid keys and timing options", async () => {
    const locks = createManager(new RecordingAdapter());

    await expect(locks.tryAcquire(""))
      .rejects.toThrow("Lock keys cannot be empty");
    await expect(locks.tryAcquire("job", { ttlMs: 0 }))
      .rejects.toThrow("ttlMs must be a positive finite number");
    await expect(locks.acquire("job", { waitTimeoutMs: -1 }))
      .rejects.toThrow("waitTimeoutMs must be a non-negative finite number");
  });

  it("exports stable typed observation definitions", () => {
    expect(lockAcquisitionObservation).toMatchObject({
      name: "lock.acquisition",
      category: "lock",
      schemaVersion: 1,
    });
    expect(lockBatchAcquisitionObservation.name)
      .toBe("lock.batch-acquisition");
    expect(lockExtensionObservation.name).toBe("lock.extension");
    expect(lockReleaseObservation.name).toBe("lock.release");
  });

  it("records immediate acquisition and contention outcomes", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    let time = 10;
    const locks = createManager(adapter, {
      instrumentation,
      formatObservationKey: (key) => `redacted:${key}`,
      monotonicNow: () => {
        time += 5;
        return time;
      },
    });

    await locks.tryAcquire("available", { ttlMs: 2_000 });
    adapter.available = false;
    await locks.tryAcquire("busy");

    expect(instrumentation.events).toEqual([
      {
        type: "acquisition",
        outcome: "success",
        durationMs: 5,
        data: {
          key: "redacted:available",
          mode: "immediate",
          result: "acquired",
          attempts: 1,
          ttlMs: 2_000,
          fencingToken: "1",
        },
      },
      {
        type: "acquisition",
        outcome: "success",
        durationMs: 5,
        data: {
          key: "redacted:busy",
          mode: "immediate",
          result: "contended",
          attempts: 1,
          ttlMs: 1_000,
        },
      },
    ]);
    expect(JSON.stringify(instrumentation.events)).not.toContain("owner-");
  });

  it("records retry count and total wait duration on acquisition", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    adapter.available = false;
    let nowMs = 0;
    const locks = createManager(adapter, {
      instrumentation,
      monotonicNow: () => nowMs,
      now: () => new Date(nowMs),
      sleep: async (delayMs) => {
        nowMs += delayMs;
        adapter.available = true;
      },
    });

    await locks.acquire("job", {
      ttlMs: 3_000,
      waitTimeoutMs: 100,
      retryIntervalMs: 20,
    });

    expect(instrumentation.events).toEqual([{
      type: "acquisition",
      outcome: "success",
      durationMs: 20,
      data: {
        key: "job",
        mode: "wait",
        result: "acquired",
        attempts: 2,
        ttlMs: 3_000,
        waitTimeoutMs: 100,
        fencingToken: "1",
      },
    }]);
  });

  it("records one formatted observation for a batch acquisition", async () => {
    const instrumentation = new RecordingInstrumentation();
    const locks = createManager(new RecordingAdapter(), {
      instrumentation,
      formatObservationKey: (key) => `formatted:${key}`,
      monotonicNow: () => 0,
    });

    await locks.acquireMany(["second", "first"]);

    expect(instrumentation.events).toContainEqual({
      type: "batch-acquisition",
      outcome: "success",
      durationMs: 0,
      data: {
        keys: ["formatted:second", "formatted:first"],
        result: "acquired",
        attempts: 1,
        ttlMs: 1_000,
        waitTimeoutMs: 100,
        fencingTokens: ["1", "1"],
      },
    });
  });

  it("classifies timeout, cancellation and storage acquisition errors", async () => {
    const timeoutInstrumentation = new RecordingInstrumentation();
    const timeoutAdapter = new RecordingAdapter();
    timeoutAdapter.available = false;
    let nowMs = 0;
    const timeoutLocks = createManager(timeoutAdapter, {
      instrumentation: timeoutInstrumentation,
      monotonicNow: () => nowMs,
      now: () => new Date(nowMs),
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
    });

    await expect(timeoutLocks.acquire("timeout", {
      waitTimeoutMs: 10,
      retryIntervalMs: 10,
    })).rejects.toBeInstanceOf(LockAcquisitionTimeoutError);

    const abortedInstrumentation = new RecordingInstrumentation();
    const abortedLocks = createManager(new RecordingAdapter(), {
      instrumentation: abortedInstrumentation,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(abortedLocks.acquire("aborted", {
      signal: controller.signal,
    })).rejects.toBeInstanceOf(LockAcquisitionAbortedError);

    const errorInstrumentation = new RecordingInstrumentation();
    const errorAdapter = new RecordingAdapter();
    errorAdapter.acquireError = new Error("storage failed");
    const errorLocks = createManager(errorAdapter, {
      instrumentation: errorInstrumentation,
    });
    await expect(errorLocks.tryAcquire("error"))
      .rejects.toBe(errorAdapter.acquireError);

    expect(timeoutInstrumentation.events[0]).toMatchObject({
      type: "acquisition",
      outcome: "failure",
      durationMs: 10,
      data: { result: "timeout", attempts: 2 },
    });
    expect(abortedInstrumentation.events[0]).toMatchObject({
      type: "acquisition",
      outcome: "failure",
      data: { result: "aborted", attempts: 0 },
    });
    expect(errorInstrumentation.events[0]).toMatchObject({
      type: "acquisition",
      outcome: "failure",
      data: { result: "error", attempts: 1 },
    });
  });

  it("records successful, lost and rejected lease extensions", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter, { instrumentation });
    const extended = await locks.acquire("extended");
    adapter.extendResult = {
      key: "test:extended",
      ownerId: "owner-1",
      expiresAt: new Date(2_000),
      fencingToken: 1n,
    };
    await extended.extend(2_000);

    const lost = await locks.acquire("lost");
    adapter.extendResult = undefined;
    await expect(lost.extend()).rejects.toBeInstanceOf(LockLostError);

    await extended.release();
    await expect(extended.extend()).rejects.toBeInstanceOf(
      LockReleasedError,
    );

    const extensionEvents = instrumentation.events.filter(
      (event) => event.type === "extension",
    );
    expect(extensionEvents.map((event) => event.data.result)).toEqual([
      "extended",
      "lost",
      "already-released",
    ]);
    expect(extensionEvents.map((event) => event.outcome)).toEqual([
      "success",
      "failure",
      "failure",
    ]);
  });

  it("records release ownership and total held duration", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    let time = 0;
    const locks = createManager(adapter, {
      instrumentation,
      monotonicNow: () => time,
    });
    const released = await locks.acquire("released");
    time = 50;
    await released.release();
    time = 60;
    await released.release();

    const missing = await locks.acquire("missing");
    adapter.releaseResult = false;
    time = 100;
    await missing.release();

    const releaseEvents = instrumentation.events.filter(
      (event) => event.type === "release",
    );
    expect(releaseEvents).toMatchObject([
      {
        outcome: "success",
        data: { result: "released", heldDurationMs: 50 },
      },
      {
        outcome: "success",
        data: { result: "already-released", heldDurationMs: 60 },
      },
      {
        outcome: "failure",
        data: { result: "not-owned", heldDurationMs: 40 },
      },
    ]);
  });

  it("records extension and release storage errors", async () => {
    const instrumentation = new RecordingInstrumentation();
    const adapter = new RecordingAdapter();
    const locks = createManager(adapter, { instrumentation });
    const lock = await locks.acquire("job");
    adapter.extendError = new Error("extend failed");

    await expect(lock.extend()).rejects.toBe(adapter.extendError);

    adapter.releaseError = new Error("release failed");
    await expect(lock.release()).rejects.toBe(adapter.releaseError);

    expect(instrumentation.events.slice(1).map((event) => ({
      type: event.type,
      outcome: event.outcome,
      result: event.data.result,
    }))).toEqual([
      { type: "extension", outcome: "failure", result: "error" },
      { type: "release", outcome: "failure", result: "error" },
    ]);
  });

  it("ignores instrumentation and key formatting failures", async () => {
    const adapter = new RecordingAdapter();
    const instrumentation = {
      record: vi.fn(() => {
        throw new Error("instrumentation failed");
      }),
    };
    const locks = createManager(adapter, { instrumentation });
    const lock = await locks.acquire("job");

    await expect(lock.release()).resolves.toBeUndefined();
    expect(instrumentation.record).toHaveBeenCalledTimes(2);

    const formattingInstrumentation = new RecordingInstrumentation();
    const formattingFailure = createManager(adapter, {
      instrumentation: formattingInstrumentation,
      formatObservationKey: () => {
        throw new Error("formatting failed");
      },
    });
    const formattedLock = await formattingFailure.acquire("formatted");
    await expect(formattedLock.release()).resolves.toBeUndefined();
    expect(formattingInstrumentation.events).toHaveLength(0);

    const clockInstrumentation = new RecordingInstrumentation();
    const clockFailure = createManager(adapter, {
      instrumentation: clockInstrumentation,
      monotonicNow: () => {
        throw new Error("clock failed");
      },
    });
    const measuredLock = await clockFailure.acquire("measured");
    await expect(measuredLock.release()).resolves.toBeUndefined();
    expect(clockInstrumentation.events).toHaveLength(2);
    expect(clockInstrumentation.events.every(
      (event) => Number.isFinite(event.durationMs),
    )).toBe(true);
  });
});

class RecordingAdapter implements LockAdapter {
  public readonly acquireRequests: LockAcquireRequest[] = [];

  public readonly releaseRequests: LockReleaseRequest[] = [];

  public readonly extendRequests: LockExtendRequest[] = [];

  public readonly extendResults = new Map<
    string,
    LockLease | undefined
  >();

  public available = true;

  public readonly contendedKeys = new Set<string>();

  public extendResult: LockLease | undefined;

  public acquireError?: Error;

  public extendError?: Error;

  public releaseError?: Error;

  public releaseResult = true;

  public async tryAcquire(
    request: Parameters<LockAdapter["tryAcquire"]>[0],
  ): Promise<LockLease | undefined> {
    this.acquireRequests.push(request);

    if (this.acquireError !== undefined) {
      throw this.acquireError;
    }

    if (!this.available || this.contendedKeys.has(request.key)) {
      return undefined;
    }

    return {
      ...request,
      expiresAt: new Date(request.ttlMs),
      fencingToken: 1n,
    };
  }

  public async extend(
    request: Parameters<LockAdapter["extend"]>[0],
  ): Promise<LockLease | undefined> {
    this.extendRequests.push(request);

    if (this.extendError !== undefined) {
      throw this.extendError;
    }

    if (this.extendResults.has(request.key)) {
      return this.extendResults.get(request.key);
    }

    return this.extendResult;
  }

  public async release(request: LockReleaseRequest): Promise<boolean> {
    this.releaseRequests.push(request);

    if (this.releaseError !== undefined) {
      throw this.releaseError;
    }

    return this.releaseResult;
  }
}

class BatchRecordingAdapter extends RecordingAdapter {
  public readonly batchRequests: Array<readonly object[]> = [];

  public readonly extensionBatchRequests: Array<readonly object[]> = [];

  public extensionBatchAvailable = true;

  public async tryAcquireMany(
    requests: Parameters<NonNullable<LockAdapter["tryAcquireMany"]>>[0],
  ): Promise<readonly LockLease[] | undefined> {
    this.batchRequests.push(requests);

    return requests.map((request) => ({
      ...request,
      expiresAt: new Date(request.ttlMs),
      fencingToken: 1n,
    }));
  }

  public async extendMany(
    requests: Parameters<NonNullable<LockAdapter["extendMany"]>>[0],
  ): Promise<readonly LockLease[] | undefined> {
    this.extensionBatchRequests.push(requests);

    if (!this.extensionBatchAvailable) {
      return undefined;
    }

    return requests.map((request) => ({
      ...request,
      expiresAt: new Date(request.ttlMs * 2),
      fencingToken: 1n,
    }));
  }
}

class RecordingInstrumentation {
  public readonly events: LockInstrumentationEvent[] = [];

  public record(event: LockInstrumentationEvent): void {
    this.events.push(event);
  }
}

function createManager(
  adapter: LockAdapter,
  overrides: Partial<ConstructorParameters<typeof LockManager>[1]> = {},
): LockManager {
  let owner = 0;

  return new LockManager(adapter, {
    namespace: "test",
    defaultTtlMs: 1_000,
    maxTtlMs: 10_000,
    defaultWaitTimeoutMs: 100,
    retryIntervalMs: 10,
    retryJitterRatio: 0,
    now: () => new Date(0),
    createOwnerId: () => `owner-${++owner}`,
    random: () => 0.5,
    ...overrides,
  });
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}
