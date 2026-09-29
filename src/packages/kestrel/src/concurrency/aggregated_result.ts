import {
  z,
  type output,
  type ZodType,
} from "zod";

export type AggregatedResultStatus = "error" | "partial" | "success";

/** One successful item retained by an aggregated operation result. */
export interface AggregatedResultItem<Key, Result> {
  readonly key: Key;
  readonly result: Result;
}

/** One failed item retained by an aggregated operation result. */
export interface AggregatedResultError<Key, Error> {
  readonly key: Key;
  readonly error: Error;
}

/** Incremental outcome accepted by aggregated result collectors. */
export type AggregatedResultOutcome<Key, Result, Error> =
  | {
      readonly key: Key;
      readonly status: "error";
      readonly error: Error;
    }
  | {
      readonly key: Key;
      readonly status: "success";
      readonly result: Result;
    };

/** Generator form that streams item outcomes and returns global result data. */
export type AggregatedResultGenerator<Key, Result, Error, Data = void> =
  | AsyncGenerator<AggregatedResultOutcome<Key, Result, Error>, Data, void>
  | Generator<AggregatedResultOutcome<Key, Result, Error>, Data, void>;

/**
 * Operation form used to construct an aggregate with either a builder or a
 * returned generator. A regular function returns the aggregate's global data.
 */
export type AggregatedResultProducer<Key, Result, Error, Data = void> = (
  builder: AggregatedResultBuilder<Key, Result, Error>,
) => AggregatedResultGenerator<Key, Result, Error, Data>
  | Data
  | PromiseLike<AggregatedResultGenerator<Key, Result, Error, Data> | Data>;

export interface RunAggregatedResultOptions<Key, Result, Error> {
  /** Processes and optionally persists each generator outcome before storage. */
  onYield?: (
    outcome: AggregatedResultOutcome<Key, Result, Error>,
  ) => PromiseLike<void> | void;
}

type NormalizedAggregatedResultData<Data> = Data extends void
  ? undefined
  : Data;

/**
 * Represents the complete outcome of a bulk operation.
 *
 * Successful results and errors are kept separately so consumers can process
 * either collection directly. The global status is always derived from them.
 */
export interface AggregatedResult<Key, Result, Error, Data = undefined> {
  readonly status: AggregatedResultStatus;
  readonly results: readonly AggregatedResultItem<Key, Result>[];
  readonly errors: readonly AggregatedResultError<Key, Error>[];
  readonly data: Data;
}

interface AggregatedResultCollections<Key, Result, Error> {
  results?: Iterable<AggregatedResultItem<Key, Result>>;
  errors?: Iterable<AggregatedResultError<Key, Error>>;
}

export type CreateAggregatedResultOptions<Key, Result, Error> =
  AggregatedResultCollections<Key, Result, Error> & {
    data?: undefined;
  };

export type CreateAggregatedResultWithDataOptions<
  Key,
  Result,
  Error,
  Data,
> = AggregatedResultCollections<Key, Result, Error> & {
  data: Data;
};

export interface AggregatedResultSchemaOptions<
  KeySchema extends ZodType,
  ResultSchema extends ZodType,
  ErrorSchema extends ZodType,
> {
  key: KeySchema;
  result: ResultSchema;
  error: ErrorSchema;
  data?: undefined;
}

export interface AggregatedResultSchemaWithDataOptions<
  KeySchema extends ZodType,
  ResultSchema extends ZodType,
  ErrorSchema extends ZodType,
  DataSchema extends ZodType,
> {
  key: KeySchema;
  result: ResultSchema;
  error: ErrorSchema;
  data: DataSchema;
}

/** Derives the global bulk status from its successful and failed counts. */
export function getAggregatedResultStatus(
  resultCount: number,
  errorCount: number,
): AggregatedResultStatus {
  if (errorCount === 0) {
    // An empty bulk operation is successful because none of its items failed.
    return "success";
  }

  return resultCount === 0 ? "error" : "partial";
}

/** Creates an immutable snapshot without global result data. */
export function createAggregatedResult<Key, Result, Error>(
  options?: CreateAggregatedResultOptions<Key, Result, Error>,
): AggregatedResult<Key, Result, Error>;

/** Creates an immutable snapshot with global result data. */
export function createAggregatedResult<Key, Result, Error, Data>(
  options: CreateAggregatedResultWithDataOptions<Key, Result, Error, Data>,
): AggregatedResult<Key, Result, Error, Data>;

