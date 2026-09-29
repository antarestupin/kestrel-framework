import {
  type input,
  type output,
  type ZodType,
} from "zod";

import {
  resolveValidation,
  type DefinitionValidation,
  type InputValidationOptions,
} from "../definitions/index.js";
import type {
  DependencyDeclarations,
  ResolvedDependencies,
} from "../di/index.js";
import type {
  AggregatedResultGenerator,
  AggregatedResultOutcome,
} from "../concurrency/index.js";
import type {
  ThrottlingCost,
  ThrottlingDefinition,
  ThrottlingFeedback,
} from "../throttling/index.js";
import type { ReservedJob } from "./types.js";
import type { ActionExecution } from "../app/index.js";

/** One reusable queue payload exposed to worker tooling such as Studio. */
export interface WorkerExample<InputSchema extends ZodType> {
  name?: string;
  payload: input<InputSchema>;
}

export interface WorkerExecutionContext {
  signal: AbortSignal;
  /** Application execution shared by actions invoked from this handler. */
  execution: ActionExecution;
  /** Records the result forwarded to a correlated publisher after success. */
  setResult(result: unknown): void;
  /** Reports one invocation-wide actual cost to the declared policy. */
  reportActualCost(cost: ThrottlingCost): void;
  /** Classifies one terminal dependency failure for circuit health. */
  reportFeedback(feedback: ThrottlingFeedback): void;
}

export interface WorkerThrottlingRequirement {
  admission: ThrottlingDefinition;
  estimatedCost?: ThrottlingCost;
}

export type WorkerThrottlingBufferingOptions =
  | {
      strategy?: "defer";
      fallbackDelayMs?: number;
    }
  | {
      strategy: "hold";
      maxBlockedJobs?: number;
      maxHoldMs?: number;
      fallbackDelayMs?: number;
    }
  | {
      strategy: "release";
    };

export interface WorkerThrottlingOptions<Payload> {
  requirements(job: ReservedJob<Payload>): WorkerThrottlingRequirement;
  buffering?: WorkerThrottlingBufferingOptions;
}

export type WorkerThrottlingBuffering =
  | {
      strategy: "defer";
      fallbackDelayMs: number;
    }
  | {
      strategy: "hold";
      maxBlockedJobs?: number;
      maxHoldMs: number;
      fallbackDelayMs: number;
    }
  | {
      strategy: "release";
    };

export interface WorkerThrottling<Payload> {
  requirements(job: ReservedJob<Payload>): WorkerThrottlingRequirement;
  buffering: WorkerThrottlingBuffering;
}

export interface WorkerBatchFailureData {
  cause: unknown;
  retryDelayMs?: number;
  maxAttempts?: number;
}

export type WorkerBatchResult = AggregatedResultOutcome<
  string,
  unknown,
  WorkerBatchFailureData
>;

export type WorkerBatchSuccess = Extract<
  WorkerBatchResult,
  { status: "success" }
>;

export type WorkerBatchFailure = Extract<
  WorkerBatchResult,
  { status: "error" }
>;

type WorkerBatchResults =
  | AggregatedResultGenerator<
      string,
      unknown,
      WorkerBatchFailureData,
      unknown
    >
  | undefined
  | void;

/** Creates the generic successful outcome yielded for one batch job. */
export function jobSuccess(
  jobId: string,
  result?: unknown,
): WorkerBatchSuccess {
  return {
    key: jobId,
    status: "success",
    result,
  };
}

/** Creates the generic failed outcome yielded for one batch job. */
export function jobFail(
  jobId: string,
  failure: WorkerBatchFailureData,
): WorkerBatchFailure {
  validateRetryDelay(failure.retryDelayMs);
  validateMaxAttempts(failure.maxAttempts);

  return {
    key: jobId,
    status: "error",
    error: failure,
  };
}

interface WorkerDefinitionBase<
  InputSchema extends ZodType,
  Dependencies extends DependencyDeclarations<never>,
> {
  name: string;
  description?: string;
  queue: string;
  input: InputSchema;
  /** Omitted validation modes use synchronous parsing. */
  validation?: InputValidationOptions;
  examples?: readonly WorkerExample<InputSchema>[];
  dependencies?: Dependencies;
  weight?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  throttling?: WorkerThrottlingOptions<output<InputSchema>>;
}

export interface IndividualWorkerOptions<
  InputSchema extends ZodType,
  Dependencies extends DependencyDeclarations<never>,
> extends WorkerDefinitionBase<InputSchema, Dependencies> {
  batch?: false;
  handler: (
    job: ReservedJob<output<InputSchema>>,
    dependencies: ResolvedDependencies<Dependencies>,
    context: WorkerExecutionContext,
  ) => Promise<void> | void;
}

export interface BatchWorkerOptions<
  InputSchema extends ZodType,
  Dependencies extends DependencyDeclarations<never>,
> extends WorkerDefinitionBase<InputSchema, Dependencies> {
  batch: {
    size: number;
    allowOverflow?: boolean;
  };
  handler: (
    jobs: readonly ReservedJob<output<InputSchema>>[],
    dependencies: ResolvedDependencies<Dependencies>,
    context: WorkerExecutionContext,
  ) => Promise<WorkerBatchResults> | WorkerBatchResults;
}

export type WorkerOptions<
  InputSchema extends ZodType,
  Dependencies extends DependencyDeclarations<never>,
> =
  | BatchWorkerOptions<InputSchema, Dependencies>
  | IndividualWorkerOptions<InputSchema, Dependencies>;

