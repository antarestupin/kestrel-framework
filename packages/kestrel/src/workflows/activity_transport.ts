import { parseSchema } from "../definitions/index.js";
import type { ReservedWorkflowTask } from "./adapter.js";
import type { ExecutionContext } from "../app/index.js";
import type { Action } from "../actions/index.js";
import type { ZodType } from "zod";
import {
  jsonWorkflowPayloadCodec,
  type WorkflowPayload,
  type WorkflowPayloadCodec,
} from "./serialization.js";

export interface WorkflowActivityExecution {
  taskId: string;
  executionId: string;
  sequence: number;
  target: string;
  payload: WorkflowPayload;
  attempt: number;
  idempotencyKey: string;
  retry: {
    maxAttempts: number;
    initialDelayMs: number;
    backoffCoefficient: number;
    maxDelayMs?: number;
  };
  scheduleToCloseTimeoutMs?: number;
  startToCloseTimeoutMs?: number;
}

export const workflowActivityExecutionContextKey = "workflow.activity";

/** Makes activity identity and retry metadata available to Action dependencies. */
export function setWorkflowActivityExecutionContext(
  context: ExecutionContext,
  activity: WorkflowActivityExecution,
): void {
  context.set(workflowActivityExecutionContextKey, activity);
  // Diagnostic projections intentionally exclude payloads and retry errors.
  context.setDiagnostic("workflow.executionId", activity.executionId);
  context.setDiagnostic("workflow.commandSequence", activity.sequence);
  context.setDiagnostic("workflow.activityTarget", activity.target);
  context.setDiagnostic("workflow.taskAttempt", activity.attempt);
  context.setDiagnostic("workflow.activityIdempotencyKey", activity.idempotencyKey);
}

/** Reads the activity bound to the current Action execution, when present. */
export function getWorkflowActivityExecutionContext(
  context: ExecutionContext,
): WorkflowActivityExecution | undefined {
  return context.get(workflowActivityExecutionContextKey) as
    | WorkflowActivityExecution
    | undefined;
}

/** Storage-independent activity execution boundary selected by the runtime. */
export interface WorkflowActivityTransport {
  execute(
    activity: WorkflowActivityExecution,
    signal: AbortSignal,
  ): Promise<WorkflowPayload | undefined>;
}

export type WorkflowActivityHandler = (
  payload: WorkflowPayload,
  execution: Omit<WorkflowActivityExecution, "payload">,
  signal: AbortSignal,
) => Promise<WorkflowPayload | undefined> | WorkflowPayload | undefined;

/** In-process transport used before Worker-backed dispatch is introduced. */
export class EmbeddedWorkflowActivityTransport
implements WorkflowActivityTransport {
  public constructor(
    private readonly resolve: (
      target: string,
    ) => WorkflowActivityHandler | undefined,
  ) {}

  public async execute(
    activity: WorkflowActivityExecution,
    signal: AbortSignal,
  ): Promise<WorkflowPayload | undefined> {
    const handler = this.resolve(activity.target);

    if (handler === undefined) {
      throw new Error(`Unknown embedded workflow activity "${activity.target}".`);
    }

    return handler(
      activity.payload,
      {
        taskId: activity.taskId,
        executionId: activity.executionId,
        sequence: activity.sequence,
        target: activity.target,
        attempt: activity.attempt,
        idempotencyKey: activity.idempotencyKey,
        retry: activity.retry,
        ...(activity.scheduleToCloseTimeoutMs === undefined
          ? {}
          : { scheduleToCloseTimeoutMs: activity.scheduleToCloseTimeoutMs }),
        ...(activity.startToCloseTimeoutMs === undefined
          ? {}
          : { startToCloseTimeoutMs: activity.startToCloseTimeoutMs }),
      },
      signal,
    );
  }
}

export type AnyWorkflowAction = Action<ZodType, ZodType, any>;

