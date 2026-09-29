import { z } from "zod";

import { createUuid } from "../utils/uuid.js";
import { parseSchema } from "../definitions/index.js";
import type {
  WorkflowAdapter,
  WorkflowExecutionStatus,
} from "./adapter.js";
import { DurableWorkflowExecutionContext } from "./context.js";
import type {
  WorkflowActivationSnapshot,
  WorkflowHistoryEvent,
} from "./history.js";
import {
  WorkflowReplayer,
  type WorkflowReplayResult,
} from "./replayer.js";
import {
  cloneWorkflowPayload,
  jsonWorkflowPayloadCodec,
  type WorkflowPayload,
  type WorkflowPayloadCodec,
} from "./serialization.js";
import type { AnyWorkflow } from "./workflow.js";
import { WorkflowExecutionVersionUnsupportedError } from "./errors.js";

export const workflowReplayFixtureFormat = "kestrel.workflow-replay";
export const workflowReplayFixtureVersion = 1;

export type WorkflowReplayFixtureEvent = WorkflowHistoryEvent extends infer Event
  ? Event extends WorkflowHistoryEvent
    ? Omit<Event, "occurredAt"> & { occurredAt: string }
    : never
  : never;

export interface WorkflowReplayFixture {
  format: typeof workflowReplayFixtureFormat;
  formatVersion: typeof workflowReplayFixtureVersion;
  execution: {
    executionId: string;
    workflowName: string;
    workflowVersion: number;
    historyGeneration: number;
    input: WorkflowPayload;
    status: WorkflowExecutionStatus;
    revision: number;
    cancellationRequested: boolean;
  };
  history: readonly WorkflowReplayFixtureEvent[];
}

export interface WorkflowReplayCompatibilityResult {
  compatible: true;
  replayStatus: Exclude<WorkflowReplayResult<unknown>["status"], "blocked">;
  newCommandCount: number;
}

export interface WorkflowReplayCompatibilityOptions {
  payloadCodec?: WorkflowPayloadCodec;
  replayer?: WorkflowReplayer;
  createUuid?: () => string;
  now?: () => number;
}

export interface WorkflowReplayFixtureExportOptions {
  /** Application-owned redaction hook invoked for every durable payload. */
  sanitizePayload?: (
    payload: WorkflowPayload,
    location: string,
  ) => WorkflowPayload;
  /** Error stacks are omitted by default because they can contain local data. */
  includeErrorStacks?: boolean;
}

export class WorkflowReplayCompatibilityError extends Error {
  public constructor(
    public readonly fixture: WorkflowReplayFixture,
    public readonly cause: unknown,
  ) {
    super(
      `Workflow fixture "${fixture.execution.executionId}" is incompatible with the deployed definition.`,
      { cause },
    );
    this.name = "WorkflowReplayCompatibilityError";
  }
}

/** Exports one sanitized, JSON-safe replay fixture from adapter truth. */
export async function exportWorkflowReplayFixture(
  adapter: WorkflowAdapter,
  executionId: string,
  options: WorkflowReplayFixtureExportOptions = {},
): Promise<WorkflowReplayFixture> {
  const execution = await adapter.get(executionId);
  if (execution === undefined) {
    throw new TypeError(`Unknown workflow execution "${executionId}".`);
  }
  const history = await adapter.getHistory(executionId);
  const sanitize = options.sanitizePayload ?? ((payload: WorkflowPayload) =>
    cloneWorkflowPayload(payload));
  return {
    format: workflowReplayFixtureFormat,
    formatVersion: workflowReplayFixtureVersion,
    execution: {
      executionId: execution.executionId,
      workflowName: execution.workflowName,
      workflowVersion: execution.workflowVersion,
      historyGeneration: execution.historyGeneration,
      input: sanitize(execution.input, "execution.input"),
      status: execution.status,
      revision: execution.revision,
      cancellationRequested: execution.cancellationRequested,
    },
    history: history.map((event) => sanitizeFixtureEvent(
      event,
      sanitize,
      options.includeErrorStacks ?? false,
    )),
  };
}

