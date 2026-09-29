import { setTimeout as sleep } from "node:timers/promises";

import { createUuid } from "../utils/uuid.js";
import { startLeaseHeartbeat } from "../scheduling/index.js";
import {
  LockAcquisitionAbortedError,
  LockAcquisitionTimeoutError,
  LockBatchAcquisitionAbortedError,
  LockBatchAcquisitionTimeoutError,
  LockLostError,
  LockReleasedError,
} from "./errors.js";
import type {
  LockInstrumentation,
  LockInstrumentationEvent,
} from "./observations.js";
import type {
  Awaitable,
  LockAcquireOptions,
  LockAcquireRequest,
  LockAdapter,
  LockExtendRequest,
  LockHandle,
  LockLease,
  LockManagerOptions,
  LockRunOptions,
  LockRunContext,
  Locks,
  LockWaitOptions,
} from "./types.js";

/** Coordinates lock policy independently from the selected storage backend. */
export class LockManager implements Locks {
  private readonly now: () => Date;

  private readonly createOwnerId: () => string;

  private readonly random: () => number;

  private readonly sleep: NonNullable<LockManagerOptions["sleep"]>;

  private readonly retryJitterRatio: number;

  private readonly instrumentation: LockInstrumentation | undefined;

  private readonly formatObservationKey: (key: string) => string;

  private readonly monotonicNow: () => number;

  public constructor(
    private readonly adapter: LockAdapter,
    private readonly options: LockManagerOptions,
  ) {
    validateManagerOptions(options);
    this.now = options.now ?? (() => new Date());
    this.createOwnerId = options.createOwnerId ?? createUuid;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.retryJitterRatio = options.retryJitterRatio ?? 0.2;
    this.instrumentation = options.instrumentation;
    this.formatObservationKey = options.formatObservationKey
      ?? ((key) => key);
    this.monotonicNow = options.monotonicNow
      ?? (() => performance.now());
  }