export interface ActionWorkflowActivityTransportOptions {
  codec?: WorkflowPayloadCodec;
  execute: (
    action: AnyWorkflowAction,
    input: unknown,
    activity: WorkflowActivityExecution,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;
}

/** Executes catalog Actions through an application-supplied execution scope. */
export class ActionWorkflowActivityTransport
implements WorkflowActivityTransport {
  private readonly actions: ReadonlyMap<string, AnyWorkflowAction>;

  private readonly codec: WorkflowPayloadCodec;

  public constructor(
    actions: readonly AnyWorkflowAction[],
    private readonly options: ActionWorkflowActivityTransportOptions,
  ) {
    this.actions = new Map(actions.map((action) => [action.name, action]));
    this.codec = options.codec ?? jsonWorkflowPayloadCodec;
  }

  public async execute(
    activity: WorkflowActivityExecution,
    signal: AbortSignal,
  ): Promise<WorkflowPayload> {
    const action = this.actions.get(activity.target);

    if (action === undefined) {
      throw new Error(`Unknown workflow Action "${activity.target}".`);
    }

    const decodedInput = await this.codec.decode(activity.payload);
    const input = await parseSchema(
      action.inputSchema,
      decodedInput,
      action.validation.input,
    );
    const rawOutput = await this.options.execute(
      action,
      input,
      activity,
      signal,
    );
    const output = await parseSchema(
      action.outputSchema,
      rawOutput,
      action.validation.output,
    );
    return this.codec.encode(output);
  }
}

/** Converts a reserved adapter task to the transport's strict activity view. */
export function toWorkflowActivityExecution(
  task: Pick<
    ReservedWorkflowTask,
    | "attempt"
    | "commandSequence"
    | "executionId"
    | "id"
    | "kind"
    | "payload"
    | "target"
  >,
): WorkflowActivityExecution {
  if (
    task.kind !== "activity"
    || task.commandSequence === undefined
    || task.target === undefined
    || task.payload === undefined
  ) {
    throw new TypeError(`Workflow task "${task.id}" is not a valid activity.`);
  }

  const envelope = readActivityEnvelope(task.payload);
  return {
    taskId: task.id,
    executionId: task.executionId,
    sequence: task.commandSequence,
    target: task.target,
    payload: envelope.input,
    attempt: task.attempt,
    idempotencyKey: `${task.executionId}:${task.commandSequence}`,
    retry: envelope.retry,
    ...(envelope.scheduleToCloseTimeoutMs === undefined
      ? {}
      : { scheduleToCloseTimeoutMs: envelope.scheduleToCloseTimeoutMs }),
    ...(envelope.startToCloseTimeoutMs === undefined
      ? {}
      : { startToCloseTimeoutMs: envelope.startToCloseTimeoutMs }),
  };
}

function readActivityEnvelope(payload: WorkflowPayload): {
  input: WorkflowPayload;
  retry: WorkflowActivityExecution["retry"];
  scheduleToCloseTimeoutMs?: number;
  startToCloseTimeoutMs?: number;
} {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    return {
      input: payload,
      retry: defaultRetry,
    };
  }

  const envelope = payload as Readonly<Record<string, WorkflowPayload>>;
  const input = envelope.input;
  const options = envelope.options;

  if (input === undefined || options === null || Array.isArray(options)
    || typeof options !== "object") {
    return { input: payload, retry: defaultRetry };
  }

  const normalized = options as Readonly<Record<string, WorkflowPayload>>;

  return {
    input,
    retry: {
      maxAttempts: readPositiveInteger(normalized.maxAttempts, 1),
      initialDelayMs: readNonNegativeInteger(normalized.initialDelayMs, 1_000),
      backoffCoefficient: typeof normalized.backoffCoefficient === "number"
        ? normalized.backoffCoefficient
        : 2,
      ...(typeof normalized.maxDelayMs === "number"
        ? { maxDelayMs: normalized.maxDelayMs }
        : {}),
    },
    ...(typeof normalized.scheduleToCloseTimeoutMs === "number"
      ? { scheduleToCloseTimeoutMs: normalized.scheduleToCloseTimeoutMs }
      : {}),
    ...(typeof normalized.startToCloseTimeoutMs === "number"
      ? { startToCloseTimeoutMs: normalized.startToCloseTimeoutMs }
      : {}),
  };
}

const defaultRetry = {
  maxAttempts: 1,
  initialDelayMs: 1_000,
  backoffCoefficient: 2,
} as const;

function readPositiveInteger(value: WorkflowPayload | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function readNonNegativeInteger(
  value: WorkflowPayload | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}
