import {
  AggregatedResultBuilder,
  type AggregatedResult,
  type AggregatedResultOutcome,
} from "./aggregated_result.js";

export type BatchBufferExecution = "parallel" | "sequential";

export type BatchBufferHandler<Value, Result> = (
  batch: readonly Value[],
) => PromiseLike<Result> | Result;

export interface BatchBufferOptions<Value, Result> {
  /** Maximum number of values passed to one handler invocation. */
  maxBatchSize: number;
  /** Maximum time the first value of an incomplete batch waits. */
  maxWaitMs: number;
  /** Controls whether ready batches may execute concurrently. */
  execution: BatchBufferExecution;
  handler: BatchBufferHandler<Value, Result>;
}

export type BatchBufferResult<Value, Result> = AggregatedResult<
  readonly Value[],
  Result,
  unknown
>;

type BatchOutcome<Value, Result> = AggregatedResultOutcome<
  readonly Value[],
  Result,
  unknown
>;

interface BufferedValue<Value> {
  readonly value: Value;
  readonly addedAt: number;
  readonly completion: PromiseWithResolvers<unknown> | undefined;
}

interface CompletedBatch<Value, Result> {
  readonly sequence: number;
  readonly outcome: BatchOutcome<Value, Result>;
}

/** Raised when a value is added after its batch buffer starts closing. */
export class BatchBufferClosedError extends Error {
  public constructor() {
    super("Cannot add a value to a closed batch buffer.");
    this.name = "BatchBufferClosedError";
  }
}

/** Raised when an aggregated batch result has no outcome for an awaited value. */
export class BatchBufferResultNotFoundError extends Error {
  public constructor() {
    super("The batch handler returned no outcome for an awaited value.");
    this.name = "BatchBufferResultNotFoundError";
  }
}

/**
 * Collects in-memory values and processes bounded batches by size, age or an
 * explicit run boundary.
 */
export class BatchBuffer<Value, Result = void> {
  private readonly pending: BufferedValue<Value>[] = [];

  private readonly activeBatches = new Set<Promise<void>>();

  private readonly completedBatches: CompletedBatch<Value, Result>[] = [];

  private timer: ReturnType<typeof setTimeout> | undefined;

  private sequentialTail: Promise<void> = Promise.resolve();

  private nextSequence = 0;

  private runPromise: Promise<BatchBufferResult<Value, Result>> | undefined;

  private closePromise: Promise<BatchBufferResult<Value, Result>> | undefined;

  private closed = false;

  public constructor(
    private readonly options: BatchBufferOptions<Value, Result>,
  ) {
    validateOptions(options);
  }

  /** Number of values waiting to be assigned to a handler invocation. */
  public get pendingCount(): number {
    return this.pending.length;
  }

  /** Number of running or sequentially queued handler invocations. */
  public get activeBatchCount(): number {
    return this.activeBatches.size;
  }

  /** Adds one value and starts every batch completed by the size boundary. */
  public add(value: Value): void {
    this.addBufferedValue(value);
  }

  /**
   * Adds one value and waits for its outcome in the aggregated batch result.
   * The handler aggregate must use the exact buffered values as its keys.
   */
  public addAndWait<ItemResult, Error>(
    this: BatchBuffer<
      Value,
      AggregatedResult<Value, ItemResult, Error, unknown>
    >,
    value: Value,
  ): Promise<ItemResult> {
    const completion = Promise.withResolvers<unknown>();
    this.addBufferedValue(value, completion);

    return completion.promise as Promise<ItemResult>;
  }

  private addBufferedValue(
    value: Value,
    completion?: PromiseWithResolvers<unknown>,
  ): void {
    if (this.closed) {
      throw new BatchBufferClosedError();
    }

    this.pending.push({ value, addedAt: performance.now(), completion });
    this.startFullBatches();
    this.scheduleIncompleteBatch();
  }

  /**
   * Starts the incomplete batch and waits until the buffer becomes quiescent.
   *
   * Outcomes completed since the previous run boundary are consumed once and
   * returned in batch admission order, independently from completion order.
   */
  public run(): Promise<BatchBufferResult<Value, Result>> {
    if (this.runPromise !== undefined) {
      return this.runPromise;
    }

    const promise = this.drain().finally(() => {
      if (this.runPromise === promise) {
        this.runPromise = undefined;
      }
    });
    this.runPromise = promise;

    return promise;
  }

  /** Prevents new values, drains the buffer and shares one terminal result. */
  public close(): Promise<BatchBufferResult<Value, Result>> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    // Close admission synchronously so no value can enter after the terminal
    // run boundary has started.
    this.closed = true;
    this.closePromise = this.run();