  /** Attempts one immediate acquisition and returns undefined on contention. */
  public async tryAcquire(
    key: string,
    options: LockAcquireOptions = {},
  ): Promise<LockHandle | undefined> {
    const publicKey = validateKey(key);
    const ttlMs = this.getTtlMs(options.ttlMs);
    const startedAt = this.measureTime();

    try {
      const lease = await this.adapter.tryAcquire({
        key: this.composeKey(publicKey),
        ownerId: this.createOwnerId(),
        ttlMs,
      });
      const completedAt = this.measureTime();

      this.recordInstrumentation({
        type: "acquisition",
        outcome: "success",
        durationMs: getDuration(startedAt, completedAt),
        data: {
          key: publicKey,
          mode: "immediate",
          result: lease === undefined ? "contended" : "acquired",
          attempts: 1,
          ttlMs,
          ...(lease === undefined
            ? {}
            : { fencingToken: lease.fencingToken.toString() }),
        },
      });

      return lease === undefined
        ? undefined
        : this.createHandle(publicKey, lease, ttlMs, completedAt);
    } catch (error) {
      this.recordInstrumentation({
        type: "acquisition",
        outcome: "failure",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          key: publicKey,
          mode: "immediate",
          result: "error",
          attempts: 1,
          ttlMs,
        },
      });

      throw error;
    }
  }

  /** Waits for an available lease until the configured or explicit deadline. */
  public async acquire(
    key: string,
    options: LockWaitOptions = {},
  ): Promise<LockHandle> {
    const publicKey = validateKey(key);
    const ttlMs = this.getTtlMs(options.ttlMs);
    const waitTimeoutMs = options.waitTimeoutMs
      ?? this.options.defaultWaitTimeoutMs;
    const retryIntervalMs = options.retryIntervalMs
      ?? this.options.retryIntervalMs;

    validateNonNegativeFinite("waitTimeoutMs", waitTimeoutMs);
    validatePositiveFinite("retryIntervalMs", retryIntervalMs);

    const deadline = this.now().getTime() + waitTimeoutMs;
    const startedAt = this.measureTime();
    let attempts = 0;

    try {
      while (true) {
        this.throwIfAborted(publicKey, options.signal);
        attempts += 1;

        const lease = await this.adapter.tryAcquire({
          key: this.composeKey(publicKey),
          ownerId: this.createOwnerId(),
          ttlMs,
        });

        if (lease !== undefined) {
          const completedAt = this.measureTime();

          this.recordInstrumentation({
            type: "acquisition",
            outcome: "success",
            durationMs: getDuration(startedAt, completedAt),
            data: {
              key: publicKey,
              mode: "wait",
              result: "acquired",
              attempts,
              ttlMs,
              waitTimeoutMs,
              fencingToken: lease.fencingToken.toString(),
            },
          });

          return this.createHandle(
            publicKey,
            lease,
            ttlMs,
            completedAt,
          );
        }

        const remainingMs = deadline - this.now().getTime();

        if (remainingMs <= 0) {
          throw new LockAcquisitionTimeoutError(publicKey);
        }

        const retryDelayMs = Math.min(
          this.addJitter(retryIntervalMs),
          remainingMs,
        );

        try {
          await this.sleep(retryDelayMs, options.signal);
        } catch (error) {
          if (options.signal?.aborted === true) {
            throw new LockAcquisitionAbortedError(publicKey);
          }

          throw error;
        }
      }
    } catch (error) {
      const result = error instanceof LockAcquisitionTimeoutError
        ? "timeout"
        : error instanceof LockAcquisitionAbortedError
          ? "aborted"
          : "error";

      this.recordInstrumentation({
        type: "acquisition",
        outcome: "failure",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          key: publicKey,
          mode: "wait",
          result,
          attempts,
          ttlMs,
          waitTimeoutMs,
        },
      });

      throw error;
    }
  }

  /** Waits until every requested lease can be acquired as one logical unit. */
  public async acquireMany(
    keys: readonly string[],
    options: LockWaitOptions = {},
  ): Promise<readonly LockHandle[]> {
    const publicKeys = validateKeys(keys);
    const ttlMs = this.getTtlMs(options.ttlMs);
    const waitTimeoutMs = options.waitTimeoutMs
      ?? this.options.defaultWaitTimeoutMs;
    const retryIntervalMs = options.retryIntervalMs
      ?? this.options.retryIntervalMs;

    validateNonNegativeFinite("waitTimeoutMs", waitTimeoutMs);
    validatePositiveFinite("retryIntervalMs", retryIntervalMs);

    const deadline = this.now().getTime() + waitTimeoutMs;
    const startedAt = this.measureTime();
    let attempts = 0;

    try {
      if (publicKeys.length === 0) {
        this.recordInstrumentation({
          type: "batch-acquisition",
          outcome: "success",
          durationMs: getDuration(startedAt, this.measureTime()),
          data: {
            keys: publicKeys,
            result: "acquired",
            attempts,
            ttlMs,
            waitTimeoutMs,
            fencingTokens: [],
          },
        });
        return [];
      }

      while (true) {
        this.throwIfBatchAborted(publicKeys, options.signal);
        attempts += 1;

        const leases = await this.tryAcquireMany(publicKeys, ttlMs);

        if (leases !== undefined) {
          const completedAt = this.measureTime();
          const handles = leases.map((lease, index) => this.createHandle(
            publicKeys[index]!,
            lease,
            ttlMs,
            completedAt,
          ));

          this.recordInstrumentation({
            type: "batch-acquisition",
            outcome: "success",
            durationMs: getDuration(startedAt, completedAt),
            data: {
              keys: publicKeys,
              result: "acquired",
              attempts,
              ttlMs,
              waitTimeoutMs,
              fencingTokens: leases.map((lease) =>
                lease.fencingToken.toString()),
            },
          });

          return handles;
        }

        const remainingMs = deadline - this.now().getTime();

        if (remainingMs <= 0) {
          throw new LockBatchAcquisitionTimeoutError(publicKeys);
        }

        const retryDelayMs = Math.min(
          this.addJitter(retryIntervalMs),
          remainingMs,
        );

        try {
          await this.sleep(retryDelayMs, options.signal);
        } catch (error) {
          if (options.signal?.aborted === true) {
            throw new LockBatchAcquisitionAbortedError(publicKeys);
          }

          throw error;
        }
      }
    } catch (error) {
      const result = error instanceof LockBatchAcquisitionTimeoutError
        ? "timeout"
        : error instanceof LockBatchAcquisitionAbortedError
          ? "aborted"
          : "error";

      this.recordInstrumentation({
        type: "batch-acquisition",
        outcome: "failure",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          keys: publicKeys,
          result,
          attempts,
          ttlMs,
          waitTimeoutMs,
        },
      });

      throw error;
    }
  }

  /** Acquires, runs and reliably releases a lock around one operation. */
  public async runExclusive<Value>(
    key: string,
    handler: (
      lock: LockHandle,
      context: LockRunContext,
    ) => Awaitable<Value>,
    options: LockRunOptions = {},
  ): Promise<Value> {
    const ttlMs = this.getTtlMs(options.ttlMs);
    const lock = await this.acquire(key, options);

    return this.runWithHeartbeat(
      ttlMs,
      () => lock.extend(),
      (context) => handler(lock, context),
      async () => releaseHandles([lock]),
      `Exclusive lock operation failed for "${key}".`,
    );
  }

  /** Runs one operation while every requested lock is held. */
  public async runExclusiveMany<Value>(
    keys: readonly string[],
    handler: (
      locks: readonly LockHandle[],
      context: LockRunContext,
    ) => Awaitable<Value>,
    options: LockRunOptions = {},
  ): Promise<Value> {
    const ttlMs = this.getTtlMs(options.ttlMs);
    const locks = await this.acquireMany(keys, options);

    return this.runWithHeartbeat(
      ttlMs,
      locks.length === 0 ? undefined : () => this.extendMany(locks),
      (context) => handler(locks, context),
      async () => releaseHandles(locks),
      "Exclusive lock batch operation failed.",
    );
  }

  private async runWithHeartbeat<Value>(
    ttlMs: number,
    extend: (() => Promise<void>) | undefined,
    handler: (context: LockRunContext) => Awaitable<Value>,
    release: () => Promise<readonly unknown[]>,
    aggregateMessage: string,
  ): Promise<Value> {
    const controller = new AbortController();
    const heartbeat = extend === undefined
      ? undefined
      : startLeaseHeartbeat({
          intervalMs: Math.max(1, Math.floor(ttlMs / 2)),
          extend,
          onFailure: (error) => controller.abort(error),
        });
    const errors: unknown[] = [];
    let result!: Value;

    try {
      result = await handler({ signal: controller.signal });
    } catch (error) {
      errors.push(error);
    }

    if (heartbeat !== undefined) {
      try {
        await heartbeat.close();
      } catch (error) {
        errors.push(error);
      }
    }

    errors.push(...await release());

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, aggregateMessage);
    }

    return result;
  }

  private async extendMany(locks: readonly LockHandle[]): Promise<void> {
    if (this.adapter.extendMany === undefined) {
      const results = await Promise.allSettled(locks.map((lock) =>
        lock.extend()));
      const errors = rejectedReasons(results);

      if (errors.length === 1) {
        throw errors[0];
      }

      if (errors.length > 1) {
        throw new AggregateError(errors, "Lock batch extension failed.");
      }

      return;
    }

    const internalLocks = locks.map((lock) => {
      if (!(lock instanceof LockHandleImpl)) {
        throw new TypeError("LockManager received an unsupported lock handle.");
      }

      return lock;
    });
    const attempts = internalLocks.map((lock) => lock.prepareExtension());
    let leases: readonly LockLease[] | undefined;

    try {
      leases = await this.adapter.extendMany(
        attempts.map((attempt) => attempt.request),
      );
    } catch (error) {
      for (let index = 0; index < internalLocks.length; index += 1) {
        internalLocks[index]!.failExtension(attempts[index]!);
      }

      throw error;
    }

    if (leases === undefined) {
      const errors = internalLocks.map((lock, index) => {
        try {
          lock.completeExtension(attempts[index]!, undefined);
        } catch (error) {
          return error;
        }

        throw new Error("Lost lock extension unexpectedly succeeded.");
      });

      throw new AggregateError(errors, "Lock batch ownership was lost.");
    }

    try {
      validateExtensionBatch(attempts, leases);
    } catch (error) {
      for (let index = 0; index < internalLocks.length; index += 1) {
        internalLocks[index]!.failExtension(attempts[index]!);
      }

      throw error;
    }

    for (let index = 0; index < internalLocks.length; index += 1) {
      internalLocks[index]!.completeExtension(
        attempts[index]!,
        leases[index],
      );
    }
  }

  private async tryAcquireMany(
    publicKeys: readonly string[],
    ttlMs: number,
  ): Promise<readonly LockLease[] | undefined> {
    const entries = publicKeys.map((publicKey, index) => ({
      index,
      request: {
        key: this.composeKey(publicKey),
        ownerId: this.createOwnerId(),
        ttlMs,
      } satisfies LockAcquireRequest,
    })).sort((left, right) => compareKeys(
      left.request.key,
      right.request.key,
    ));
    const requests = entries.map((entry) => entry.request);

    if (this.adapter.tryAcquireMany !== undefined) {
      const leases = await this.adapter.tryAcquireMany(requests);

      if (leases === undefined) {
        return undefined;
      }

      try {
        return restoreLeaseOrder(entries, leases);
      } catch (contractError) {
        const releaseErrors = await releaseLeases(this.adapter, leases);

        throw new AggregateError(
          [contractError, ...releaseErrors],
          "Lock adapter returned an invalid acquisition batch.",
        );
      }
    }

    const acquired: LockLease[] = [];

    try {
      for (const request of requests) {
        const lease = await this.adapter.tryAcquire(request);

        if (lease === undefined) {
          const releaseErrors = await releaseLeases(this.adapter, acquired);
          acquired.length = 0;

          if (releaseErrors.length > 0) {
            throw new AggregateError(
              releaseErrors,
              "Failed to release a partially acquired lock batch.",
            );
          }

          return undefined;
        }

        acquired.push(lease);
      }
    } catch (acquisitionError) {
      const releaseErrors = await releaseLeases(this.adapter, acquired);

      if (releaseErrors.length > 0) {
        throw new AggregateError(
          [acquisitionError, ...releaseErrors],
          "Lock batch acquisition and cleanup both failed.",
        );
      }

      throw acquisitionError;
    }

    try {
      return restoreLeaseOrder(entries, acquired);
    } catch (contractError) {
      const releaseErrors = await releaseLeases(this.adapter, acquired);

      throw new AggregateError(
        [contractError, ...releaseErrors],
        "Lock adapter returned an invalid acquisition batch.",
      );
    }
  }

  private createHandle(
    publicKey: string,
    lease: LockLease,
    ttlMs: number,
    acquiredAtMs: number,
  ): LockHandle {
    return new LockHandleImpl(
      publicKey,
      lease,
      ttlMs,
      acquiredAtMs,
      this.adapter,
      (value) => this.getTtlMs(value),
      () => this.measureTime(),
      (event) => this.recordInstrumentation(event),
    );
  }

  private composeKey(key: string): string {
    return `${this.options.namespace}:${key}`;
  }

  private getTtlMs(ttlMs?: number): number {
    const effectiveTtlMs = ttlMs ?? this.options.defaultTtlMs;

    validatePositiveFinite("ttlMs", effectiveTtlMs);

    return Math.min(effectiveTtlMs, this.options.maxTtlMs);
  }

  private addJitter(delayMs: number): number {
    // Symmetric jitter prevents synchronized contenders from retrying together.
    const factor = 1 + ((this.random() * 2) - 1)
      * this.retryJitterRatio;

    return Math.max(1, delayMs * factor);
  }

  private throwIfAborted(
    key: string,
    signal?: AbortSignal,
  ): void {
    if (signal?.aborted === true) {
      throw new LockAcquisitionAbortedError(key);
    }
  }

  private throwIfBatchAborted(
    keys: readonly string[],
    signal?: AbortSignal,
  ): void {
    if (signal?.aborted === true) {
      throw new LockBatchAcquisitionAbortedError(keys);
    }
  }

  private measureTime(): number {
    if (this.instrumentation === undefined) {
      return 0;
    }

    try {
      const value = this.monotonicNow();

      return Number.isFinite(value) ? value : performance.now();
    } catch {
      // Faulty instrumentation clocks must not affect lock semantics.
      return performance.now();
    }
  }

  private recordInstrumentation(event: LockInstrumentationEvent): void {
    if (this.instrumentation === undefined) {
      return;
    }

    try {
      if (event.type === "batch-acquisition") {
        this.instrumentation.record({
          ...event,
          data: {
            ...event.data,
            keys: event.data.keys.map((key) =>
              this.formatObservationKey(key)),
          },
        });
      } else if (event.type === "acquisition") {
        const key = this.formatObservationKey(event.data.key);
        this.instrumentation.record({
          ...event,
          data: { ...event.data, key },
        });
      } else if (event.type === "extension") {
        const key = this.formatObservationKey(event.data.key);
        this.instrumentation.record({
          ...event,
          data: { ...event.data, key },
        });
      } else {
        const key = this.formatObservationKey(event.data.key);
        this.instrumentation.record({
          ...event,
          data: { ...event.data, key },
        });
      }
    } catch {
      // Observability must never change lock acquisition or ownership.
    }
  }
}

