import { z } from "zod";

import type { RuntimeApp } from "../app/index.js";
import {
  defineWorker,
  type AnyWorker,
  type WorkerClient,
  type WorkerCorrelatedCompletion,
  type WorkerCorrelatedCompletionSink,
  WorkerRetryError,
} from "../workers/index.js";
import type {
  ReservedWorkflowActivityDispatch,
  WorkflowActivityDispatchReservationRef,
  WorkflowAdapter,
} from "./adapter.js";
import {
  ActionWorkflowActivityTransport,
  setWorkflowActivityExecutionContext,
  toWorkflowActivityExecution,
} from "./activity_transport.js";
import {
  serializeWorkflowError,
  WorkflowActivityInfrastructureError,
  WorkflowActivityTimeoutError,
  type WorkflowExecutionError,
} from "./errors.js";
import type { WorkflowPayload } from "./serialization.js";

export const workflowActivityWorkerQueue = "kestrel.workflow.activities";
export const workflowActivityCorrelationNamespace = "workflow.activity";

interface WorkflowActivityWorkerPayload {
  taskId: string;
  executionId: string;
  sequence: number;
  target: string;
  payload: WorkflowPayload;
  scheduledAtMs: number;
}

type WorkflowActivityWorkerResult =
  | {
      type: "workflow.activity.result";
      status: "completed";
      result?: WorkflowPayload;
    }
  | {
      type: "workflow.activity.result";
      status: "failed";
      error: WorkflowExecutionError;
    };

/** Creates the generic Worker that executes dynamically addressed Actions. */
export function createWorkflowActivityWorker<Config>(
  app: RuntimeApp<Config>,
): AnyWorker {
  return defineWorker({
    name: "kestrel.workflow.activity",
    queue: workflowActivityWorkerQueue,
    input: z.custom<WorkflowActivityWorkerPayload>(isWorkerPayload),
    maxAttempts: 3,
    handler: async (job, _dependencies, context) => {
      const transport = new ActionWorkflowActivityTransport(
        app.catalog.actions.definitions,
        {
          execute: (action, input) =>
            context.execution.get(action).run(input as never),
        },
      );
      const activity = toWorkflowActivityExecution({
        id: job.payload.taskId,
        executionId: job.payload.executionId,
        kind: "activity",
        commandSequence: job.payload.sequence,
        target: job.payload.target,
        payload: job.payload.payload,
        attempt: job.attempt,
      });

      try {
        setWorkflowActivityExecutionContext(context.execution.context, activity);
        if (activity.scheduleToCloseTimeoutMs !== undefined
          && Date.now() - job.payload.scheduledAtMs
            >= activity.scheduleToCloseTimeoutMs) {
          throw new WorkflowActivityTimeoutError(
            activity.executionId,
            activity.sequence,
            "schedule-to-close",
          );
        }
        const result = await executeWithActivityTimeout(
          transport.execute(activity, context.signal),
          activity,
        );
        context.setResult({
          type: "workflow.activity.result",
          status: "completed",
          ...(result === undefined ? {} : { result }),
        } satisfies WorkflowActivityWorkerResult);
      } catch (error) {
        if (error instanceof WorkflowActivityInfrastructureError
          && job.attempt < activity.retry.maxAttempts) {
          const exponentialDelay = activity.retry.initialDelayMs
            * activity.retry.backoffCoefficient ** Math.max(0, job.attempt - 1);
          throw new WorkerRetryError(
            `Workflow activity ${activity.executionId}:${activity.sequence} failed.`,
            Math.min(
              exponentialDelay,
              activity.retry.maxDelayMs ?? exponentialDelay,
            ),
            { cause: error, maxAttempts: activity.retry.maxAttempts },
          );
        }

        // Business failures belong to workflow history, not the Worker DLQ.
        context.setResult({
          type: "workflow.activity.result",
          status: "failed",
          error: serializeWorkflowError(error),
        } satisfies WorkflowActivityWorkerResult);
      }
    },
  });
}

export interface WorkflowActivityOutboxDispatcherOptions {
  batchSize?: number;
  leaseMs?: number;
  retryDelayMs?: number;
}

/** Publishes transactional activity outbox rows through any Worker adapter. */
export class WorkflowActivityOutboxDispatcher {
  private readonly batchSize: number;

  private readonly leaseMs: number;

  private readonly retryDelayMs: number;

