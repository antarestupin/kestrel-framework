import { BatchBuffer } from "../concurrency/index.js";
import type {
  ObservationEvent,
  ObservationRecorder,
  ObservationRecorderHealth,
} from "./observer.js";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5_000;

export type ObservationFailurePolicy = "best-effort" | "fail-fast";
export type ObservationOverflowPolicy = "drop-new";

export interface ObservationWriter {
  append(events: readonly ObservationEvent[]): Promise<void>;
}

export interface ObservationRecorderErrorContext {
  readonly attempt: number;
  readonly batchSize: number;
  readonly policy: ObservationFailurePolicy;
  readonly retryDelayMs?: number;
  readonly terminal: boolean;
}

export interface BufferedObservationRecorderOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  overflowPolicy?: ObservationOverflowPolicy;
  failurePolicy?: ObservationFailurePolicy;
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Delays the first write until storage preparation has completed. */
  ready?: Promise<void>;
  /** Reports storage failures without throwing outside an explicit boundary. */
  onError?: (
    error: unknown,
    context: ObservationRecorderErrorContext,
  ) => void;
  /** Reports the first dropped event in each continuous saturation episode. */
  onOverflow?: (health: ObservationRecorderHealth) => void;
  /** Injectable monotonic clock used by health snapshots. */
  now?: () => number;
  /** Injectable delay used by deterministic retry tests. */
  sleep?: (delayMs: number) => Promise<void>;
}

interface BufferedObservation {
  readonly event: ObservationEvent;
  readonly enqueuedAtMs: number;
}

/**
 * Buffers observations outside execution control flow and persists bounded
 * sequential batches through a storage adapter.
 */
export class BufferedObservationRecorder implements ObservationRecorder {
  private readonly buffer: BatchBuffer<BufferedObservation>;
  private readonly maxQueueSize: number;
  private readonly overflowPolicy: ObservationOverflowPolicy;
  private readonly failurePolicy: ObservationFailurePolicy;
  private readonly maxAttempts: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly ready: Promise<void>;
  private readonly onError: NonNullable<
    BufferedObservationRecorderOptions["onError"]
  >;
  private readonly onOverflow: NonNullable<
    BufferedObservationRecorderOptions["onOverflow"]
  >;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly pending = new Set<BufferedObservation>();
  private readonly timer: ReturnType<typeof setInterval>;
  private preparationFailure: { error: unknown } | undefined;
  private terminalFailure: unknown | undefined;
  private consecutiveStorageFailures = 0;
  private droppedByOverflow = 0;
  private droppedByStorageFailure = 0;
  private overflowReported = false;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  public constructor(
    private readonly writer: ObservationWriter,
    options: BufferedObservationRecorderOptions = {},
  ) {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const flushIntervalMs = options.flushIntervalMs
      ?? DEFAULT_FLUSH_INTERVAL_MS;

    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.overflowPolicy = options.overflowPolicy ?? "drop-new";
    this.failurePolicy = options.failurePolicy ?? "best-effort";
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.initialRetryDelayMs = options.initialRetryDelayMs
      ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.onError = options.onError ?? (() => undefined);
    this.onOverflow = options.onOverflow ?? (() => undefined);
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? sleep;

    validateOptions({
      batchSize,
      failurePolicy: this.failurePolicy,
      flushIntervalMs,
      initialRetryDelayMs: this.initialRetryDelayMs,
      maxAttempts: this.maxAttempts,
      maxQueueSize: this.maxQueueSize,
      maxRetryDelayMs: this.maxRetryDelayMs,
      overflowPolicy: this.overflowPolicy,
    });

    this.ready = (options.ready ?? Promise.resolve()).catch((error: unknown) => {
      // Retain initialization failures without temporarily leaving a rejected
      // Promise unhandled before the first scheduled write.
      this.preparationFailure = { error };
    });
    this.buffer = new BatchBuffer({
      maxBatchSize: batchSize,
      maxWaitMs: flushIntervalMs,
      execution: "sequential",
      handler: (batch) => this.persistBatch(batch),
    });

    // Periodic runs consume automatic BatchBuffer outcomes as well as forcing
    // the same maximum latency for values admitted near an interval boundary.
    this.timer = setInterval(() => {
      void this.drainBuffer();
    }, flushIntervalMs);

    // Observation capture alone must not keep a CLI process alive.
    this.timer.unref();
  }

  public enqueue(event: ObservationEvent): void {
    if (this.closed) {
      return;
    }

    if (this.pending.size >= this.maxQueueSize) {
      this.droppedByOverflow += 1;
      this.reportOverflow();
      return;
    }

    const buffered = { event, enqueuedAtMs: this.now() };

    // Count values until storage or an explicit terminal policy settles them.
    // BatchBuffer removes active values from its pending queue, so this outer
    // ownership is what keeps the total capacity strictly bounded.
    this.pending.add(buffered);
    this.buffer.add(buffered);
  }

  public async flush(): Promise<void> {
    await this.drainBuffer();
    this.throwTerminalFailure();
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closed = true;
    clearInterval(this.timer);
    this.closePromise = this.finishClosing();

    // Container disposal may intentionally ignore its returned Promise until
    // all owned resources are collected, so contain a temporary rejection.
    void this.closePromise.catch(() => undefined);

    return this.closePromise;
  }