function restoreLeaseOrder(
  entries: readonly { index: number; request: LockAcquireRequest }[],
  leases: readonly LockLease[],
): readonly LockLease[] {
  if (entries.length !== leases.length) {
    throw new Error("Lock adapter returned an incomplete acquisition batch.");
  }

  const ordered: LockLease[] = new Array(leases.length);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const lease = leases[index]!;

    if (
      lease.key !== entry.request.key
      || lease.ownerId !== entry.request.ownerId
    ) {
      throw new Error("Lock adapter returned a mismatched acquisition batch.");
    }

    ordered[entry.index] = lease;
  }

  return ordered;
}

async function releaseLeases(
  adapter: LockAdapter,
  leases: readonly LockLease[],
): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(leases.map((lease) =>
    adapter.release({ key: lease.key, ownerId: lease.ownerId })));

  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
}

async function releaseHandles(
  locks: readonly LockHandle[],
): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(locks.map((lock) => lock.release()));

  return rejectedReasons(results);
}

function rejectedReasons(
  results: readonly PromiseSettledResult<unknown>[],
): readonly unknown[] {
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
}

interface PreparedLockExtension {
  request: LockExtendRequest;
  startedAt: number;
  ttlMs: number;
}

function validateExtensionBatch(
  attempts: readonly PreparedLockExtension[],
  leases: readonly LockLease[],
): void {
  if (attempts.length !== leases.length) {
    throw new Error("Lock adapter returned an incomplete extension batch.");
  }

  for (let index = 0; index < attempts.length; index += 1) {
    const request = attempts[index]!.request;
    const lease = leases[index]!;

    if (lease.key !== request.key || lease.ownerId !== request.ownerId) {
      throw new Error("Lock adapter returned a mismatched extension batch.");
    }
  }
}

