import type {
  input,
  output,
  ZodType,
} from "zod";

import { parseSchema } from "../definitions/index.js";
import type { Action } from "../actions/index.js";
import type { AnyWorkflowSignal, WorkflowSignalPayload } from "./signal.js";
import type { WorkflowPayload, WorkflowPayloadCodec } from "./serialization.js";
import type { WorkflowReplayContext } from "./replayer.js";
import type { AnyWorkflow, WorkflowInput, WorkflowResult } from "./workflow.js";
import { WorkflowCancellationError } from "./errors.js";
import { resolveWorkflowConcurrency } from "./concurrency.js";

export interface WorkflowDuration {
  days?: number;
  hours?: number;
  milliseconds?: number;
  minutes?: number;
  seconds?: number;
}

export interface WorkflowRetryPolicy {
  maxAttempts?: number;
  initialDelay?: WorkflowDuration;
  backoffCoefficient?: number;
  maxDelay?: WorkflowDuration;
}

export interface WorkflowActivityOptions {
  label?: string;
  retry?: WorkflowRetryPolicy;
  scheduleToCloseTimeout?: WorkflowDuration;
  startToCloseTimeout?: WorkflowDuration;
}

export interface WorkflowSignalWaitOptions {
  timeout?: WorkflowDuration;
}

export interface WorkflowChildOptions {
  executionId?: string;
}

export interface WorkflowSideEffectOptions {
  label?: string;
}

/** Public deterministic orchestration API supplied to workflow handlers. */
export interface WorkflowExecutionContext<
  Signals extends readonly AnyWorkflowSignal[] = readonly AnyWorkflowSignal[],
  Input = WorkflowPayload,
> {
  readonly executionId: string;
  readonly version: number;
  readonly generation: number;
  run<
    InputSchema extends ZodType,
    OutputSchema extends ZodType,
  >(
    action: Action<InputSchema, OutputSchema, any>,
    input: input<InputSchema>,
    options?: WorkflowActivityOptions,
  ): Promise<output<OutputSchema>>;
  sleep(duration: WorkflowDuration): Promise<void>;
  waitForSignal<Signal extends Signals[number]>(
    signal: Signal,
    options?: WorkflowSignalWaitOptions,
  ): Promise<WorkflowSignalPayload<Signal>>;
  runChild<Definition extends AnyWorkflow>(
    workflow: Definition,
    input: WorkflowInput<Definition>,
    options?: WorkflowChildOptions,
  ): Promise<WorkflowResult<Definition>>;
  sideEffect<Value>(
    capture: () => Value,
    options?: WorkflowSideEffectOptions,
  ): Promise<Value>;
  now(): Promise<number>;
  uuid(): Promise<string>;
  /** Starts a fresh history generation for the same logical execution. */
  continueAsNew(input: Input): Promise<never>;
}

interface DurableCommandOptions {
  cancellationRequested: boolean;
  codec: WorkflowPayloadCodec;
  createUuid: () => string;
  now: () => number;
  signals: readonly AnyWorkflowSignal[];
}

/** Bridges typed public primitives to the storage-neutral replay command API. */
export class DurableWorkflowExecutionContext<
  Signals extends readonly AnyWorkflowSignal[],
  Input = WorkflowPayload,
