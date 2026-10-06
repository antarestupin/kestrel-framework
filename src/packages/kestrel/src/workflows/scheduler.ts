import { uuidV7 } from "../utils/uuid.js";
import { parseSchema } from "../definitions/index.js";
import {
  abortableDelay,
  startLeaseHeartbeat,
} from "../scheduling/index.js";

import type { AnyWorkflow } from "./workflow.js";
import type {
  ReservedWorkflowTask,
  WorkflowAdapter,
  WorkflowActivationOutcome,
  WorkflowTaskReservationRef,
} from "./adapter.js";
import type { WorkflowActivationSnapshot } from "./history.js";
import {
  serializeWorkflowError,
  WorkflowExecutionVersionUnsupportedError,
  WorkflowJournalConflictError,
  WorkflowActivityInfrastructureError,
  WorkflowActivityTimeoutError,
  WorkflowCancellationError,
  WorkflowHistoryLimitExceededError,
  WorkflowSignalTimeoutError,
} from "./errors.js";
import {
  jsonWorkflowPayloadCodec,
  type WorkflowPayload,
  type WorkflowPayloadCodec,
} from "./serialization.js";
import { WorkflowReplayer } from "./replayer.js";
import { DurableWorkflowExecutionContext } from "./context.js";
import { WorkflowCompletionBuffer } from "./completion_buffer.js";
import {
  toWorkflowActivityExecution,
  type WorkflowActivityTransport,
} from "./activity_transport.js";
import type { WorkflowInstrumentation } from "./observations.js";

export interface WorkflowSchedulerOptions {
  batchSize?: number;
  idlePollMs?: number;
  leaseMs?: number;
  payloadCodec?: WorkflowPayloadCodec;
  replayer?: WorkflowReplayer;
  createUuid?: () => string;
  now?: () => number;
  maxHistoryEvents?: number;
  /** Maximum activity and timer completions persisted by one adapter call. */
  completionBatchSize?: number;
  /** Maximum time a partial completion batch waits before persistence. */
  completionFlushIntervalMs?: number;
  instrumentation?: WorkflowInstrumentation;
  /** Runnable task kinds owned by this process. */
  taskKinds?: readonly import("./adapter.js").WorkflowTaskKind[];
  /** Injects application execution scopes without reversing library dependencies. */
  runInExecutionScope?: <Result>(
    executionId: string,
    operation: string,
    run: () => Promise<Result>,
    task: ReservedWorkflowTask,
  ) => Promise<Result>;
}

export interface WorkflowSchedulerCycleResult {
  reserved: number;
  completed: number;
  stale: number;
}

/** Reserves short workflow or embedded-activity tasks and commits their result. */
export class WorkflowScheduler {
  private readonly definitions: ReadonlyMap<string, AnyWorkflow>;

  private readonly batchSize: number;

  private readonly idlePollMs: number;

  private readonly leaseMs: number;

  private readonly payloadCodec: WorkflowPayloadCodec;

  private readonly replayer: WorkflowReplayer;

  private readonly createUuid: () => string;

  private readonly now: () => number;

  private readonly maxHistoryEvents: number;

  private readonly taskKinds: readonly import("./adapter.js").WorkflowTaskKind[];

  private readonly instrumentation: WorkflowInstrumentation | undefined;

  private readonly completions: WorkflowCompletionBuffer;

  private readonly runInExecutionScope: NonNullable<
    WorkflowSchedulerOptions["runInExecutionScope"]
  >;