/** Runtime worker contract retaining its payload and dependency declarations. */
export interface Worker<
  InputSchema extends ZodType = ZodType,
  Dependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> {
  readonly name: string;
  readonly description?: string;
  readonly queue: string;
  readonly inputSchema: InputSchema;
  readonly validation: DefinitionValidation;
  readonly examples?: readonly WorkerExample<InputSchema>[];
  readonly dependencies: Dependencies;
  readonly weight: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly throttling?: WorkerThrottling<output<InputSchema>>;
  readonly batch: false | {
    size: number;
    allowOverflow: boolean;
  };
  readonly handler: (...arguments_: any[]) => unknown;
}

/** Worker type used by runtime catalogs after generic details are erased. */
export type AnyWorker = Worker<ZodType, any>;

/** Defines a typed queue handler and its scheduling policy. */
export function defineWorker<
  InputSchema extends ZodType,
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  options: BatchWorkerOptions<InputSchema, Dependencies>,
): Worker<InputSchema, Dependencies>;

/** Defines a typed queue handler and its scheduling policy. */
export function defineWorker<
  InputSchema extends ZodType,
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  options: IndividualWorkerOptions<InputSchema, Dependencies>,
): Worker<InputSchema, Dependencies>;

export function defineWorker(
  options: WorkerOptions<ZodType, any>,
): AnyWorker {
  return createWorker(options);
}

function createWorker<
  InputSchema extends ZodType,
  Dependencies extends DependencyDeclarations<never>,
>(
  options: WorkerOptions<InputSchema, Dependencies>,
): Worker<InputSchema, Dependencies> {
  validateWorkerOptions(options);

  return {
    name: options.name,
    validation: resolveValidation(options.validation),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    queue: options.queue,
    inputSchema: options.input,
    ...(options.examples === undefined ? {} : { examples: options.examples }),
    dependencies: options.dependencies ?? ({} as Dependencies),
    weight: options.weight ?? 1,
    maxAttempts: options.maxAttempts ?? 3,
    retryDelayMs: options.retryDelayMs ?? 1_000,
    maxRetryDelayMs: options.maxRetryDelayMs ?? 60_000,
    ...(options.throttling === undefined
      ? {}
      : { throttling: createWorkerThrottling(options.throttling) }),
    batch: options.batch === undefined || options.batch === false
      ? false
      : {
          size: options.batch.size,
          allowOverflow: options.batch.allowOverflow ?? true,
        },
    handler: options.handler,
  };
}

function createWorkerThrottling<Payload>(
  options: WorkerThrottlingOptions<Payload>,
): WorkerThrottling<Payload> {
  if (typeof options.requirements !== "function") {
    throw new TypeError("Worker throttling requirements must be a function.");
  }

  const buffering = options.buffering;

  if (buffering?.strategy === "release") {
    return { requirements: options.requirements, buffering };
  }

  const fallbackDelayMs = buffering?.fallbackDelayMs ?? 1_000;
  validatePositiveFinite("fallbackDelayMs", fallbackDelayMs);

  if (buffering?.strategy === "hold") {
    const maxHoldMs = buffering.maxHoldMs ?? 30_000;
    validatePositiveFinite("maxHoldMs", maxHoldMs);

    if (
      buffering.maxBlockedJobs !== undefined
      && (!Number.isInteger(buffering.maxBlockedJobs)
        || buffering.maxBlockedJobs <= 0)
    ) {
      throw new TypeError("maxBlockedJobs must be a positive integer.");
    }

    return {
      requirements: options.requirements,
      buffering: {
        strategy: "hold",
        maxHoldMs,
        fallbackDelayMs,
        ...(buffering.maxBlockedJobs === undefined
          ? {}
          : { maxBlockedJobs: buffering.maxBlockedJobs }),
      },
    };
  }

  return {
    requirements: options.requirements,
    buffering: { strategy: "defer", fallbackDelayMs },
  };
}

function validatePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number.`);
  }
}

function validateWorkerOptions(
  options: {
    name: string;
    queue: string;
    weight?: number;
    maxAttempts?: number;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    batch?: false | { size: number };
  },
): void {
  if (options.name.length === 0) {
    throw new TypeError("Worker names cannot be empty.");
  }

  if (options.queue.length === 0) {
    throw new TypeError("Worker queue names cannot be empty.");
  }

  for (const [name, value] of [
    ["weight", options.weight ?? 1],
    ["retryDelayMs", options.retryDelayMs ?? 1_000],
    ["maxRetryDelayMs", options.maxRetryDelayMs ?? 60_000],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number.`);
    }
  }

  const maxAttempts = options.maxAttempts ?? 3;

  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new TypeError("maxAttempts must be a positive integer.");
  }

  if (
    options.batch !== undefined
    && options.batch !== false
    && (!Number.isInteger(options.batch.size) || options.batch.size <= 0)
  ) {
    throw new TypeError("Worker batch size must be a positive integer.");
  }
}

function validateRetryDelay(retryDelayMs: number | undefined): void {
  if (
    retryDelayMs !== undefined
    && (!Number.isFinite(retryDelayMs) || retryDelayMs < 0)
  ) {
    throw new TypeError(
      "Worker retry delays must be non-negative finite numbers.",
    );
  }
}

function validateMaxAttempts(maxAttempts: number | undefined): void {
  if (maxAttempts !== undefined
    && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) {
    throw new TypeError("Worker batch maxAttempts must be a positive integer.");
  }
}