> implements WorkflowExecutionContext<Signals, Input> {
  public readonly executionId: string;

  public readonly version: number;

  public readonly generation: number;

  private continuedInput: WorkflowPayload | undefined;

  private cancellationDelivered = false;

  /** Lets the scheduler distinguish a swallowed cancellation from no boundary. */
  public get cancellationWasDelivered(): boolean {
    return this.cancellationDelivered;
  }

  /** Internal scheduler seam; the request remains visible if user code catches. */
  public get continueAsNewInput(): WorkflowPayload | undefined {
    return this.continuedInput;
  }

  public constructor(
    private readonly replay: WorkflowReplayContext,
    private readonly options: DurableCommandOptions,
  ) {
    this.executionId = replay.executionId;
    this.version = replay.version;
    this.generation = replay.generation;
  }

  public async run<
    InputSchema extends ZodType,
    OutputSchema extends ZodType,
  >(
    action: Action<InputSchema, OutputSchema, any>,
    rawInput: input<InputSchema>,
    options: WorkflowActivityOptions = {},
  ): Promise<output<OutputSchema>> {
    const input = await parseSchema(
      action.inputSchema,
      rawInput,
      action.validation.input,
    );
    const payload = {
      input: await this.options.codec.encode(input),
      options: normalizeActivityOptions(options),
    } as const;
    const result = await this.replay.command(
      "activity",
      action.name,
      payload,
      this.takeCancellation(),
    );
    const decoded = result === undefined
      ? undefined
      : await this.options.codec.decode(result);
    return parseSchema(action.outputSchema, decoded, action.validation.output);
  }

  public async sleep(duration: WorkflowDuration): Promise<void> {
    const durationMs = workflowDurationToMilliseconds(duration);
    await this.replay.command(
      "timer",
      "sleep",
      { durationMs },
      this.takeCancellation(),
    );
  }

  public async waitForSignal<Signal extends Signals[number]>(
    signal: Signal,
    options: WorkflowSignalWaitOptions = {},
  ): Promise<WorkflowSignalPayload<Signal>> {
    if (!this.options.signals.includes(signal)) {
      throw new TypeError(
        `Signal "${signal.name}" is not declared by workflow execution "${this.executionId}".`,
      );
    }

    const timeoutMs = options.timeout === undefined
      ? undefined
      : workflowDurationToMilliseconds(options.timeout);
    const result = await this.replay.command(
      "signal",
      signal.name,
      timeoutMs === undefined ? {} : { timeoutMs },
      this.takeCancellation(),
    );
    const decoded = result === undefined
      ? undefined
      : await this.options.codec.decode(result);
    return await parseSchema(
      signal.payloadSchema,
      decoded,
      signal.validation.input,
    ) as WorkflowSignalPayload<Signal>;
  }

  public async runChild<Definition extends AnyWorkflow>(
    workflow: Definition,
    rawInput: WorkflowInput<Definition>,
    options: WorkflowChildOptions = {},
  ): Promise<WorkflowResult<Definition>> {
    const input = await parseSchema(
      workflow.inputSchema,
      rawInput,
      workflow.validation.input,
    );
    const concurrency = resolveWorkflowConcurrency(workflow.concurrency, input);
    const result = await this.replay.command(
      "child",
      workflow.name,
      {
        input: await this.options.codec.encode(input),
        version: workflow.version.current,
        ...(concurrency === undefined
          ? {}
          : { concurrency: concurrency as unknown as WorkflowPayload }),
        ...(options.executionId === undefined
          ? {}
          : { executionId: options.executionId }),
      },
      this.takeCancellation(),
    );

    if (workflow.outputSchema === undefined) {
      return undefined as WorkflowResult<Definition>;
    }

    const decoded = result === undefined
      ? undefined
      : await this.options.codec.decode(result);
    return await parseSchema(
      workflow.outputSchema,
      decoded,
      workflow.validation.output,
    ) as WorkflowResult<Definition>;
  }

  public async sideEffect<Value>(
    capture: () => Value,
    options: WorkflowSideEffectOptions = {},
  ): Promise<Value> {
    const result = await this.replay.capture(
      options.label ?? "side-effect",
      async () => this.options.codec.encode(capture()),
      this.takeCancellation(),
    );
    return await this.options.codec.decode(result) as Value;
  }

  public now(): Promise<number> {
    return this.sideEffect(this.options.now, { label: "now" });
  }

  public uuid(): Promise<string> {
    return this.sideEffect(this.options.createUuid, { label: "uuid" });
  }

  public async continueAsNew(input: Input): Promise<never> {
    const cancellation = this.takeCancellation();
    if (cancellation !== undefined) throw cancellation;
    if (this.continuedInput !== undefined) {
      throw new TypeError("A workflow activation can continue as new only once.");
    }
    this.continuedInput = await this.options.codec.encode(input);
    throw new WorkflowContinueAsNewInterrupt();
  }

  private takeCancellation(): WorkflowCancellationError | undefined {
    if (
      this.options.cancellationRequested
      && !this.cancellationDelivered
      && this.replay.canDeliverCancellation
    ) {
      this.cancellationDelivered = true;
      return new WorkflowCancellationError(this.executionId);
    }

    return undefined;
  }
}

/** Internal control flow; the scheduler reads the request from the context. */
class WorkflowContinueAsNewInterrupt extends Error {
  public constructor() {
    super("Workflow requested continue-as-new.");
    this.name = "WorkflowContinueAsNewInterrupt";
  }
}

export function workflowDurationToMilliseconds(
  duration: WorkflowDuration,
): number {
  const milliseconds = (duration.milliseconds ?? 0)
    + (duration.seconds ?? 0) * 1_000
    + (duration.minutes ?? 0) * 60_000
    + (duration.hours ?? 0) * 3_600_000
    + (duration.days ?? 0) * 86_400_000;

  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError("Workflow durations must resolve to safe non-negative milliseconds.");
  }

  return milliseconds;
}

function normalizeActivityOptions(options: WorkflowActivityOptions) {
  const maxAttempts = options.retry?.maxAttempts ?? 1;
  const backoffCoefficient = options.retry?.backoffCoefficient ?? 2;

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("Workflow activity maxAttempts must be positive.");
  }

  if (!Number.isFinite(backoffCoefficient) || backoffCoefficient < 1) {
    throw new TypeError("Workflow activity backoffCoefficient must be at least one.");
  }

  return {
    maxAttempts,
    initialDelayMs: workflowDurationToMilliseconds(
      options.retry?.initialDelay ?? { seconds: 1 },
    ),
    backoffCoefficient,
    ...(options.retry?.maxDelay === undefined
      ? {}
      : { maxDelayMs: workflowDurationToMilliseconds(options.retry.maxDelay) }),
    ...(options.scheduleToCloseTimeout === undefined
      ? {}
      : {
          scheduleToCloseTimeoutMs: workflowDurationToMilliseconds(
            options.scheduleToCloseTimeout,
          ),
        }),
    ...(options.startToCloseTimeout === undefined
      ? {}
      : {
          startToCloseTimeoutMs: workflowDurationToMilliseconds(
            options.startToCloseTimeout,
          ),
        }),
    ...(options.label === undefined ? {} : { label: options.label }),
  };
}