/** Mutable internal implementation exposed through the readonly handle API. */
class LockHandleImpl implements LockHandle {
  private released = false;

  public constructor(
    public readonly key: string,
    private lease: LockLease,
    private ttlMs: number,
    private readonly acquiredAtMs: number,
    private readonly adapter: LockAdapter,
    private readonly normalizeTtlMs: (ttlMs?: number) => number,
    private readonly monotonicNow: () => number,
    private readonly record: (event: LockInstrumentationEvent) => void,
  ) {}

  public get expiresAt(): Date {
    return this.lease.expiresAt;
  }

  public get fencingToken(): bigint {
    return this.lease.fencingToken;
  }

  /** Extends the lease only after the store confirms continued ownership. */
  public async extend(ttlMs: number = this.ttlMs): Promise<void> {
    const attempt = this.prepareExtension(ttlMs);
    let lease: LockLease | undefined;

    try {
      lease = await this.adapter.extend(attempt.request);
    } catch (error) {
      this.failExtension(attempt);
      throw error;
    }

    this.completeExtension(attempt, lease);
  }

  /** Prepares one manager-coordinated extension without changing ownership. */
  public prepareExtension(
    ttlMs: number = this.ttlMs,
  ): PreparedLockExtension {
    const startedAt = this.monotonicNow();

    if (this.released) {
      this.record({
        type: "extension",
        outcome: "failure",
        durationMs: getDuration(startedAt, this.monotonicNow()),
        data: {
          key: this.key,
          result: "already-released",
          ttlMs,
          fencingToken: this.fencingToken.toString(),
        },
      });
      throw new LockReleasedError(this.key);
    }

    const normalizedTtlMs = this.normalizeTtlMs(ttlMs);

    return {
      request: {
        key: this.lease.key,
        ownerId: this.lease.ownerId,
        ttlMs: normalizedTtlMs,
      },
      startedAt,
      ttlMs: normalizedTtlMs,
    };
  }