function sanitizeFixtureEvent(
  event: WorkflowHistoryEvent,
  sanitize: NonNullable<WorkflowReplayFixtureExportOptions["sanitizePayload"]>,
  includeErrorStacks: boolean,
): WorkflowReplayFixtureEvent {
  if (event.type === "command-scheduled") {
    return {
      ...event,
      occurredAt: event.occurredAt.toISOString(),
      payload: sanitize(event.payload, `history.${event.eventIndex}.payload`),
    };
  }
  if (event.type === "signal-received") {
    return {
      ...event,
      occurredAt: event.occurredAt.toISOString(),
      payload: sanitize(event.payload, `history.${event.eventIndex}.payload`),
    };
  }
  if (event.type === "command-completed") {
    const error = event.error === undefined
      ? undefined
      : includeErrorStacks
        ? { ...event.error }
        : omitErrorStack(event.error);
    return {
      ...event,
      occurredAt: event.occurredAt.toISOString(),
      ...(event.result === undefined
        ? {}
        : {
            result: sanitize(
              event.result,
              `history.${event.eventIndex}.result`,
            ),
          }),
      ...(error === undefined ? {} : { error }),
    };
  }
  return {
    ...event,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function omitErrorStack(
  error: NonNullable<Extract<
    WorkflowHistoryEvent,
    { type: "command-completed" }
  >["error"]>,
) {
  const { stack: _stack, ...withoutStack } = error;
  return withoutStack;
}

export function stringifyWorkflowReplayFixture(
  fixture: WorkflowReplayFixture,
): string {
  return JSON.stringify(workflowReplayFixtureSchema.parse(fixture), null, 2);
}

/** Parses fixture JSON and rejects unknown future formats explicitly. */
export function parseWorkflowReplayFixture(
  source: string | unknown,
): WorkflowReplayFixture {
  const value: unknown = typeof source === "string" ? JSON.parse(source) : source;
  return workflowReplayFixtureSchema.parse(value) as WorkflowReplayFixture;
}

/** Replays a fixture through the real deterministic context used in production. */
export async function assertWorkflowReplayCompatible(
  definition: AnyWorkflow,
  source: WorkflowReplayFixture | string | unknown,
  options: WorkflowReplayCompatibilityOptions = {},
): Promise<WorkflowReplayCompatibilityResult> {
  const fixture = parseWorkflowReplayFixture(source);
  const execution = fixture.execution;
  if (execution.workflowName !== definition.name) {
    throw new WorkflowReplayCompatibilityError(
      fixture,
      new TypeError(
        `Fixture belongs to "${execution.workflowName}", not "${definition.name}".`,
      ),
    );
  }
  if (
    execution.workflowVersion < definition.version.supportedFrom
    || execution.workflowVersion > definition.version.current
  ) {
    throw new WorkflowReplayCompatibilityError(
      fixture,
      new WorkflowExecutionVersionUnsupportedError(
        execution.executionId,
        execution.workflowVersion,
        definition.version.supportedFrom,
        definition.version.current,
      ),
    );
  }

  const codec = options.payloadCodec ?? jsonWorkflowPayloadCodec;
  const snapshot = fixtureToSnapshot(fixture);
  let result: WorkflowReplayResult<unknown>;

  try {
    const decodedInput = await codec.decode(snapshot.input);
    const input = await parseSchema(
      definition.inputSchema,
      decodedInput,
      definition.validation.input,
    );
    result = await (options.replayer ?? new WorkflowReplayer()).replay(
      snapshot,
      (_storedInput, replay) => definition.handler(
        input,
        new DurableWorkflowExecutionContext(replay, {
          cancellationRequested: snapshot.cancellationRequested,
          codec,
          createUuid: options.createUuid ?? createUuid,
          now: options.now ?? Date.now,
          signals: definition.signals,
        }),
      ),
    );
  } catch (error) {
    throw new WorkflowReplayCompatibilityError(fixture, error);
  }

  if (result.status === "blocked") {
    throw new WorkflowReplayCompatibilityError(fixture, result.error);
  }

  return {
    compatible: true,
    replayStatus: result.status,
    newCommandCount: result.commands.length,
  };
}

function fixtureToSnapshot(
  fixture: WorkflowReplayFixture,
): WorkflowActivationSnapshot {
  return {
    executionId: fixture.execution.executionId,
    workflowName: fixture.execution.workflowName,
    workflowVersion: fixture.execution.workflowVersion,
    historyGeneration: fixture.execution.historyGeneration,
    input: fixture.execution.input,
    revision: fixture.execution.revision,
    cancellationRequested: fixture.execution.cancellationRequested,
    history: fixture.history.map((event) => ({
      ...event,
      occurredAt: new Date(event.occurredAt),
    })) as readonly WorkflowHistoryEvent[],
  };
}

const workflowPayloadSchema: z.ZodType<WorkflowPayload> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(workflowPayloadSchema),
  z.record(z.string(), workflowPayloadSchema),
]));

const errorSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  details: z.record(z.string(), workflowPayloadSchema).optional(),
});

const eventBaseSchema = z.object({
  eventIndex: z.number().int().nonnegative(),
  occurredAt: z.string().datetime({ offset: true }),
});

const workflowReplayFixtureSchema = z.object({
  format: z.literal(workflowReplayFixtureFormat),
  formatVersion: z.literal(workflowReplayFixtureVersion),
  execution: z.object({
    executionId: z.string().min(1),
    workflowName: z.string().min(1),
    workflowVersion: z.number().int().positive(),
    historyGeneration: z.number().int().positive(),
    input: workflowPayloadSchema,
    status: z.enum([
      "blocked",
      "cancelled",
      "cancelling",
      "completed",
      "failed",
      "pending",
      "queued",
      "running",
      "terminated",
      "waiting",
    ]),
    revision: z.number().int().nonnegative(),
    cancellationRequested: z.boolean(),
  }),
  history: z.array(z.discriminatedUnion("type", [
    eventBaseSchema.extend({
      type: z.literal("command-scheduled"),
      sequence: z.number().int().nonnegative(),
      kind: z.string().min(1),
      target: z.string().min(1),
      payload: workflowPayloadSchema,
    }),
    eventBaseSchema.extend({
      type: z.literal("command-completed"),
      sequence: z.number().int().nonnegative(),
      completionOrder: z.number().int().nonnegative(),
      result: workflowPayloadSchema.optional(),
      error: errorSchema.optional(),
      sourceId: z.string().optional(),
    }),
    eventBaseSchema.extend({
      type: z.literal("signal-received"),
      signalId: z.string(),
      name: z.string(),
      payload: workflowPayloadSchema,
    }),
    eventBaseSchema.extend({
      type: z.literal("cancellation-requested"),
    }),
  ])),
});
