import type {
  input,
  ZodType,
} from "zod";

import { createUuid } from "../utils/uuid.js";
import { parseSchema } from "../definitions/index.js";
import type {
  WorkflowAdapter,
  WorkflowExecution,
  WorkflowSignalReceipt,
} from "./adapter.js";
import {
  WorkflowExecutionCancelledError,
  WorkflowExecutionConflictError,
  WorkflowExecutionFailedError,
  WorkflowExecutionNotFoundError,
  WorkflowExecutionTerminatedError,
  WorkflowExecutionVersionUnsupportedError,
} from "./errors.js";
import type {
  AnyWorkflowSignal,
  WorkflowSignalInput,
} from "./signal.js";
import {
  jsonWorkflowPayloadCodec,
  type WorkflowPayloadCodec,
} from "./serialization.js";
import type {
  AnyWorkflow,
  Workflow,
  WorkflowInput,
  WorkflowResult,
  WorkflowSignals,
} from "./workflow.js";
import { resolveWorkflowConcurrency } from "./concurrency.js";
import type { WorkflowInstrumentation } from "./observations.js";

export interface WorkflowClientOptions {
  createExecutionId?: () => string;
  payloadCodec?: WorkflowPayloadCodec;
  instrumentation?: WorkflowInstrumentation;
  /** Bounds validation work and adapter statement size for one atomic start. */
  maxStartBatchSize?: number;
}

export interface StartWorkflowOptions {
  /** Stable idempotency key; generated when omitted. */
  executionId?: string;
}

export interface StartWorkflowRequest<Definition extends AnyWorkflow = AnyWorkflow> {
  workflow: Definition;
  input: WorkflowInput<Definition>;
  options?: StartWorkflowOptions;
}

export type StartedWorkflowHandles<
  Requests extends readonly StartWorkflowRequest[],
> = {
  readonly [Index in keyof Requests]: Requests[Index] extends
    StartWorkflowRequest<infer Definition>
      ? WorkflowHandle<Definition>
      : never;
};

export interface SendWorkflowSignalOptions {
  /** Deduplicates repeated delivery attempts for this execution. */
  idempotencyKey?: string;
}

/** Typed reference used to inspect, signal, and await one execution. */
export class WorkflowHandle<Definition extends AnyWorkflow> {
  public constructor(
    private readonly client: WorkflowClient,
    public readonly workflow: Definition,
    public readonly executionId: string,
  ) {}

  public status(): Promise<WorkflowExecution> {
    return this.client.getExecution(this.workflow, this.executionId);
  }

  public result(): Promise<WorkflowResult<Definition>> {
    return this.client.getResult(this.workflow, this.executionId);
  }

  public signal<Signal extends WorkflowSignals<Definition>>(
    signal: Signal,
    payload: WorkflowSignalInput<Signal>,
    options: SendWorkflowSignalOptions = {},
  ): Promise<WorkflowSignalReceipt> {
    return this.client.signal(
      this.workflow,
      this.executionId,
      signal,
      payload,
      options,
    );
  }

  public cancel(): Promise<boolean> {
    return this.client.cancel(this.workflow, this.executionId);
  }
}

/** Validates typed workflow interactions before crossing the storage boundary. */
export class WorkflowClient {
  private readonly createExecutionId: () => string;

  private readonly payloadCodec: WorkflowPayloadCodec;

  private readonly instrumentation: WorkflowInstrumentation | undefined;

  private readonly maxStartBatchSize: number;

  public constructor(
    private readonly adapter: WorkflowAdapter,
    options: WorkflowClientOptions = {},
  ) {
    this.createExecutionId = options.createExecutionId ?? createUuid;
    this.payloadCodec = options.payloadCodec ?? jsonWorkflowPayloadCodec;
    this.instrumentation = options.instrumentation;
    this.maxStartBatchSize = options.maxStartBatchSize ?? 100;

    if (
      !Number.isSafeInteger(this.maxStartBatchSize)
      || this.maxStartBatchSize < 1
    ) {
      throw new TypeError("Workflow start batch size must be a positive integer.");
    }
  }

  public async start<
    InputSchema extends ZodType,
    OutputSchema extends ZodType | undefined,
    const Signals extends readonly AnyWorkflowSignal[],
  >(
    workflow: Workflow<InputSchema, OutputSchema, Signals>,
    rawInput: input<InputSchema>,
    options: StartWorkflowOptions = {},
  ): Promise<WorkflowHandle<Workflow<InputSchema, OutputSchema, Signals>>> {
    const [handle] = await this.startMany([{
      workflow,
      input: rawInput,
      options,
    }]);
    return handle as unknown as WorkflowHandle<
      Workflow<InputSchema, OutputSchema, Signals>
    >;
  }