  public constructor(
    definitions: readonly AnyWorkflow[],
    private readonly adapter: WorkflowAdapter,
    private readonly activityTransport: WorkflowActivityTransport,
    options: WorkflowSchedulerOptions = {},
  ) {
    this.definitions = new Map(definitions.map((definition) => [
      definition.name,
      definition,
    ]));
    this.batchSize = options.batchSize ?? 10;
    this.idlePollMs = options.idlePollMs ?? 100;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.payloadCodec = options.payloadCodec ?? jsonWorkflowPayloadCodec;
    this.replayer = options.replayer ?? new WorkflowReplayer();
    this.createUuid = options.createUuid ?? uuidV7;
    this.now = options.now ?? Date.now;
    this.maxHistoryEvents = options.maxHistoryEvents ?? 10_000;
    this.taskKinds = options.taskKinds ?? ["workflow", "activity", "timer"];
    this.instrumentation = options.instrumentation;
    this.completions = new WorkflowCompletionBuffer(adapter, {
      maxSize: options.completionBatchSize ?? 100,
      flushIntervalMs: options.completionFlushIntervalMs ?? 100,
    });
    this.runInExecutionScope = options.runInExecutionScope
      ?? ((_executionId, _operation, run) => run());
    validatePositiveInteger("batchSize", this.batchSize);
    validatePositiveInteger("idlePollMs", this.idlePollMs);
    validatePositiveInteger("leaseMs", this.leaseMs);
    validatePositiveInteger("maxHistoryEvents", this.maxHistoryEvents);
    validatePositiveInteger(
      "completionBatchSize",
      options.completionBatchSize ?? 100,
    );
    validatePositiveInteger(
      "completionFlushIntervalMs",
      options.completionFlushIntervalMs ?? 100,
    );
  }

  /** Processes one bounded reservation batch for tests and composed runtimes. */
  public async runOnce(): Promise<WorkflowSchedulerCycleResult> {
    const tasks = await this.adapter.reserveTasks({
      kinds: this.taskKinds,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
    });
    // Start one shared load immediately. Workflow task heartbeats remain active
    // while awaiting it, and activities or timers do not wait for histories.
    const activations = this.loadActivationBatch(tasks);
    let completed = 0;
    let stale = 0;

    await Promise.all(tasks.map(async (task) => {
      const committed = await this.processReservedTask(task, activations);

      if (committed) {
        completed += 1;
      } else {
        stale += 1;
      }
    }));

    return { reserved: tasks.length, completed, stale };
  }

  private async processReservedTask(
    task: ReservedWorkflowTask,
    activations: Promise<ReadonlyMap<string, WorkflowActivationSnapshot>>,
  ): Promise<boolean> {
    const startedAt = performance.now();
    try {
      const committed = await this.keepLeaseAlive(task, async () => {
        if (task.kind === "workflow") {
          const snapshot = (await activations).get(task.id);

          // A missing row means ownership changed before the batch load.
          if (snapshot === undefined) return false;

          return this.runInExecutionScope(
            task.executionId,
            "workflow.activate",
            () => this.activateWorkflow(task, snapshot),
            task,
          );
        }

        return this.runInExecutionScope(
          task.executionId,
          task.kind === "activity" ? "workflow.activity" : "workflow.timer",
          () => task.kind === "activity"
            ? this.executeActivity(task)
            : this.completeTimer(task),
          task,
        );
      });
      await this.recordTaskResult(
        task,
        committed ? "committed" : "stale",
        performance.now() - startedAt,
      );
      return committed;
    } catch (error) {
      await this.recordTaskResult(
        task,
        error instanceof WorkflowJournalConflictError ? "stale" : "failed",
        performance.now() - startedAt,
      );
      await this.adapter.releaseTasks([toReservation(task)]);

      if (error instanceof WorkflowJournalConflictError) {
        return false;
      }

      throw error;
    }
  }

  /** Loads every workflow snapshot in the reservation with one adapter call. */
  private async loadActivationBatch(
    tasks: readonly ReservedWorkflowTask[],
  ): Promise<ReadonlyMap<string, WorkflowActivationSnapshot>> {
    const reservations = tasks
      .filter((task) => task.kind === "workflow")
      .map(toReservation);
    if (reservations.length === 0) return new Map();

    const loaded = await this.adapter.loadActivations(reservations);
    return new Map(loaded.map((activation) => [
      activation.taskId,
      activation.snapshot,
    ]));
  }

  /** Polls until the supplied signal requests graceful shutdown. */
  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const cycle = await this.runOnce();