export function createAggregatedResult<Key, Result, Error, Data>(
  options: CreateAggregatedResultWithDataOptions<Key, Result, Error, Data>
    | CreateAggregatedResultOptions<Key, Result, Error> = {},
): AggregatedResult<Key, Result, Error, Data | undefined> {
  // Copy both iterables so later source or builder mutations cannot alter the
  // published aggregate.
  const results = [...(options.results ?? [])];
  const errors = [...(options.errors ?? [])];

  return {
    status: getAggregatedResultStatus(results.length, errors.length),
    results,
    errors,
    data: options.data,
  };
}

/**
 * Builds aggregated results incrementally without copying on every addition.
 * Each build call returns a stable snapshot and leaves the builder reusable.
 */
export class AggregatedResultBuilder<Key, Result, Error> {
  private readonly results: AggregatedResultItem<Key, Result>[] = [];

  private readonly errors: AggregatedResultError<Key, Error>[] = [];

  public get resultCount(): number {
    return this.results.length;
  }

  public get errorCount(): number {
    return this.errors.length;
  }

  public get status(): AggregatedResultStatus {
    return getAggregatedResultStatus(this.resultCount, this.errorCount);
  }

  /** Adds one successful result. */
  public addResult(key: Key, result: Result): this {
    this.results.push({ key, result });
    return this;
  }

  /** Adds one failed result. */
  public addError(key: Key, error: Error): this {
    this.errors.push({ key, error });
    return this;
  }

  /** Adds one discriminated outcome. */
  public add(outcome: AggregatedResultOutcome<Key, Result, Error>): this {
    if (outcome.status === "success") {
      return this.addResult(outcome.key, outcome.result);
    }

    return this.addError(outcome.key, outcome.error);
  }

  /** Adds every outcome from a synchronous iterable. */
  public addAll(
    outcomes: Iterable<AggregatedResultOutcome<Key, Result, Error>>,
  ): this {
    for (const outcome of outcomes) {
      this.add(outcome);
    }

    return this;
  }

  /** Adds an existing aggregate while ignoring its global data. */
  public addAggregated(
    aggregated: AggregatedResult<Key, Result, Error, unknown>,
  ): this {
    // Append iteratively so very large bulks do not hit the engine's function
    // argument limit through Array.push(...items).
    for (const result of aggregated.results) {
      this.results.push(result);
    }

    for (const error of aggregated.errors) {
      this.errors.push(error);
    }

    return this;
  }

  /** Creates a stable result snapshot without global data. */
  public build(): AggregatedResult<Key, Result, Error>;

  /** Creates a stable result snapshot with global data. */
  public build<Data>(data: Data): AggregatedResult<Key, Result, Error, Data>;

  public build<Data>(
    data?: Data,
  ): AggregatedResult<Key, Result, Error, Data | undefined> {
    return createAggregatedResult({
      results: this.results,
      errors: this.errors,
      data,
    });
  }
}

/**
 * Runs a regular function or generator and constructs its aggregate.
 *
 * Regular functions add item outcomes through the supplied builder. Generator
 * yields add item outcomes, while its final return value becomes global data.
 */
export async function runAggregatedResult<
  Key,
  Result,
  Error,
  Data = void,
>(
  producer: AggregatedResultProducer<Key, Result, Error, Data>,
  options: RunAggregatedResultOptions<Key, Result, Error> = {},
): Promise<AggregatedResult<
  Key,
  Result,
  Error,
  NormalizedAggregatedResultData<Data>
>> {
  const builder = new AggregatedResultBuilder<Key, Result, Error>();
  const produced = await producer(builder);

  if (!isAggregatedResultGenerator(produced)) {
    return builder.build(
      produced as NormalizedAggregatedResultData<Data>,
    );
  }

  // Iterate manually because for-await-of discards a generator's return value.
  try {
    let step = await produced.next();

    while (!step.done) {
      await options.onYield?.(step.value);
      builder.add(step.value);
      step = await produced.next();
    }

    return builder.build(
      step.value as NormalizedAggregatedResultData<Data>,
    );
  } catch (error) {
    // Close a suspended generator when the yield callback fails so its finally
    // blocks run before the original processing error is propagated.
    try {
      await produced.return?.(undefined as Data);
    } catch {
      // Iterator cleanup must not replace the yield or callback failure.
    }
    throw error;
  }
}