  /** Applies the terminal result of a manager-coordinated extension. */
  public completeExtension(
    attempt: PreparedLockExtension,
    lease: LockLease | undefined,
  ): void {
    if (lease === undefined) {
      this.record({
        type: "extension",
        outcome: "failure",
        durationMs: getDuration(attempt.startedAt, this.monotonicNow()),
        data: {
          key: this.key,
          result: "lost",
          ttlMs: attempt.ttlMs,
          fencingToken: this.fencingToken.toString(),
        },
      });
      throw new LockLostError(this.key);
    }

    this.lease = lease;
    this.ttlMs = attempt.ttlMs;
    this.record({
      type: "extension",
      outcome: "success",
      durationMs: getDuration(attempt.startedAt, this.monotonicNow()),
      data: {
        key: this.key,
        result: "extended",
        ttlMs: attempt.ttlMs,
        fencingToken: this.fencingToken.toString(),
      },
    });
  }

  /** Records a storage failure for a manager-coordinated extension. */
  public failExtension(attempt: PreparedLockExtension): void {
    this.record({
      type: "extension",
      outcome: "failure",
      durationMs: getDuration(attempt.startedAt, this.monotonicNow()),
      data: {
        key: this.key,
        result: "error",
        ttlMs: attempt.ttlMs,
        fencingToken: this.fencingToken.toString(),
      },
    });
  }