  public constructor(
    private readonly adapter: WorkflowAdapter,
    private readonly workerClient: WorkerClient,
    private readonly worker: AnyWorker,
    options: WorkflowActivityOutboxDispatcherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 25;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  public async runOnce(): Promise<number> {
    const dispatches = await this.adapter.reserveActivityDispatches({
      limit: this.batchSize,
      leaseMs: this.leaseMs,
    });
    await Promise.all(dispatches.map((dispatch) => this.publish(dispatch)));
    return dispatches.length;
  }

  private async publish(
    dispatch: ReservedWorkflowActivityDispatch,
  ): Promise<void> {
    const reservation = toDispatchReservation(dispatch);

    try {
      await this.workerClient.enqueue(this.worker, toWorkerPayload(dispatch), {
        identity: `${dispatch.executionId}:${dispatch.sequence}`,
        correlation: {
          namespace: workflowActivityCorrelationNamespace,
          id: `${dispatch.executionId}:${dispatch.sequence}`,
          data: {
            executionId: dispatch.executionId,
            sequence: dispatch.sequence,
          },
        },
      });
      const published = await this.adapter.markActivityDispatchesPublished([
        reservation,
      ]);
      if (published.length !== 1) {
        throw new Error("The workflow activity outbox lease is stale.");
      }
    } catch (error) {
      await this.adapter.retryActivityDispatches([{
        ...reservation,
        retryAt: new Date(Date.now() + this.retryDelayMs),
      }]);
      throw new Error(
        `Could not publish workflow activity ${dispatch.executionId}:${dispatch.sequence}.`,
        { cause: error },
      );
    }
  }
}

/** Stores Worker results in the workflow journal before the Worker ACK. */
export class WorkflowWorkerCompletionSink
implements WorkerCorrelatedCompletionSink {
  public constructor(private readonly adapter: WorkflowAdapter) {}

  public async complete(completion: WorkerCorrelatedCompletion): Promise<void> {
    if (completion.correlation.namespace !== workflowActivityCorrelationNamespace) {
      throw new Error(
        `Unsupported Worker correlation namespace "${completion.correlation.namespace}".`,
      );
    }

    const correlation = readCorrelationData(completion.correlation.data);
    const request = completion.status === "failed"
      ? {
          executionId: correlation.executionId,
          sequence: correlation.sequence,
          sourceId: completion.jobId,
          status: "failed" as const,
          error: {
            name: completion.error.name,
            message: completion.error.message,
            ...(completion.error.stack === undefined
              ? {}
              : { stack: completion.error.stack }),
          },
        }
      : toExternalCompletion(completion, correlation);
    const accepted = await this.adapter.completeExternalActivity(request);

    if (!accepted) {
      throw new Error(
        `Workflow activity result ${correlation.executionId}:${correlation.sequence} was rejected.`,
      );
    }
  }
}

function toWorkerPayload(
  dispatch: ReservedWorkflowActivityDispatch,
): WorkflowActivityWorkerPayload {
  return {
    taskId: dispatch.id,
    executionId: dispatch.executionId,
    sequence: dispatch.sequence,
    target: dispatch.target,
    payload: dispatch.payload,
    scheduledAtMs: dispatch.createdAt.getTime(),
  };
}

function toDispatchReservation(
  dispatch: ReservedWorkflowActivityDispatch,
): WorkflowActivityDispatchReservationRef {
  return {
    dispatchId: dispatch.id,
    reservationToken: dispatch.reservationToken,
  };
}

function isWorkerPayload(value: unknown): value is WorkflowActivityWorkerPayload {
  if (value === null || typeof value !== "object") return false;
  const payload = value as Partial<WorkflowActivityWorkerPayload>;
  return typeof payload.taskId === "string"
    && typeof payload.executionId === "string"
    && Number.isSafeInteger(payload.sequence)
    && typeof payload.target === "string"
    && typeof payload.scheduledAtMs === "number"
    && Object.hasOwn(payload, "payload");
}

async function executeWithActivityTimeout(
  execution: Promise<WorkflowPayload | undefined>,
  activity: ReturnType<typeof toWorkflowActivityExecution>,
): Promise<WorkflowPayload | undefined> {
  if (activity.startToCloseTimeoutMs === undefined) return execution;

  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new WorkflowActivityTimeoutError(
      activity.executionId,
      activity.sequence,
      "start-to-close",
    )), activity.startToCloseTimeoutMs);
    timeout.unref();
  });

  try {
    return await Promise.race([execution, expired]);
  } finally {
    clearTimeout(timeout);
  }
}

function readCorrelationData(value: unknown): {
  executionId: string;
  sequence: number;
} {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Workflow activity correlation data is missing.");
  }
  const data = value as { executionId?: unknown; sequence?: unknown };
  if (typeof data.executionId !== "string" || !Number.isSafeInteger(data.sequence)) {
    throw new TypeError("Workflow activity correlation data is invalid.");
  }
  return { executionId: data.executionId, sequence: data.sequence as number };
}

function toExternalCompletion(
  completion: Extract<WorkerCorrelatedCompletion, { status: "completed" }>,
  correlation: { executionId: string; sequence: number },
) {
  const result = completion.result;

  if (!isWorkerResult(result)) {
    return {
      ...correlation,
      sourceId: completion.jobId,
      status: "failed" as const,
      error: {
        name: "WorkflowActivityResultError",
        message: "The workflow activity Worker returned an invalid result.",
      },
    };
  }

  return result.status === "failed"
    ? { ...correlation, sourceId: completion.jobId, ...result }
    : {
        ...correlation,
        sourceId: completion.jobId,
        status: "completed" as const,
        ...(result.result === undefined ? {} : { result: result.result }),
      };
}

function isWorkerResult(value: unknown): value is WorkflowActivityWorkerResult {
  if (value === null || typeof value !== "object") return false;
  const result = value as Partial<WorkflowActivityWorkerResult>;
  return result.type === "workflow.activity.result"
    && (result.status === "completed"
      || (result.status === "failed"
        && result.error !== undefined
        && typeof result.error.message === "string"));
}