  /** Validates and atomically starts an ordered heterogeneous workflow batch. */
  public async startMany<
    const Requests extends readonly StartWorkflowRequest[],
  >(requests: Requests): Promise<StartedWorkflowHandles<Requests>> {
    if (requests.length > this.maxStartBatchSize) {
      throw new RangeError(
        `Workflow start batch contains ${requests.length} requests; the configured maximum is ${this.maxStartBatchSize}.`,
      );
    }

    const prepared = await Promise.all(requests.map(async (request) => {
      const executionId = request.options?.executionId ?? this.createExecutionId();
      const parsedInput = await parseSchema(
        request.workflow.inputSchema,
        request.input,
        request.workflow.validation.input,
      );
      const inputPayload = await this.payloadCodec.encode(parsedInput);
      const concurrency = resolveWorkflowConcurrency(
        request.workflow.concurrency,
        parsedInput,
      );

      return {
        workflow: request.workflow,
        adapterRequest: {
          executionId,
          workflowName: request.workflow.name,
          workflowVersion: request.workflow.version.current,
          input: inputPayload,
          ...(concurrency === undefined ? {} : { concurrency }),
        },
      };
    }));
    const results = await this.adapter.startMany(
      prepared.map(({ adapterRequest }) => adapterRequest),
    );

    if (results.length !== prepared.length) {
      throw new Error("Workflow adapter returned an incomplete start batch.");
    }

    const handles = results.map(({ execution, created }, index) => {
      const workflow = prepared[index]!.workflow;

      try {
        if (created) this.instrumentation?.record({
          type: "lifecycle",
          outcome: "success",
          data: {
            executionId: execution.executionId,
            workflowName: execution.workflowName,
            workflowVersion: execution.workflowVersion,
            historyGeneration: execution.historyGeneration,
            operation: "start",
            status: execution.status,
          },
        });
      } catch {
        // Observability must never change durable start semantics.
      }

      assertExecutionMatches(workflow, execution);
      return new WorkflowHandle(this, workflow, execution.executionId);
    });

    return handles as StartedWorkflowHandles<Requests>;
  }

  public async getHandle<Definition extends AnyWorkflow>(
    workflow: Definition,
    executionId: string,
  ): Promise<WorkflowHandle<Definition>> {
    await this.getExecution(workflow, executionId);
    return new WorkflowHandle(this, workflow, executionId);
  }

  public async getExecution(
    workflow: AnyWorkflow,
    executionId: string,
  ): Promise<WorkflowExecution> {
    const execution = await this.adapter.get(executionId);

    if (execution === undefined) {
      throw new WorkflowExecutionNotFoundError(executionId);
    }

    assertExecutionMatches(workflow, execution);
    return execution;
  }

  public async getResult<Definition extends AnyWorkflow>(
    workflow: Definition,
    executionId: string,
  ): Promise<WorkflowResult<Definition>> {
    // Validate attachment before entering a potentially long terminal wait.
    await this.getExecution(workflow, executionId);
    const execution = await this.adapter.waitForTerminal(executionId);
    assertExecutionMatches(workflow, execution);

    if (execution.status === "failed") {
      throw new WorkflowExecutionFailedError(
        executionId,
        execution.error ?? {
          name: "Error",
          message: "Workflow failed without durable error metadata.",
        },
      );
    }

    if (execution.status === "cancelled") {
      throw new WorkflowExecutionCancelledError(executionId);
    }

    if (execution.status === "terminated") {
      throw new WorkflowExecutionTerminatedError(
        executionId,
        execution.error?.message ?? "Terminated by an operator.",
      );
    }

    if (execution.status !== "completed") {
      throw new Error(
        `Workflow adapter returned non-terminal status "${execution.status}" while waiting for "${executionId}".`,
      );
    }

    if (workflow.outputSchema === undefined) {
      return undefined as WorkflowResult<Definition>;
    }

    const decodedOutput = execution.output === undefined
      ? undefined
      : await this.payloadCodec.decode(execution.output);
    return await parseSchema(
      workflow.outputSchema,
      decodedOutput,
      workflow.validation.output,
    ) as WorkflowResult<Definition>;
  }

  public async signal<
    InputSchema extends ZodType,
    OutputSchema extends ZodType | undefined,
    const Signals extends readonly AnyWorkflowSignal[],
    Signal extends Signals[number],
  >(
    workflow: Workflow<InputSchema, OutputSchema, Signals>,
    executionId: string,
    signal: Signal,
    rawPayload: WorkflowSignalInput<Signal>,
    options: SendWorkflowSignalOptions = {},
  ): Promise<WorkflowSignalReceipt> {
    if (!workflow.signals.includes(signal)) {
      throw new TypeError(
        `Signal "${signal.name}" is not declared by workflow "${workflow.name}".`,
      );
    }

    if (options.idempotencyKey !== undefined && options.idempotencyKey.length === 0) {
      throw new TypeError("Workflow signal idempotency keys cannot be empty.");
    }

    const payload = await parseSchema(
      signal.payloadSchema,
      rawPayload,
      signal.validation.input,
    );
    const encodedPayload = await this.payloadCodec.encode(payload);
    // Reject stale or mismatched handles before accepting an external event.
    await this.getExecution(workflow, executionId);
    return this.adapter.sendSignal({
      executionId,
      workflowName: workflow.name,
      signalName: signal.name,
      payload: encodedPayload,
      ...(options.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: options.idempotencyKey }),
    });
  }

  public async cancel(
    workflow: AnyWorkflow,
    executionId: string,
  ): Promise<boolean> {
    await this.getExecution(workflow, executionId);
    return this.adapter.requestCancellation(executionId);
  }
}

function assertExecutionMatches(
  workflow: AnyWorkflow,
  execution: WorkflowExecution,
): void {
  if (execution.workflowName !== workflow.name) {
    throw new WorkflowExecutionConflictError(
      execution.executionId,
      `Workflow execution "${execution.executionId}" belongs to "${execution.workflowName}", not "${workflow.name}".`,
    );
  }

  if (
    execution.workflowVersion < workflow.version.supportedFrom
    || execution.workflowVersion > workflow.version.current
  ) {
    throw new WorkflowExecutionVersionUnsupportedError(
      execution.executionId,
      execution.workflowVersion,
      workflow.version.supportedFrom,
      workflow.version.current,
    );
  }
}