  public getHealth(): ObservationRecorderHealth {
    const oldest = this.pending.values().next().value as
      | BufferedObservation
      | undefined;

    return {
      status: this.closed
        ? "closed"
        : this.consecutiveStorageFailures > 0
            || this.pending.size >= this.maxQueueSize
          ? "degraded"
          : "healthy",
      pendingCount: this.pending.size,
      droppedCount: this.droppedByOverflow + this.droppedByStorageFailure,
      droppedByOverflow: this.droppedByOverflow,
      droppedByStorageFailure: this.droppedByStorageFailure,
      consecutiveStorageFailures: this.consecutiveStorageFailures,
      ...(oldest === undefined
        ? {}
        : { oldestPendingAgeMs: Math.max(0, this.now() - oldest.enqueuedAtMs) }),
    };
  }

  private async finishClosing(): Promise<void> {
    await this.ready;

    if (this.preparationFailure !== undefined && this.pending.size === 0) {
      this.handlePreparationFailure(this.preparationFailure.error);
    }

    const result = await this.buffer.close();

    this.captureTerminalFailure(result.errors.map(({ error }) => error));
    this.throwTerminalFailure();
  }

  private async drainBuffer(): Promise<void> {
    const result = await this.buffer.run();

    this.captureTerminalFailure(result.errors.map(({ error }) => error));
  }

  private async persistBatch(
    batch: readonly BufferedObservation[],
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await this.ready;

        if (this.preparationFailure !== undefined) {
          throw this.preparationFailure.error;
        }

        await this.writer.append(batch.map(({ event }) => event));
        this.consecutiveStorageFailures = 0;
        this.settle(batch);
        return;
      } catch (error: unknown) {
        lastError = error;
        this.consecutiveStorageFailures += 1;
        const terminal = attempt === this.maxAttempts;
        const retryDelayMs = terminal
          ? undefined
          : this.getRetryDelay(attempt);

        this.reportError(error, {
          attempt,
          batchSize: batch.length,
          policy: this.failurePolicy,
          ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
          terminal,
        });

        if (retryDelayMs !== undefined) {
          await this.sleep(retryDelayMs);
        }
      }
    }

    // A bounded retry policy must release its in-memory ownership eventually.
    // The counters make this loss explicit for both named failure policies.
    this.droppedByStorageFailure += batch.length;
    this.settle(batch);

    if (this.failurePolicy === "fail-fast") {
      throw lastError;
    }
  }

  private getRetryDelay(failedAttempt: number): number {
    return Math.min(
      this.maxRetryDelayMs,
      this.initialRetryDelayMs * 2 ** Math.min(failedAttempt - 1, 52),
    );
  }

  private settle(batch: readonly BufferedObservation[]): void {
    for (const value of batch) {
      this.pending.delete(value);
    }

    if (this.pending.size < this.maxQueueSize) {
      this.overflowReported = false;
    }
  }

  private reportOverflow(): void {
    if (this.overflowReported) {
      return;
    }

    this.overflowReported = true;

    try {
      this.onOverflow(this.getHealth());
    } catch {
      // Saturation reporting cannot make observation production fail.
    }
  }

  private handlePreparationFailure(error: unknown): void {
    this.consecutiveStorageFailures += 1;
    this.reportError(error, {
      attempt: 1,
      batchSize: 0,
      policy: this.failurePolicy,
      terminal: true,
    });

    if (this.failurePolicy === "fail-fast") {
      this.terminalFailure ??= error;
    }
  }

  private reportError(
    error: unknown,
    context: ObservationRecorderErrorContext,
  ): void {
    try {
      this.onError(error, context);
    } catch {
      // A broken reporter must not replace the storage policy's outcome.
    }
  }

  private captureTerminalFailure(errors: readonly unknown[]): void {
    if (this.failurePolicy !== "fail-fast" || errors.length === 0) {
      return;
    }

    this.terminalFailure ??= errors.length === 1
      ? errors[0]
      : new AggregateError(errors, "Several observation batches failed.");
  }

  private throwTerminalFailure(): void {
    if (this.terminalFailure !== undefined) {
      const error = this.terminalFailure;

      // One explicit lifecycle boundary owns each fail-fast outcome. This
      // prevents a failed application flush and the later resource close from
      // reporting the same storage failure twice during aggregated disposal.
      this.terminalFailure = undefined;
      throw error;
    }
  }
}

interface ResolvedRecorderOptions {
  readonly batchSize: number;
  readonly failurePolicy: ObservationFailurePolicy;
  readonly flushIntervalMs: number;
  readonly initialRetryDelayMs: number;
  readonly maxAttempts: number;
  readonly maxQueueSize: number;
  readonly maxRetryDelayMs: number;
  readonly overflowPolicy: ObservationOverflowPolicy;
}

function validateOptions(options: ResolvedRecorderOptions): void {
  for (const [name, value] of [
    ["batch size", options.batchSize],
    ["flush interval", options.flushIntervalMs],
    ["maximum queue size", options.maxQueueSize],
    ["maximum attempts", options.maxAttempts],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`Observation recorder ${name} must be a positive integer.`);
    }
  }

  for (const [name, value] of [
    ["initial retry delay", options.initialRetryDelayMs],
    ["maximum retry delay", options.maxRetryDelayMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(
        `Observation recorder ${name} must be a non-negative finite number.`,
      );
    }
  }

  if (options.initialRetryDelayMs > options.maxRetryDelayMs) {
    throw new TypeError(
      "Observation recorder initial retry delay cannot exceed its maximum delay.",
    );
  }

  if (
    options.failurePolicy !== "best-effort"
    && options.failurePolicy !== "fail-fast"
  ) {
    throw new TypeError("Unsupported observation recorder failure policy.");
  }

  if (options.overflowPolicy !== "drop-new") {
    throw new TypeError("Unsupported observation recorder overflow policy.");
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);

    timer.unref?.();
  });
}