      if (cycle.reserved === 0) {
        await abortableDelay(this.idlePollMs, signal);
      }
    }
  }

  private async activateWorkflow(
    task: ReservedWorkflowTask,
    snapshot: WorkflowActivationSnapshot,
  ): Promise<boolean> {
    const reservation = toReservation(task);

    const definition = this.definitions.get(snapshot.workflowName);

    if (snapshot.history.length > this.maxHistoryEvents) {
      return this.adapter.commitActivation({
        ...reservation,
        executionId: snapshot.executionId,
        expectedRevision: snapshot.revision,
        commands: [],
        outcome: {
          status: "blocked",
          error: serializeWorkflowError(new WorkflowHistoryLimitExceededError(
            snapshot.executionId,
            snapshot.history.length,
            this.maxHistoryEvents,
          )),
        },
      });
    }

    if (definition === undefined) {
      return this.adapter.commitActivation({
        ...reservation,
        executionId: snapshot.executionId,
        expectedRevision: snapshot.revision,
        commands: [],
        outcome: {
          status: "blocked",
          error: serializeWorkflowError(new Error(
            `Workflow definition "${snapshot.workflowName}" is not deployed.`,
          )),
        },
      });
    }

    if (
      snapshot.workflowVersion < definition.version.supportedFrom
      || snapshot.workflowVersion > definition.version.current
    ) {
      return this.adapter.commitActivation({
        ...reservation,
        executionId: snapshot.executionId,
        expectedRevision: snapshot.revision,
        commands: [],
        outcome: {
          status: "blocked",
          error: serializeWorkflowError(
            new WorkflowExecutionVersionUnsupportedError(
              snapshot.executionId,
              snapshot.workflowVersion,
              definition.version.supportedFrom,
              definition.version.current,
            ),
          ),
        },
      });
    }

    let result;
    let executionContext: { readonly cancellationWasDelivered: boolean }
      & { readonly continueAsNewInput: WorkflowPayload | undefined }
      | undefined;

    try {
      const decodedInput = await this.payloadCodec.decode(snapshot.input);
      const input = await parseSchema(
        definition.inputSchema,
        decodedInput,
        definition.validation.input,
      );
      result = await this.replayer.replay(
        snapshot,
        (_storedInput, replay) => {
          const context = new DurableWorkflowExecutionContext(replay, {
            cancellationRequested: snapshot.cancellationRequested,
            codec: this.payloadCodec,
            createUuid: this.createUuid,
            now: this.now,
            signals: definition.signals,
          });
          executionContext = context;
          return definition.handler(input, context);
        },
      );
    } catch (error) {
      return this.adapter.commitActivation({
        ...reservation,
        executionId: snapshot.executionId,
        expectedRevision: snapshot.revision,
        commands: [],
        outcome: { status: "failed", error: serializeWorkflowError(error) },
      });
    }

    if (executionContext?.continueAsNewInput !== undefined) {
      let input: WorkflowPayload;

      try {
        const decoded = await this.payloadCodec.decode(
          executionContext.continueAsNewInput,
        );
        const parsed = await parseSchema(
          definition.inputSchema,
          decoded,
          definition.validation.input,
        );
        input = await this.payloadCodec.encode(parsed);
      } catch (error) {
        return this.adapter.commitActivation({
          ...reservation,
          executionId: snapshot.executionId,
          expectedRevision: snapshot.revision,
          commands: [],
          outcome: { status: "failed", error: serializeWorkflowError(error) },
        });
      }

      return this.adapter.continueAsNew({
        ...reservation,
        executionId: snapshot.executionId,
        expectedRevision: snapshot.revision,
        workflowVersion: definition.version.current,
        input,
      });
    }

    if (result.status === "waiting") {
      return this.adapter.commitActivation({
        ...reservation,
        executionId: snapshot.executionId,
        expectedRevision: snapshot.revision,
        commands: result.commands,
        outcome: { status: "waiting" },
      });
    }

    if (
      result.status === "completed"
      && snapshot.cancellationRequested
      && !executionContext?.cancellationWasDelivered
    ) {
      return this.adapter.commitActivation({
        ...reservation,
        executionId: snapshot.executionId,
        expectedRevision: snapshot.revision,
        commands: [],
        outcome: { status: "cancelled" },
      });
    }

    if (result.status === "blocked" || result.status === "failed") {
      const cancelled = result.status === "failed"
        && result.error instanceof WorkflowCancellationError;
      const outcome: WorkflowActivationOutcome = cancelled
        ? { status: "cancelled" }
        : {
            status: result.status,
            error: serializeWorkflowError(result.error),
          };
      return this.adapter.commitActivation({
        ...reservation,
        executionId: snapshot.executionId,
        expectedRevision: snapshot.revision,
        // A terminal or blocked activation must not dispatch work reached
        // before the handler failed or replay diverged.
        commands: [],
        outcome,
      });
    }

    let output: WorkflowPayload | undefined;

    try {
      if (definition.outputSchema !== undefined) {
        const parsedOutput = await parseSchema(
          definition.outputSchema,
          result.output,
          definition.validation.output,
        );
        output = await this.payloadCodec.encode(parsedOutput);
      }
    } catch (error) {
      return this.adapter.commitActivation({
        ...reservation,
        executionId: snapshot.executionId,
        expectedRevision: snapshot.revision,
        commands: [],
        outcome: { status: "failed", error: serializeWorkflowError(error) },
      });
    }

    return this.adapter.commitActivation({
      ...reservation,
      executionId: snapshot.executionId,
      expectedRevision: snapshot.revision,
      commands: result.commands,
      outcome: {
        status: "completed",
        ...(output === undefined ? {} : { output }),
      },
    });
  }

  private async executeActivity(task: ReservedWorkflowTask): Promise<boolean> {
    const activity = toWorkflowActivityExecution(task);

    try {
      if (
        activity.scheduleToCloseTimeoutMs !== undefined
        && this.now() - task.createdAt.getTime()
          >= activity.scheduleToCloseTimeoutMs
      ) {
        throw new WorkflowActivityTimeoutError(
          activity.executionId,
          activity.sequence,
          "schedule-to-close",
        );
      }

      const result = await executeWithTimeout(
        this.activityTransport,
        activity,
        activity.startToCloseTimeoutMs,
      );
      return this.completions.enqueue({
        ...toReservation(task),
        executionId: activity.executionId,
        sequence: activity.sequence,
        status: "completed",
        ...(result === undefined ? {} : { result }),
      });
    } catch (error) {
      if (
        error instanceof WorkflowActivityInfrastructureError
        && activity.attempt < activity.retry.maxAttempts
      ) {
        const delay = activity.retry.initialDelayMs
          * activity.retry.backoffCoefficient ** Math.max(0, activity.attempt - 1);
        const retryDelay = activity.retry.maxDelayMs === undefined
          ? delay
          : Math.min(delay, activity.retry.maxDelayMs);
        await this.recordTaskResult(
          task,
          "retried",
          0,
          retryDelay,
        );
        return this.adapter.retryTask({
          ...toReservation(task),
          retryAt: new Date(this.now() + retryDelay),
          error: serializeWorkflowError(error),
        });
      }

      return this.completions.enqueue({
        ...toReservation(task),
        executionId: activity.executionId,
        sequence: activity.sequence,
        status: "failed",
        error: serializeWorkflowError(error),
      });
    }
  }

  private async recordTaskResult(
    task: ReservedWorkflowTask,
    result: "committed" | "failed" | "retried" | "stale",
    durationMs: number,
    retryDelayMs?: number,
  ): Promise<void> {
    if (this.instrumentation === undefined) return;
    try {
      this.instrumentation.record({
        type: "task",
        outcome: result === "failed" ? "failure" : "success",
        durationMs,
        data: {
          executionId: task.executionId,
          workflowName: task.workflowName,
          workflowVersion: task.workflowVersion,
          historyGeneration: task.historyGeneration,
          taskKind: task.kind,
          result,
          attempt: task.attempt,
          queueAgeMs: Math.max(0, task.reservedAt.getTime() - task.createdAt.getTime()),
          ...(task.kind === "timer"
            ? { timerLagMs: getTimerLagMs(task) }
            : {}),
          ...(task.commandSequence === undefined
            ? {}
            : { commandSequence: task.commandSequence }),
          ...(task.target === undefined ? {} : { target: task.target }),
          ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
        },
      });
      if (task.kind === "workflow" && result === "committed") {
        // Lifecycle classification needs the status produced by the commit;
        // ordinary task observations use reservation metadata without a read.
        const execution = await this.adapter.get(task.executionId);
        if (execution === undefined) return;
        const operation = execution.status === "blocked"
          ? "blocked"
          : execution.status === "completed"
            ? "completed"
            : execution.status === "failed"
              ? "failed"
              : execution.status === "waiting"
                ? "wait"
                : undefined;
        if (operation !== undefined) {
          this.instrumentation.record({
            type: "lifecycle",
            outcome: operation === "failed" || operation === "blocked"
              ? "failure"
              : "success",
            data: {
              executionId: execution.executionId,
              workflowName: execution.workflowName,
              workflowVersion: execution.workflowVersion,
              historyGeneration: execution.historyGeneration,
              operation,
              status: execution.status,
            },
          });
        }
      }
    } catch {
      // Metrics and observations are explicitly outside workflow truth.
    }
  }

  private completeTimer(task: ReservedWorkflowTask): Promise<boolean> {
    if (task.commandSequence === undefined || task.target === undefined) {
      throw new TypeError(`Workflow task "${task.id}" is not a valid timer.`);
    }

    return this.completions.enqueue({
      ...toReservation(task),
      executionId: task.executionId,
      sequence: task.commandSequence,
      ...(task.target.startsWith("signal:")
        ? {
            status: "failed" as const,
            error: serializeWorkflowError(new WorkflowSignalTimeoutError(
              task.executionId,
              task.target.slice("signal:".length),
            )),
          }
        : { status: "completed" as const, result: null }),
    });
  }

  private async keepLeaseAlive(
    task: ReservedWorkflowTask,
    run: () => Promise<boolean>,
  ): Promise<boolean> {
    const reservation = toReservation(task);
    const heartbeat = startLeaseHeartbeat({
      intervalMs: Math.max(1, Math.floor(this.leaseMs / 2)),
      extend: () => this.adapter.extendTaskLeases([{
        ...reservation,
        leaseMs: this.leaseMs,
      }]),
    });

    try {
      return await run();
    } finally {
      await heartbeat.close();
    }
  }
}

function getTimerLagMs(task: ReservedWorkflowTask): number {
  const payload = task.payload;
  const record = payload !== null && !Array.isArray(payload)
    && typeof payload === "object"
    ? payload as Readonly<Record<string, WorkflowPayload>>
    : undefined;
  const delay = record?.durationMs ?? record?.timeoutMs;
  const delayMs = typeof delay === "number" && Number.isFinite(delay)
    ? delay
    : 0;
  return Math.max(
    0,
    task.reservedAt.getTime() - (task.createdAt.getTime() + delayMs),
  );
}

function toReservation(task: ReservedWorkflowTask): WorkflowTaskReservationRef {
  return { taskId: task.id, reservationToken: task.reservationToken };
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Workflow scheduler ${name} must be a positive integer.`);
  }
}

async function executeWithTimeout(
  transport: WorkflowActivityTransport,
  activity: ReturnType<typeof toWorkflowActivityExecution>,
  timeoutMs: number | undefined,
): Promise<WorkflowPayload | undefined> {
  const controller = new AbortController();

  if (timeoutMs === undefined) {
    return transport.execute(activity, controller.signal);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      transport.execute(activity, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new WorkflowActivityTimeoutError(
            activity.executionId,
            activity.sequence,
            "start-to-close",
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