  /** Releases at most once while preserving retryability after store errors. */
  public async release(): Promise<void> {
    const startedAt = this.monotonicNow();

    if (this.released) {
      this.record({
        type: "release",
        outcome: "success",
        durationMs: getDuration(startedAt, this.monotonicNow()),
        data: {
          key: this.key,
          result: "already-released",
          fencingToken: this.fencingToken.toString(),
          heldDurationMs: getDuration(
            this.acquiredAtMs,
            this.monotonicNow(),
          ),
        },
      });
      return;
    }

    try {
      const released = await this.adapter.release({
        key: this.lease.key,
        ownerId: this.lease.ownerId,
      });
      const completedAt = this.monotonicNow();
      this.released = true;
      this.record({
        type: "release",
        outcome: released ? "success" : "failure",
        durationMs: getDuration(startedAt, completedAt),
        data: {
          key: this.key,
          result: released ? "released" : "not-owned",
          fencingToken: this.fencingToken.toString(),
          heldDurationMs: getDuration(this.acquiredAtMs, completedAt),
        },
      });
    } catch (error) {
      const completedAt = this.monotonicNow();

      this.record({
        type: "release",
        outcome: "failure",
        durationMs: getDuration(startedAt, completedAt),
        data: {
          key: this.key,
          result: "error",
          fencingToken: this.fencingToken.toString(),
          heldDurationMs: getDuration(this.acquiredAtMs, completedAt),
        },
      });
      throw error;
    }
  }
}

async function defaultSleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await sleep(delayMs, undefined, { signal });
}

function validateManagerOptions(options: LockManagerOptions): void {
  if (options.namespace.length === 0) {
    throw new TypeError("Lock namespaces cannot be empty.");
  }

  if (options.namespace.includes(":")) {
    throw new TypeError("Lock namespaces cannot contain a colon.");
  }

  validatePositiveFinite("defaultTtlMs", options.defaultTtlMs);
  validatePositiveFinite("maxTtlMs", options.maxTtlMs);
  validateNonNegativeFinite(
    "defaultWaitTimeoutMs",
    options.defaultWaitTimeoutMs,
  );
  validatePositiveFinite("retryIntervalMs", options.retryIntervalMs);

  if (options.defaultTtlMs > options.maxTtlMs) {
    throw new TypeError("defaultTtlMs cannot exceed maxTtlMs.");
  }

  const jitter = options.retryJitterRatio ?? 0.2;

  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new TypeError("retryJitterRatio must be between 0 and 1.");
  }
}

function validateKey(key: string): string {
  if (key.length === 0) {
    throw new TypeError("Lock keys cannot be empty.");
  }

  return key;
}

function validateKeys(keys: readonly string[]): readonly string[] {
  const validated = keys.map(validateKey);

  if (new Set(validated).size !== validated.length) {
    throw new TypeError("Lock batches cannot contain duplicate keys.");
  }

  return validated;
}

function compareKeys(left: string, right: string): number {
  // Code-unit ordering is identical across processes and host locales.
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number.`);
  }
}

function validateNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number.`);
  }
}

function getDuration(startedAt: number, completedAt: number): number {
  return Math.max(0, completedAt - startedAt);
}