/** Collects synchronous or asynchronous outcomes into one aggregate. */
export function collectAggregatedResult<Key, Result, Error>(
  outcomes: AsyncIterable<AggregatedResultOutcome<Key, Result, Error>>
    | Iterable<AggregatedResultOutcome<Key, Result, Error>>,
): Promise<AggregatedResult<Key, Result, Error>>;

/** Collects outcomes and attaches global data to the completed aggregate. */
export function collectAggregatedResult<Key, Result, Error, Data>(
  outcomes: AsyncIterable<AggregatedResultOutcome<Key, Result, Error>>
    | Iterable<AggregatedResultOutcome<Key, Result, Error>>,
  data: Data,
): Promise<AggregatedResult<Key, Result, Error, Data>>;

export async function collectAggregatedResult<Key, Result, Error, Data>(
  outcomes: AsyncIterable<AggregatedResultOutcome<Key, Result, Error>>
    | Iterable<AggregatedResultOutcome<Key, Result, Error>>,
  data?: Data,
): Promise<AggregatedResult<Key, Result, Error, Data | undefined>> {
  const builder = new AggregatedResultBuilder<Key, Result, Error>();

  for await (const outcome of outcomes) {
    builder.add(outcome);
  }

  return builder.build(data);
}

/** Merges several aggregate snapshots and replaces their global data. */
export function mergeAggregatedResults<Key, Result, Error>(
  aggregatedResults: Iterable<AggregatedResult<Key, Result, Error, unknown>>,
): AggregatedResult<Key, Result, Error>;

/** Merges several aggregate snapshots and sets new global data. */
export function mergeAggregatedResults<Key, Result, Error, Data>(
  aggregatedResults: Iterable<AggregatedResult<Key, Result, Error, unknown>>,
  data: Data,
): AggregatedResult<Key, Result, Error, Data>;

export function mergeAggregatedResults<Key, Result, Error, Data>(
  aggregatedResults: Iterable<AggregatedResult<Key, Result, Error, unknown>>,
  data?: Data,
): AggregatedResult<Key, Result, Error, Data | undefined> {
  const builder = new AggregatedResultBuilder<Key, Result, Error>();

  for (const aggregated of aggregatedResults) {
    builder.addAggregated(aggregated);
  }

  return builder.build(data);
}

/** Creates a Zod schema that validates an aggregate and its derived status. */
export function createAggregatedResultSchema<
  KeySchema extends ZodType,
  ResultSchema extends ZodType,
  ErrorSchema extends ZodType,
>(
  options: AggregatedResultSchemaOptions<
    KeySchema,
    ResultSchema,
    ErrorSchema
  >,
): ZodType<AggregatedResult<
  output<KeySchema>,
  output<ResultSchema>,
  output<ErrorSchema>
>>;

/** Creates a Zod aggregate schema containing typed global data. */
export function createAggregatedResultSchema<
  KeySchema extends ZodType,
  ResultSchema extends ZodType,
  ErrorSchema extends ZodType,
  DataSchema extends ZodType,
>(
  options: AggregatedResultSchemaWithDataOptions<
    KeySchema,
    ResultSchema,
    ErrorSchema,
    DataSchema
  >,
): ZodType<AggregatedResult<
  output<KeySchema>,
  output<ResultSchema>,
  output<ErrorSchema>,
  output<DataSchema>
>>;

export function createAggregatedResultSchema(
  options: {
    key: ZodType;
    result: ZodType;
    error: ZodType;
    data?: ZodType | undefined;
  },
): ZodType<AggregatedResult<any, any, any, any>> {
  const schema = z.object({
    status: z.enum(["error", "partial", "success"]),
    results: z.array(z.object({
      key: options.key,
      result: options.result,
    })),
    errors: z.array(z.object({
      key: options.key,
      error: options.error,
    })),
    data: options.data ?? z.undefined(),
  });

  return schema.superRefine((aggregated, context) => {
    const expectedStatus = getAggregatedResultStatus(
      aggregated.results.length,
      aggregated.errors.length,
    );

    if (aggregated.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Expected status \"${expectedStatus}\" from the aggregated results.`,
      });
    }
  });
}

function isAggregatedResultGenerator<Key, Result, Error, Data>(
  value: AggregatedResultGenerator<Key, Result, Error, Data> | Data,
): value is AggregatedResultGenerator<Key, Result, Error, Data> {
  return typeof value === "object"
    && value !== null
    && "next" in value
    && typeof value.next === "function";
}