    return this.closePromise;
  }

  private async drain(): Promise<BatchBufferResult<Value, Result>> {
    while (this.pending.length > 0 || this.activeBatches.size > 0) {
      this.clearTimer();
      this.startIncompleteBatch();

      // Work admitted by handlers or other callers before this snapshot
      // settles is discovered by the next loop iteration.
      await Promise.all([...this.activeBatches]);
    }

    const completed = this.completedBatches
      .splice(0)
      .sort((left, right) => left.sequence - right.sequence);
    const builder = new AggregatedResultBuilder<
      readonly Value[],
      Result,
      unknown
    >();

    for (const batch of completed) {
      builder.add(batch.outcome);
    }

    return builder.build();
  }

  private startFullBatches(): void {
    while (this.pending.length >= this.options.maxBatchSize) {
      this.startBatch(this.takeBatch(this.options.maxBatchSize));
    }
  }

  private startIncompleteBatch(): void {
    if (this.pending.length === 0) {
      return;
    }

    this.startBatch(this.takeBatch(this.options.maxBatchSize));
  }

  private takeBatch(size: number): readonly BufferedValue<Value>[] {
    return this.pending.splice(0, size);
  }

  private startBatch(entries: readonly BufferedValue<Value>[]): void {
    this.clearTimer();
    const sequence = this.nextSequence++;
    const batch = entries.map((entry) => entry.value);
    const execute = async (): Promise<void> => {
      try {
        const result = await this.options.handler(batch);
        this.completedBatches.push({
          sequence,
          outcome: { key: batch, status: "success", result },
        });
        this.settleAwaitedValues(entries, result);
      } catch (error: unknown) {
        this.completedBatches.push({
          sequence,
          outcome: { key: batch, status: "error", error },
        });
        for (const entry of entries) {
          entry.completion?.reject(error);
        }
      }
    };

    const promise = this.options.execution === "sequential"
      ? this.sequentialTail.then(execute)
      : Promise.resolve().then(execute);

    if (this.options.execution === "sequential") {
      // Handlers are contained by execute(), so one failure never prevents the
      // next sequential batch from starting.
      this.sequentialTail = promise;
    }

    this.activeBatches.add(promise);
    void promise.finally(() => {
      this.activeBatches.delete(promise);
    });
  }

  private settleAwaitedValues(
    entries: readonly BufferedValue<Value>[],
    result: Result,
  ): void {
    if (!entries.some((entry) => entry.completion !== undefined)) {
      return;
    }

    // addAndWait() constrains the handler result to an aggregate keyed by the
    // buffered value, while regular add() keeps accepting any handler result.
    const aggregated = result as AggregatedResult<
      Value,
      unknown,
      unknown,
      unknown
    >;
    const outcomes = new Map<
      Value,
      AggregatedResultOutcome<Value, unknown, unknown>[]
    >();

    for (const item of aggregated.results) {
      addMappedOutcome(outcomes, {
        key: item.key,
        status: "success",
        result: item.result,
      });
    }

    for (const item of aggregated.errors) {
      addMappedOutcome(outcomes, {
        key: item.key,
        status: "error",
        error: item.error,
      });
    }

    for (const entry of entries) {
      // Outcome queues preserve one-to-one matching when equal values occur
      // more than once in the same batch.
      const outcome = outcomes.get(entry.value)?.shift();

      if (entry.completion === undefined) {
        continue;
      } else if (outcome === undefined) {
        entry.completion.reject(new BatchBufferResultNotFoundError());
      } else if (outcome.status === "success") {
        entry.completion.resolve(outcome.result);
      } else {
        entry.completion.reject(outcome.error);
      }
    }
  }

  private scheduleIncompleteBatch(): void {
    if (this.pending.length === 0 || this.timer !== undefined) {
      return;
    }

    const first = this.pending[0];

    if (first === undefined) {
      return;
    }

    const remainingMs = Math.max(
      0,
      this.options.maxWaitMs - (performance.now() - first.addedAt),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startIncompleteBatch();
    }, remainingMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function addMappedOutcome<Value>(
  outcomes: Map<
    Value,
    AggregatedResultOutcome<Value, unknown, unknown>[]
  >,
  outcome: AggregatedResultOutcome<Value, unknown, unknown>,
): void {
  const mapped = outcomes.get(outcome.key);

  if (mapped === undefined) {
    outcomes.set(outcome.key, [outcome]);
  } else {
    mapped.push(outcome);
  }
}

function validateOptions<Value, Result>(
  options: BatchBufferOptions<Value, Result>,
): void {
  if (!Number.isInteger(options.maxBatchSize) || options.maxBatchSize <= 0) {
    throw new TypeError("Batch buffer size must be a positive integer.");
  }

  if (!Number.isFinite(options.maxWaitMs) || options.maxWaitMs < 0) {
    throw new TypeError("Batch buffer wait must be a non-negative finite number.");
  }

  if (options.execution !== "parallel" && options.execution !== "sequential") {
    throw new TypeError(
      'Batch buffer execution must be either "parallel" or "sequential".',
    );
  }
}
