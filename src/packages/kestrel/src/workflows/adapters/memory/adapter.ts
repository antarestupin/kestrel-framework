import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { decodeWorkflowExecutionCursor, formatWorkflowCursorDate, workflowExecutionCursorCodec } from "../../execution_cursor.js";

import { uuidV7 } from "../../../utils/uuid.js";
import type {
  CommitWorkflowActivationRequest,
  ContinueWorkflowAsNewRequest,
  CompleteExternalWorkflowActivityRequest,
  CompleteWorkflowActivityRequest,
  ExtendWorkflowTaskLeaseRequest,
  LoadedWorkflowActivation,
  ReservedWorkflowTask,
  ReservedWorkflowActivityDispatch,
  ReserveWorkflowActivityDispatchesRequest,
  ReserveWorkflowTasksRequest,
  RetryWorkflowTaskRequest,
  RetryWorkflowExecutionRequest,
  RetryWorkflowActivityDispatchRequest,
  SendWorkflowSignalRequest,
  StartWorkflowExecutionRequest,
  StartWorkflowExecutionResult,
  WorkflowAdapter,
  WorkflowExecution,
  WorkflowExecutionPage,
  WorkflowExecutionQuery,
  WorkflowExecutionVersionSummary,
  WorkflowHistoryArchive,
  RecoverVersionBlockedExecutionRequest,
  WorkflowSignalReceipt,
  WorkflowTaskReservationRef,
  WorkflowActivityDispatchMode,
  WorkflowActivityDispatchReservationRef,
} from "../../adapter.js";
import { isTerminalWorkflowStatus } from "../../adapter.js";
import type { WorkflowExecutionError } from "../../errors.js";
import {
  cloneWorkflowPayload,
  type WorkflowPayload,
} from "../../serialization.js";
import {
  WorkflowExecutionClosedError,
  WorkflowConcurrencyConflictError,
  WorkflowExecutionConflictError,
  WorkflowExecutionNotFoundError,
  WorkflowSignalConflictError,
  WorkflowJournalConflictError,
} from "../../errors.js";
import type {
  WorkflowCommandCompletedEvent,
  WorkflowCommandScheduledEvent,
  WorkflowHistoryEvent,
  WorkflowSignalReceivedEvent,
  WorkflowCancellationRequestedEvent,
} from "../../history.js";
import { workflowCommandIdentity } from "../../history.js";
import type { ResolvedWorkflowConcurrency } from "../../concurrency.js";

export interface MemoryWorkflowAdapterOptions {
  now?: () => Date;
  createTaskId?: () => string;
  createReservationToken?: () => string;
  createSignalId?: () => string;
  activityDispatchMode?: WorkflowActivityDispatchMode;
}

export interface StoredWorkflowSignal {
  id: string;
  executionId: string;
  name: string;
  payload: WorkflowPayload;
  idempotencyKey?: string;
  receivedAt: Date;
  consumedBySequence?: number;
}

interface TerminalWaiter {
  resolve: (execution: WorkflowExecution) => void;
}

interface StoredWorkflowTask {
  id: string;
  executionId: string;
  kind: "activity" | "timer" | "workflow";
  commandSequence?: number;
  target?: string;
  payload?: WorkflowPayload;
  attempt: number;
  availableAt: Date;
  reservedAt?: Date;
  reservationToken?: string;
  createdAt: Date;
}

interface StoredWorkflowActivityDispatch {
  id: string;
  executionId: string;
  sequence: number;
  target: string;
  payload: WorkflowPayload;
  attempt: number;
  availableAt: Date;
  reservedAt?: Date;
  reservationToken?: string;
  publishedAt?: Date;
  createdAt: Date;
}

interface WorkflowAdmission {
  readonly workflowName: string;
  readonly key: string;
  readonly limit: number;
}

interface PreparedWorkflowCompletions {
  readonly execution: WorkflowExecution;
  readonly history: WorkflowHistoryEvent[];
  readonly wake: StoredWorkflowTask | undefined;
  readonly events: WorkflowCommandCompletedEvent[];
  nextCompletionOrder: number;
}

/** Process-local workflow storage used by clients, tests, and phase one. */
export class MemoryWorkflowAdapter implements WorkflowAdapter {
  public readonly activityDispatchMode: WorkflowActivityDispatchMode;

  private readonly executions = new Map<string, WorkflowExecution>();

  /** Preserves start idempotency after current input rotates by generation. */
  private readonly initialInputs = new Map<string, WorkflowPayload>();

  private readonly signals: StoredWorkflowSignal[] = [];

  private readonly signalsByExecutionAndKey = new Map<string, Map<string, StoredWorkflowSignal>>();

  private readonly terminalWaiters = new Map<string, Set<TerminalWaiter>>();

  private readonly pendingExecutionRetries = new Map<string, {
    readonly sourceExecutionId: string;
    readonly result: Promise<StartWorkflowExecutionResult>;
  }>();

  private readonly histories = new Map<string, WorkflowHistoryEvent[]>();

  private readonly historyArchives = new Map<string, WorkflowHistoryArchive[]>();

  private readonly tasks = new Map<string, StoredWorkflowTask>();

  private readonly dispatches = new Map<string, StoredWorkflowActivityDispatch>();

  private readonly deferredAdmissions = new Map<string, WorkflowAdmission>();

  private readonly now: () => Date;

  private readonly createSignalId: () => string;

  private readonly createTaskId: () => string;

  private readonly createReservationToken: () => string;

  public constructor(options: MemoryWorkflowAdapterOptions = {}) {
    this.activityDispatchMode = options.activityDispatchMode ?? "embedded";
    const now = options.now;
    // A caller may reuse and mutate the Date returned by its clock.
    this.now = now == null ? () => new Date() : () => new Date(now.call(this));
    this.createSignalId = options.createSignalId ?? uuidV7;
    this.createTaskId = options.createTaskId ?? uuidV7;
    this.createReservationToken = options.createReservationToken ?? uuidV7;
  }

  public async start(
    request: StartWorkflowExecutionRequest,
  ): Promise<StartWorkflowExecutionResult> {
    const [result] = await this.startMany([request]);
    return result!;
  }

  public async startMany(
    requests: readonly StartWorkflowExecutionRequest[],
  ): Promise<readonly StartWorkflowExecutionResult[]> {
    if (requests.length === 0) return [];
    for (const request of requests) validateExecutionId(request.executionId);

    // Stage the complete ordered batch so one conflict leaves no partial state.
    const stagedExecutions = new Map(this.executions);
    const stagedInitialInputs = new Map(this.initialInputs);
    const createdExecutions: WorkflowExecution[] = [];
    const results: StartWorkflowExecutionResult[] = [];
    const firstIndexByExecutionId = new Map<string, number>();
    const now = this.now();

    for (const [index, request] of requests.entries()) {
      // An earlier request may have attached to another execution without storing this ID.
      const firstIndex = firstIndexByExecutionId.get(request.executionId);
      if (firstIndex !== undefined) {
        const first = requests[firstIndex]!;
        if (first.workflowName !== request.workflowName || !isDeepStrictEqual(first.input, request.input)) {
          throw new WorkflowExecutionConflictError(request.executionId);
        }
        results.push({ execution: cloneExecution(results[firstIndex]!.execution), created: false });
        continue;
      }
      firstIndexByExecutionId.set(request.executionId, index);

      const existing = stagedExecutions.get(request.executionId);

      if (existing !== undefined) {
        if (
          existing.workflowName !== request.workflowName
          || !isDeepStrictEqual(
            stagedInitialInputs.get(request.executionId),
            request.input,
          )
        ) {
          throw new WorkflowExecutionConflictError(request.executionId);
        }

        results.push({ execution: cloneExecution(existing), created: false });
        continue;
      }

      const keyed = request.concurrency?.keyed;
      const keyedExecutions = keyed === undefined
        ? []
        : [...stagedExecutions.values()].filter((candidate) =>
            candidate.workflowName === request.workflowName
            && candidate.concurrency?.keyed?.key === keyed.key
            && !isTerminalWorkflowStatus(candidate.status));
      if (keyed?.conflict === "reject" && keyedExecutions.length >= keyed.limit) {
        throw new WorkflowConcurrencyConflictError(
          request.workflowName,
          keyed.key,
        );
      }

      if (keyed?.conflict === "return-existing" && keyedExecutions.length >= keyed.limit) {
        const current = keyedExecutions.find((candidate) =>
          candidate.concurrencyAdmitted) ?? keyedExecutions[0]!;
        results.push({ execution: cloneExecution(current), created: false });
        continue;
      }

      const concurrencyAdmitted = keyed?.scope !== "execution"
        || keyedExecutions.filter((candidate) =>
          candidate.concurrencyAdmitted).length < keyed.limit;
      const execution: WorkflowExecution = {
        executionId: request.executionId,
        workflowName: request.workflowName,
        workflowVersion: request.workflowVersion,
        historyGeneration: 1,
        input: cloneWorkflowPayload(request.input),
        status: concurrencyAdmitted ? "queued" : "pending",
        cancellationRequested: false,
        rootExecutionId: request.rootExecutionId ?? request.executionId,
        ...(request.concurrency === undefined
          ? {}
          : { concurrency: cloneConcurrency(request.concurrency) }),
        concurrencyAdmitted,
        ...(request.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: request.parentExecutionId }),
        ...(request.parentCommandSequence === undefined
          ? {}
          : { parentCommandSequence: request.parentCommandSequence }),
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };

      stagedExecutions.set(request.executionId, execution);
      stagedInitialInputs.set(
        request.executionId,
        cloneWorkflowPayload(request.input),
      );
      createdExecutions.push(execution);
      results.push({ execution: cloneExecution(execution), created: true });
    }

    // Allocate every task ID before publishing the executions and their history.
    const stagedStarts = createdExecutions.map((execution) => ({
      execution,
      taskId: execution.concurrencyAdmitted ? this.createTaskId() : undefined,
    }));
    for (const { execution, taskId } of stagedStarts) {
      this.executions.set(execution.executionId, execution);
      this.initialInputs.set(
        execution.executionId,
        stagedInitialInputs.get(execution.executionId)!,
      );
      this.histories.set(execution.executionId, []);
      if (taskId !== undefined) {
        this.enqueueWorkflowTask(execution.executionId, now, taskId);
      }
    }

    return results;
  }

  public async get(
    executionId: string,
  ): Promise<WorkflowExecution | undefined> {
    const execution = this.executions.get(executionId);
    return execution === undefined ? undefined : cloneExecution(execution);
  }

  public async listExecutions(
    query: WorkflowExecutionQuery,
  ): Promise<WorkflowExecutionPage> {
    validateExecutionQuery(query);
    const workflowNames = new Set(query.workflowNames);
    const workflowVersions = new Set(query.workflowVersions);
    const statuses = new Set(query.statuses);
    const search = query.search?.toLocaleLowerCase();
    const cursor = query.cursor === undefined
      ? undefined
      : decodeWorkflowExecutionCursor(query.cursor);
    const ordered = [...this.executions.values()]
      .filter((execution) =>
        (cursor === undefined
          || formatWorkflowCursorDate(execution.createdAt) < cursor.createdAt
          || (formatWorkflowCursorDate(execution.createdAt) === cursor.createdAt
            && cursor.id.localeCompare(execution.executionId) > 0))
        &&
        (workflowNames.size === 0 || workflowNames.has(execution.workflowName))
        && (workflowVersions.size === 0
          || workflowVersions.has(execution.workflowVersion))
        && (statuses.size === 0 || statuses.has(execution.status))
        && (search === undefined
          || execution.executionId.toLocaleLowerCase().includes(search)
          || execution.workflowName.toLocaleLowerCase().includes(search)
          || execution.concurrency?.keyed?.key.toLocaleLowerCase().includes(search) === true)
        && (query.createdAfter === undefined
          || execution.createdAt >= query.createdAfter)
        && (query.createdBefore === undefined
          || execution.createdAt <= query.createdBefore)
        && (query.parentExecutionId === undefined
          || execution.parentExecutionId === query.parentExecutionId)
        && (query.rootExecutionId === undefined
          || execution.rootExecutionId === query.rootExecutionId)
        && (query.retryOfExecutionId === undefined
          || execution.retryOfExecutionId === query.retryOfExecutionId)
        && (query.paused === undefined
          || (execution.pausedAt !== undefined) === query.paused))
      .sort(compareExecutionsNewestFirst);
    const items = ordered.slice(0, query.limit);
    const hasMore = items.length < ordered.length;
    // A validated positive limit guarantees a boundary item when another page exists.
    return {
      items: items.map(cloneExecution),
      ...(hasMore
        ? { nextCursor: z.encode(workflowExecutionCursorCodec, {
          id: items.at(-1)!.executionId,
          createdAt: formatWorkflowCursorDate(items.at(-1)!.createdAt),
        }) }
        : {}),
    };
  }

  public async waitForTerminal(
    executionId: string,
  ): Promise<WorkflowExecution> {
    const execution = this.getRequiredExecution(executionId);

    if (isTerminalWorkflowStatus(execution.status)) {
      return cloneExecution(execution);
    }

    return new Promise<WorkflowExecution>((resolve) => {
      const waiters = this.terminalWaiters.get(executionId) ?? new Set();
      waiters.add({ resolve });
      this.terminalWaiters.set(executionId, waiters);
    });
  }

  public async sendSignal(
    request: SendWorkflowSignalRequest,
  ): Promise<WorkflowSignalReceipt> {
    const execution = this.getRequiredExecution(request.executionId);

    if (execution.workflowName !== request.workflowName) {
      throw new WorkflowExecutionConflictError(request.executionId);
    }

    const idempotencyKey = request.idempotencyKey;
    const keyedSignals = this.signalsByExecutionAndKey.get(request.executionId);
    if (idempotencyKey !== undefined) {
      const existing = keyedSignals?.get(idempotencyKey);
      if (existing !== undefined) {
        if (existing.name !== request.signalName || !isDeepStrictEqual(existing.payload, request.payload)) {
          throw new WorkflowSignalConflictError(request.executionId, idempotencyKey);
        }
        return { id: existing.id, accepted: false };
      }
    }

    if (isTerminalWorkflowStatus(execution.status)) {
      throw new WorkflowExecutionClosedError(request.executionId);
    }

    const signal: StoredWorkflowSignal = {
      id: this.createSignalId(),
      executionId: request.executionId,
      name: request.signalName,
      payload: cloneWorkflowPayload(request.payload),
      ...(idempotencyKey === undefined
        ? {}
        : { idempotencyKey }),
      receivedAt: this.now(),
    };

    const history = this.getRequiredHistory(request.executionId);
    const event: WorkflowSignalReceivedEvent = {
      type: "signal-received",
      eventIndex: execution.revision,
      signalId: signal.id,
      name: signal.name,
      payload: cloneWorkflowPayload(signal.payload),
      occurredAt: new Date(signal.receivedAt),
    };
    const updatedAt = this.now();
    // Allocate the wake-up before recording the signal or its idempotency key.
    if (execution.concurrencyAdmitted) {
      this.enqueueWorkflowTask(request.executionId, updatedAt);
    }
    this.signals.push(signal);
    if (idempotencyKey !== undefined) {
      // Keep the opaque execution identity and idempotency key as independent coordinates.
      const keys = keyedSignals ?? new Map<string, StoredWorkflowSignal>();
      keys.set(idempotencyKey, signal);
      this.signalsByExecutionAndKey.set(request.executionId, keys);
    }
    history.push(event);
    execution.revision += 1;
    execution.updatedAt = updatedAt;

    return { id: signal.id, accepted: true };
  }

  public async reserveTasks(
    request: ReserveWorkflowTasksRequest,
  ): Promise<readonly ReservedWorkflowTask[]> {
    validateReservationRequest(request);
    const now = this.now();
    const kinds = new Set(request.kinds);
    const deferredFailure = kinds.has("workflow") ? this.retryDeferredAdmissions(now) : undefined;
    const candidates = [...this.tasks.values()]
      .filter((task) =>
        kinds.has(task.kind)
        && task.availableAt.getTime() <= now.getTime()
        && isRunnableExecutionStatus(
          this.getRequiredExecution(task.executionId).status,
        )
        && this.getRequiredExecution(task.executionId).pausedAt === undefined)
      .sort((left, right) =>
        left.availableAt.getTime() - right.availableAt.getTime()
        || left.createdAt.getTime() - right.createdAt.getTime()
        || left.id.localeCompare(right.id));
    const selected: StoredWorkflowTask[] = [];
    const definitionUsage = new Map<string, number>();
    const keyedUsage = new Map<string, number>();

    for (const activeTask of this.tasks.values()) {
      if (
        activeTask.reservationToken === undefined
        || activeTask.availableAt.getTime() <= now.getTime()
      ) continue;
      this.incrementConcurrencyUsage(
        this.getRequiredExecution(activeTask.executionId),
        definitionUsage,
        keyedUsage,
      );
    }

    for (const task of candidates) {
      if (selected.length >= request.limit) {
        break;
      }

      // prepareWorkflowTask maintains one activation per execution, including its leased task.
      const execution = this.getRequiredExecution(task.executionId);

      if (!hasConcurrencyCapacity(execution, definitionUsage, keyedUsage)) {
        continue;
      }

      selected.push(task);
      this.incrementConcurrencyUsage(execution, definitionUsage, keyedUsage);
    }

    // A failed handoff must not prevent unrelated tasks from being leased.
    if (selected.length === 0 && deferredFailure !== undefined) throw deferredFailure.error;
    // Allocate every token before claiming any task in the batch.
    const reservations = selected.map((task) => ({ task, reservationToken: this.createReservationToken() }));
    return reservations.map(({ task, reservationToken }) => {
      const execution = this.getRequiredExecution(task.executionId);
      task.attempt += 1;
      task.reservedAt = now;
      task.reservationToken = reservationToken;
      task.availableAt = new Date(now.getTime() + request.leaseMs);

      if (task.kind === "workflow") {
        execution.status = "running";
        execution.updatedAt = now;
      }

      return toReservedTask(task, execution, reservationToken, now);
    });
  }

  public async loadActivations(
    reservations: readonly WorkflowTaskReservationRef[],
  ): Promise<readonly LoadedWorkflowActivation[]> {
    return reservations.flatMap((reservation) => {
      const task = this.getOwnedTask(reservation);
      if (task === undefined || task.kind !== "workflow") return [];

      const execution = this.getRequiredExecution(task.executionId);
      return [{
        taskId: task.id,
        snapshot: {
          executionId: execution.executionId,
          workflowName: execution.workflowName,
          workflowVersion: execution.workflowVersion,
          historyGeneration: execution.historyGeneration,
          input: cloneWorkflowPayload(execution.input),
          revision: execution.revision,
          history: cloneHistory(this.getRequiredHistory(task.executionId)),
          cancellationRequested: execution.cancellationRequested,
        },
      }];
    });
  }

  public async commitActivation(
    request: CommitWorkflowActivationRequest,
  ): Promise<boolean> {
    const task = this.getOwnedTask(request);

    if (
      task === undefined
      || task.kind !== "workflow"
      || task.executionId !== request.executionId
    ) {
      return false;
    }

    const execution = this.getRequiredExecution(request.executionId);

    if (execution.revision !== request.expectedRevision) {
      throw new WorkflowJournalConflictError(
        request.executionId,
        request.expectedRevision,
        execution.revision,
      );
    }

    const history = this.getRequiredHistory(request.executionId);
    const scheduledCount = history.filter(
      (event) => event.type === "command-scheduled",
    ).length;
    const now = this.now();

    // Validate and prepare the whole batch before publishing any journal or task state.
    const stagedChildren = new Map<string, WorkflowExecution>();
    const preparedCommands = request.commands.map((command, offset) => {
      const expectedSequence = scheduledCount + offset;

      if (command.sequence !== expectedSequence) {
        throw new TypeError(
          `Expected workflow command sequence ${expectedSequence}, received ${command.sequence}.`,
        );
      }

      const prepared = { ...command, payload: cloneWorkflowPayload(command.payload) };
      return {
        command: prepared,
        apply: this.prepareCommand(execution, prepared, now, stagedChildren),
      };
    });

    // An immediate completion must be able to schedule the next activation before changing the journal.
    const signals = this.matchBufferedSignals(execution.executionId, history, request.commands);
    const shouldWake = request.outcome.status === "waiting"
      && (signals.length > 0 || preparedCommands.some(({ command }) => command.kind === "capture"));
    const wake = shouldWake
      ? this.prepareWorkflowTask(execution.executionId, now, undefined, task.id)
      : undefined;
    const terminal = isTerminalWorkflowStatus(request.outcome.status);
    const completeParent = terminal
      ? this.prepareParentCompletion(execution, now)
      : undefined;
    const cancelChildren = terminal
      ? this.prepareCancellation([...this.executions.values(), ...stagedChildren.values()]
        .filter((child) => child.parentExecutionId === execution.executionId), now, execution.executionId)
      : undefined;

    for (const { command, apply } of preparedCommands) {
      const event: WorkflowCommandScheduledEvent = {
        type: "command-scheduled",
        eventIndex: execution.revision,
        sequence: command.sequence,
        kind: command.kind,
        target: command.target,
        payload: command.payload,
        occurredAt: now,
      };
      history.push(event);
      execution.revision += 1;
      apply();
    }

    for (const { signal, sequence } of signals) {
      signal.consumedBySequence = sequence;
      this.appendCompletion(execution, sequence, now, { result: signal.payload, sourceId: signal.id });
      this.deleteCommandTasks(execution.executionId, sequence);
    }

    this.tasks.delete(task.id);
    execution.updatedAt = now;
    this.applyActivationOutcome(execution, request.outcome, now, completeParent, cancelChildren);

    if (shouldWake) {
      execution.status = "queued";
      if (wake !== undefined) this.tasks.set(wake.id, wake);
    }
    return true;
  }

  public async completeActivities(
    requests: readonly CompleteWorkflowActivityRequest[],
  ): Promise<readonly WorkflowTaskReservationRef[]> {
    const completed: WorkflowTaskReservationRef[] = [];
    const taskIds = new Set<string>();
    const staged = new Map<string, PreparedWorkflowCompletions>();

    // Prepare the complete batch before changing tasks or the journal. Requests
    // for the same execution share one wake and retain their buffer order.
    for (const request of requests) {
      const task = this.getOwnedTask(request);
      // A task's command sequence is assigned only when its journal command is scheduled.
      if (task === undefined || task.kind === "workflow" || taskIds.has(task.id)
        || task.executionId !== request.executionId || task.commandSequence !== request.sequence) continue;

      const now = this.now();
      let group = staged.get(request.executionId);
      if (group === undefined) {
        const execution = this.getRequiredExecution(request.executionId);
        const history = this.getRequiredHistory(request.executionId);
        group = {
          execution, history, events: [], wake: this.prepareWorkflowTask(execution.executionId, now),
          nextCompletionOrder: history.filter((event) => event.type === "command-completed").length,
        };
        staged.set(request.executionId, group);
      }

      group.events.push({
        type: "command-completed",
        eventIndex: group.execution.revision + group.events.length,
        sequence: request.sequence,
        completionOrder: group.nextCompletionOrder++,
        ...(request.status === "completed"
          ? request.result === undefined
            ? {}
            : { result: cloneWorkflowPayload(request.result) }
          : { error: cloneWorkflowError(request.error) }),
        occurredAt: now,
      });
      taskIds.add(task.id);
      completed.push({ taskId: task.id, reservationToken: request.reservationToken });
    }

    for (const taskId of taskIds) this.tasks.delete(taskId);
    for (const { execution, history, wake, events } of staged.values()) {
      for (const event of events) history.push(event);
      execution.revision += events.length;
      execution.status = "queued";
      execution.updatedAt = events.at(-1)!.occurredAt;
      if (wake !== undefined) this.tasks.set(wake.id, wake);
    }

    return completed;
  }

  public async reserveActivityDispatches(
    request: ReserveWorkflowActivityDispatchesRequest,
  ): Promise<readonly ReservedWorkflowActivityDispatch[]> {
    validatePositiveInteger("limit", request.limit);
    validatePositiveInteger("leaseMs", request.leaseMs);
    const now = this.now();
    const selected = [...this.dispatches.values()]
      .filter((dispatch) => {
        if (dispatch.publishedAt !== undefined || dispatch.availableAt > now) return false;
        const execution = this.getRequiredExecution(dispatch.executionId);
        if (isTerminalWorkflowStatus(execution.status) || execution.pausedAt !== undefined) return false;
        if (!execution.cancellationRequested) return true;

        // Only compensation commands recorded after cancellation are still runnable.
        const history = this.getRequiredHistory(dispatch.executionId);
        const cancellation = history.find((event) => event.type === "cancellation-requested");
        return cancellation !== undefined && history.some((event) =>
          event.type === "command-scheduled" && event.sequence === dispatch.sequence
          && event.eventIndex > cancellation.eventIndex);
      })
      .sort((left, right) =>
        left.availableAt.getTime() - right.availableAt.getTime())
      .slice(0, request.limit);

    const reservations = selected.map((dispatch) => ({ dispatch, reservationToken: this.createReservationToken() }));
    return reservations.map(({ dispatch, reservationToken }) => {
      dispatch.attempt += 1;
      dispatch.reservedAt = now;
      dispatch.reservationToken = reservationToken;
      dispatch.availableAt = new Date(now.getTime() + request.leaseMs);
      const { historyGeneration } = this.getRequiredExecution(dispatch.executionId);
      return cloneDispatch(dispatch, historyGeneration, reservationToken, now);
    });
  }

  public async markActivityDispatchesPublished(
    reservations: readonly WorkflowActivityDispatchReservationRef[],
  ): Promise<readonly WorkflowActivityDispatchReservationRef[]> {
    return this.mutateOwnedDispatches(reservations, (dispatch) => {
      dispatch.publishedAt = this.now();
      delete dispatch.reservedAt;
      delete dispatch.reservationToken;
    });
  }

  public async retryActivityDispatches(
    requests: readonly RetryWorkflowActivityDispatchRequest[],
  ): Promise<readonly WorkflowActivityDispatchReservationRef[]> {
    return this.mutateOwnedDispatches(requests, (dispatch, request) => {
      dispatch.availableAt = new Date(request.retryAt);
      delete dispatch.reservedAt;
      delete dispatch.reservationToken;
    });
  }

  public async completeExternalActivity(
    request: CompleteExternalWorkflowActivityRequest,
  ): Promise<boolean> {
    const execution = this.executions.get(request.executionId);
    if (execution === undefined) return false;
    // Results written by an older generation may be retried until the Worker acknowledges them.
    const historyGeneration = request.historyGeneration ?? 1;
    if (historyGeneration !== execution.historyGeneration) {
      if (request.historyGeneration !== undefined || request.dispatchId === undefined) {
        return historyGeneration < execution.historyGeneration;
      }
      // An unversioned job from before an upgrade must prove it belongs to the current outbox.
      const dispatch = this.dispatches.get(request.dispatchId);
      if (dispatch?.executionId !== request.executionId || dispatch.sequence !== request.sequence) return true;
    }
    const history = this.getRequiredHistory(request.executionId);
    const existing = history.some((event) =>
      event.type === "command-completed" && event.sequence === request.sequence);

    if (existing) return true;

    const scheduled = history.some((event) =>
      event.type === "command-scheduled"
      && event.kind === "activity"
      && event.sequence === request.sequence);
    if (isTerminalWorkflowStatus(execution.status)) return true;
    if (!scheduled) return false;

    const now = this.now();
    const completionOrder = history.filter(
      (event) => event.type === "command-completed",
    ).length;
    const event: WorkflowCommandCompletedEvent = {
      type: "command-completed",
      eventIndex: execution.revision,
      sequence: request.sequence,
      completionOrder,
      sourceId: request.sourceId,
      ...(request.status === "completed"
        ? request.result === undefined
          ? {}
          : { result: cloneWorkflowPayload(request.result) }
        : { error: cloneWorkflowError(request.error) }),
      occurredAt: now,
    };
    // An external result is acknowledged only after its wake-up can be queued.
    this.enqueueWorkflowTask(request.executionId, now);
    history.push(event);
    execution.revision += 1;
    execution.status = "queued";
    execution.updatedAt = now;
    return true;
  }

  public async retryTask(request: RetryWorkflowTaskRequest): Promise<boolean> {
    const task = this.getOwnedTask(request);

    if (task === undefined || task.kind !== "activity") {
      return false;
    }

    task.availableAt = new Date(request.retryAt);
    delete task.reservedAt;
    delete task.reservationToken;
    return true;
  }

  public async requestCancellation(executionId: string): Promise<boolean> {
    const execution = this.getRequiredExecution(executionId);
    if (execution.cancellationRequested || isTerminalWorkflowStatus(execution.status)) return false;
    this.prepareCancellation([execution], this.now())();
    return true;
  }

  public async setPaused(executionId: string, paused: boolean): Promise<boolean> {
    const execution = this.getRequiredExecution(executionId);
    if (isTerminalWorkflowStatus(execution.status)) return false;
    if ((execution.pausedAt !== undefined) === paused) return false;

    const now = this.now();
    // A failed resume must retain its pause until replay can be scheduled.
    const wake = !paused && execution.concurrencyAdmitted ? this.prepareWorkflowTask(executionId, now) : undefined;
    execution.updatedAt = now;
    if (paused) {
      execution.pausedAt = now;
    } else {
      delete execution.pausedAt;
      if (wake !== undefined) this.tasks.set(wake.id, wake);
    }
    return true;
  }

  public async forceTerminate(
    executionId: string,
    reason = "Terminated by an operator.",
  ): Promise<boolean> {
    const root = this.getRequiredExecution(executionId);
    const pending = [root];
    const visited = new Set<string>();
    const terminated: { execution: WorkflowExecution; completedAt: Date }[] = [];
    // Visit closed descendants as well. An iterative walk uses one cycle guard
    // across the whole tree and avoids recursive promises on deep lineages.
    while (pending.length > 0) {
      const execution = pending.pop()!;
      const id = execution.executionId;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const child of this.executions.values()) {
        if (child.parentExecutionId === id) pending.push(child);
      }
      if (!isTerminalWorkflowStatus(execution.status)) terminated.push({ execution, completedAt: this.now() });
    }
    const first = terminated[0];
    const changedRoot = first?.execution === root;
    const completeParent = changedRoot
      ? this.prepareParentCompletion(root, first.completedAt, undefined, visited) : undefined;
    for (const { execution, completedAt } of terminated) {
      execution.status = "terminated";
      execution.error = { name: "WorkflowExecutionTerminatedError", message: reason };
      execution.updatedAt = completedAt;
      execution.completedAt = completedAt;
      delete execution.pausedAt;
      this.deleteExecutionTasks(execution.executionId);
      for (const [dispatchId, dispatch] of this.dispatches) {
        if (dispatch.executionId === execution.executionId) this.dispatches.delete(dispatchId);
      }
    }
    completeParent?.();
    // Every descendant is terminal before its permit can wake another execution.
    for (const { execution, completedAt } of terminated.reverse()) {
      this.releaseConcurrency(execution, completedAt);
      this.resolveTerminalWaiters(execution);
    }
    return changedRoot;
  }

  public async retryExecution(
    request: RetryWorkflowExecutionRequest,
  ): Promise<StartWorkflowExecutionResult> {
    // Keep cleanup tied to the acquired identity even if caller-owned input changes later.
    const { executionId, sourceExecutionId, workflowVersion } = request;
    const pending = this.pendingExecutionRetries.get(executionId);
    if (pending !== undefined) {
      if (pending.sourceExecutionId !== sourceExecutionId) {
        throw new WorkflowExecutionConflictError(executionId);
      }
      const result = await pending.result;
      return { execution: cloneExecution(result.execution), created: false };
    }

    // Publish ownership before starting work: ID generation can synchronously
    // reenter, and start() publishes a target before its retry link is ready.
    const completion = Promise.withResolvers<StartWorkflowExecutionResult>();
    const entry = { sourceExecutionId, result: completion.promise };
    this.pendingExecutionRetries.set(executionId, entry);
    // Concurrent callers join this entry. Only its completion can remove it.
    const clear = () => { this.pendingExecutionRetries.delete(executionId); };
    void this.createRetriedExecution({ executionId, sourceExecutionId, workflowVersion }).then((result) => {
      clear();
      completion.resolve(result);
    }, (error: unknown) => {
      clear();
      completion.reject(error);
    });
    return completion.promise;
  }

  private async createRetriedExecution(
    request: RetryWorkflowExecutionRequest,
  ): Promise<StartWorkflowExecutionResult> {
    validateExecutionId(request.executionId);
    const source = this.getRequiredExecution(request.sourceExecutionId);
    if (source.status !== "failed") {
      throw new TypeError("Only failed workflow executions can be retried.");
    }
    const existing = this.executions.get(request.executionId);
    if (existing !== undefined) {
      if (existing.retryOfExecutionId !== source.executionId) {
        throw new WorkflowExecutionConflictError(request.executionId);
      }
      return { execution: cloneExecution(existing), created: false };
    }

    // An operator retry owns a new identity even when ordinary starts reject
    // or return an existing keyed execution. Admission still waits for capacity.
    const concurrency = source.concurrency === undefined
      ? undefined
      : cloneConcurrency(source.concurrency);
    if (concurrency?.keyed !== undefined) concurrency.keyed.conflict = "enqueue";
    const result = await this.start({
      executionId: request.executionId,
      workflowName: source.workflowName,
      workflowVersion: request.workflowVersion,
      input: cloneWorkflowPayload(this.initialInputs.get(source.executionId)!),
      ...(concurrency === undefined ? {} : { concurrency }),
    });
    const created = this.getRequiredExecution(result.execution.executionId);
    // The admission override is transient; retain the original policy for audit and later retries.
    if (source.concurrency !== undefined) created.concurrency = cloneConcurrency(source.concurrency);
    created.retryOfExecutionId = source.executionId;
    return { execution: cloneExecution(created), created: result.created };
  }

  public async releaseTasks(
    reservations: readonly WorkflowTaskReservationRef[],
  ): Promise<readonly WorkflowTaskReservationRef[]> {
    return this.mutateOwnedTasks(reservations, (task) => {
      task.availableAt = this.now();
      delete task.reservedAt;
      delete task.reservationToken;

      if (task.kind === "workflow") {
        const execution = this.getRequiredExecution(task.executionId);
        execution.status = "queued";
        execution.updatedAt = this.now();
      }
    });
  }

  public async extendTaskLeases(
    reservations: readonly ExtendWorkflowTaskLeaseRequest[],
  ): Promise<readonly WorkflowTaskReservationRef[]> {
    const updates: { task: StoredWorkflowTask; availableAt: Date; reference: WorkflowTaskReservationRef }[] = [];
    // Match PostgreSQL's batch behavior: invalid owned requests cannot leave a partial extension.
    for (const reservation of reservations) {
      const task = this.getOwnedTask(reservation);
      if (task === undefined) continue;
      if (!Number.isSafeInteger(reservation.leaseMs) || reservation.leaseMs < 1) {
        throw new TypeError("Workflow task leaseMs must be a positive integer.");
      }
      updates.push({ task, availableAt: new Date(this.now().getTime() + reservation.leaseMs),
        reference: { taskId: task.id, reservationToken: reservation.reservationToken } });
    }
    for (const { task, availableAt } of updates) task.availableAt = availableAt;
    return updates.map(({ reference }) => reference);
  }

  public async getHistory(
    executionId: string,
  ): Promise<readonly WorkflowHistoryEvent[]> {
    return cloneHistory(this.getRequiredHistory(executionId));
  }

  public async summarizeExecutionVersions(): Promise<
    readonly WorkflowExecutionVersionSummary[]
  > {
    const summaries = new Map<string, WorkflowExecutionVersionSummary>();

    for (const execution of this.executions.values()) {
      const key = [
        execution.workflowName,
        execution.workflowVersion,
        execution.status,
      ].join("\u0000");
      const summary = summaries.get(key) ?? {
        workflowName: execution.workflowName,
        workflowVersion: execution.workflowVersion,
        status: execution.status,
        count: 0,
      };
      summary.count += 1;
      summaries.set(key, summary);
    }

    return [...summaries.values()].sort(compareVersionSummaries);
  }

  public async recoverVersionBlockedExecution(
    request: RecoverVersionBlockedExecutionRequest,
  ): Promise<boolean> {
    const execution = this.executions.get(request.executionId);
    if (
      execution === undefined
      || execution.workflowName !== request.workflowName
      || execution.workflowVersion !== request.workflowVersion
      || execution.status !== "blocked"
      || execution.error?.name !== "WorkflowExecutionVersionUnsupportedError"
    ) {
      return false;
    }

    const now = this.now();
    // Preserve the blocked state if creating the recovery wake-up fails.
    const wake = this.prepareWorkflowTask(execution.executionId, now);
    execution.status = "queued";
    execution.updatedAt = now;
    delete execution.error;
    if (wake !== undefined) this.tasks.set(wake.id, wake);
    return true;
  }

  public async continueAsNew(
    request: ContinueWorkflowAsNewRequest,
  ): Promise<boolean> {
    const task = this.getOwnedTask(request);
    if (
      task === undefined
      || task.kind !== "workflow"
      || task.executionId !== request.executionId
    ) {
      return false;
    }
    const execution = this.getRequiredExecution(request.executionId);
    if (execution.revision !== request.expectedRevision) {
      throw new WorkflowJournalConflictError(
        request.executionId,
        request.expectedRevision,
        execution.revision,
      );
    }
    const history = this.getRequiredHistory(request.executionId);
    assertCommandsSettledBeforeContinuation(request.executionId, history);
    const now = this.now();
    const nextInput = cloneWorkflowPayload(request.input);
    // Keep the original activation available until its successor has an identity.
    const nextTaskId = this.createTaskId();
    const archives = this.historyArchives.get(request.executionId) ?? [];
    archives.push({
      executionId: request.executionId,
      historyGeneration: execution.historyGeneration,
      workflowVersion: execution.workflowVersion,
      input: cloneWorkflowPayload(execution.input),
      history: cloneHistory(history),
      continuedAt: now,
    });
    this.historyArchives.set(request.executionId, archives);

    this.deleteExecutionTasks(request.executionId);
    for (const [dispatchId, dispatch] of this.dispatches) {
      if (dispatch.executionId === request.executionId) {
        this.dispatches.delete(dispatchId);
      }
    }
    for (let index = this.signals.length - 1; index >= 0; index -= 1) {
      if (this.signals[index]!.executionId === request.executionId) {
        this.signals.splice(index, 1);
      }
    }
    this.signalsByExecutionAndKey.delete(request.executionId);

    this.histories.set(request.executionId, []);
    execution.workflowVersion = request.workflowVersion;
    execution.historyGeneration += 1;
    execution.input = nextInput;
    execution.revision = 0;
    execution.status = "queued";
    execution.cancellationRequested = false;
    execution.updatedAt = now;
    delete execution.output;
    delete execution.error;
    delete execution.completedAt;
    this.enqueueWorkflowTask(request.executionId, now, nextTaskId);
    return true;
  }

  public async getHistoryArchives(
    executionId: string,
  ): Promise<readonly WorkflowHistoryArchive[]> {
    this.getRequiredExecution(executionId);
    return (this.historyArchives.get(executionId) ?? []).map(cloneHistoryArchive);
  }

  /** Test/runtime seam that records a successful terminal result. */
  public completeExecution(
    executionId: string,
    output?: WorkflowPayload,
  ): boolean {
    return this.settleExecution(executionId, {
      status: "completed",
      ...(output === undefined ? {} : { output }),
    });
  }

  /** Test/runtime seam that records a failed terminal result. */
  public failExecution(
    executionId: string,
    error: WorkflowExecutionError,
  ): boolean {
    return this.settleExecution(executionId, { status: "failed", error });
  }

  /** Returns isolated signal copies for deterministic adapter tests. */
  public inspectSignals(executionId?: string): readonly StoredWorkflowSignal[] {
    return this.signals
      .filter((signal) =>
        executionId === undefined || signal.executionId === executionId)
      .map((signal) => ({
        ...signal,
        payload: cloneWorkflowPayload(signal.payload),
        receivedAt: new Date(signal.receivedAt),
      }));
  }

  /** Returns isolated task copies for adapter and scheduler tests. */
  public inspectTasks(): readonly StoredWorkflowTask[] {
    return [...this.tasks.values()].map((task) => ({
      ...task,
      ...(task.payload === undefined
        ? {}
        : { payload: cloneWorkflowPayload(task.payload) }),
      availableAt: new Date(task.availableAt),
      createdAt: new Date(task.createdAt),
      ...(task.reservedAt === undefined
        ? {}
        : { reservedAt: new Date(task.reservedAt) }),
    }));
  }

  /** Returns isolated outbox rows for transport tests and diagnostics. */
  public inspectActivityDispatches(): readonly StoredWorkflowActivityDispatch[] {
    return [...this.dispatches.values()].map((dispatch) => ({
      ...dispatch,
      payload: cloneWorkflowPayload(dispatch.payload),
      availableAt: new Date(dispatch.availableAt),
      createdAt: new Date(dispatch.createdAt),
      ...(dispatch.reservedAt === undefined ? {} : { reservedAt: new Date(dispatch.reservedAt) }),
      ...(dispatch.publishedAt === undefined ? {} : { publishedAt: new Date(dispatch.publishedAt) }),
    }));
  }

  private settleExecution(
    executionId: string,
    terminal:
      | { status: "completed"; output?: WorkflowPayload }
      | { status: "failed"; error: WorkflowExecutionError },
  ): boolean {
    const execution = this.getRequiredExecution(executionId);

    if (isTerminalWorkflowStatus(execution.status)) {
      return false;
    }

    const now = this.now();
    const completeParent = this.prepareParentCompletion(execution, now);
    const cancelChildren = this.prepareCancellation([...this.executions.values()]
      .filter((child) => child.parentExecutionId === executionId), now, executionId);
    execution.updatedAt = now;
    // The fixture shortcut must respect the same terminal invariants as activation.
    this.applyActivationOutcome(execution, terminal, now, completeParent, cancelChildren);
    return true;
  }

  private resolveTerminalWaiters(execution: WorkflowExecution): void {
    const waiters = this.terminalWaiters.get(execution.executionId);
    // A terminal execution no longer owns a waiter collection. Keep the
    // deletion's boolean result in the delivery path as the ownership check.
    if (!this.terminalWaiters.delete(execution.executionId)) return;
    for (const waiter of waiters!) waiter.resolve(cloneExecution(execution));
  }

  private applyActivationOutcome(
    execution: WorkflowExecution,
    outcome: CommitWorkflowActivationRequest["outcome"],
    now: Date,
    completeParent: (() => void) | undefined,
    cancelChildren: (() => void) | undefined,
  ): void {
    execution.status = outcome.status;

    // A successful or cancelled replay clears any diagnostic from a blocked activation.
    if (outcome.status === "failed" || outcome.status === "blocked") {
      execution.error = cloneWorkflowError(outcome.error);
    } else {
      delete execution.error;
    }
    if (outcome.status === "completed") {
      if (outcome.output === undefined) delete execution.output;
      else execution.output = cloneWorkflowPayload(outcome.output);
    }

    if (!isTerminalWorkflowStatus(outcome.status)) return;

    execution.completedAt = now;
    this.deleteExecutionTasks(execution.executionId);
    completeParent?.();
    cancelChildren?.();
    this.releaseConcurrency(execution, now);
    this.resolveTerminalWaiters(execution);
  }

  private enqueueWorkflowTask(executionId: string, now: Date, taskId?: string): void {
    const task = this.prepareWorkflowTask(executionId, now, taskId);
    if (task !== undefined) this.tasks.set(task.id, task);
  }

  /** Prepares the next wake-up without changing reservation or journal state. */
  private prepareWorkflowTask(executionId: string, now: Date, taskId?: string, replacedTaskId?: string): StoredWorkflowTask | undefined {
    const alreadyQueued = [...this.tasks.values()].some((task) =>
      task.executionId === executionId && task.kind === "workflow" && task.id !== replacedTaskId);

    if (alreadyQueued) {
      return undefined;
    }

    const id = taskId ?? this.createTaskId();
    return {
      id,
      executionId,
      kind: "workflow",
      attempt: 0,
      availableAt: now,
      createdAt: now,
    };
  }

  private incrementConcurrencyUsage(
    execution: WorkflowExecution,
    definitions: Map<string, number>,
    keys: Map<string, number>,
  ): void {
    definitions.set(
      execution.workflowName,
      (definitions.get(execution.workflowName) ?? 0) + 1,
    );

    const keyed = execution.concurrency?.keyed;
    if (keyed?.scope === "active-work") {
      const key = concurrencyMapKey(execution.workflowName, keyed.key);
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
  }

  /** Releases a retained keyed permit and admits queued executions in order. */
  private releaseConcurrency(execution: WorkflowExecution, now: Date): void {
    execution.concurrencyAdmitted = false;
    const keyed = execution.concurrency?.keyed;

    if (keyed?.scope !== "execution") return;
    const admission = { workflowName: execution.workflowName, key: keyed.key, limit: keyed.limit };
    const admissionKey = concurrencyMapKey(admission.workflowName, admission.key);
    try {
      this.admitPendingExecutions(admission, now);
      this.deferredAdmissions.delete(admissionKey);
    } catch {
      // Preserve the terminal result and retry its permit handoff on the next workflow poll.
      this.deferredAdmissions.set(admissionKey, admission);
    }
  }

  private retryDeferredAdmissions(now: Date): { error: unknown } | undefined {
    let failure: { error: unknown } | undefined;
    for (const [key, admission] of this.deferredAdmissions) {
      try {
        this.admitPendingExecutions(admission, now);
        this.deferredAdmissions.delete(key);
      } catch (error) {
        failure ??= { error };
      }
    }
    return failure;
  }

  private admitPendingExecutions({ workflowName, key, limit }: WorkflowAdmission, now: Date): void {
    const admitted = [...this.executions.values()].filter((candidate) =>
      candidate.workflowName === workflowName
      && candidate.concurrency?.keyed?.key === key
      && candidate.concurrencyAdmitted
      && !isTerminalWorkflowStatus(candidate.status)).length;
    const waiting = [...this.executions.values()]
      .filter((candidate) =>
        candidate.workflowName === workflowName
        && candidate.concurrency?.keyed?.key === key
        && candidate.status === "pending")
      .sort((left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime());

    // Prepare every wake-up before marking any pending execution as admitted.
    const promotions = waiting.slice(0, Math.max(0, limit - admitted)).map((candidate) => ({
      candidate, task: this.prepareWorkflowTask(candidate.executionId, now),
    }));
    for (const { candidate, task } of promotions) {
      candidate.concurrencyAdmitted = true;
      candidate.status = "queued";
      candidate.updatedAt = now;
      if (task !== undefined) this.tasks.set(task.id, task);
    }
  }

  private deleteExecutionTasks(executionId: string): void {
    for (const [taskId, task] of this.tasks) {
      if (task.executionId === executionId) {
        this.tasks.delete(taskId);
      }
    }
  }

  private enqueueActivityTask(
    id: string,
    executionId: string,
    command: CommitWorkflowActivationRequest["commands"][number],
    now: Date,
  ): void {
    if (this.activityDispatchMode === "outbox") {
      this.dispatches.set(id, {
        id,
        executionId,
        sequence: command.sequence,
        target: command.target,
        payload: cloneWorkflowPayload(command.payload),
        attempt: 0,
        availableAt: now,
        createdAt: now,
      });
      return;
    }

    this.tasks.set(id, {
      id,
      executionId,
      kind: "activity",
      commandSequence: command.sequence,
      target: command.target,
      payload: cloneWorkflowPayload(command.payload),
      attempt: 0,
      availableAt: now,
      createdAt: now,
    });
  }

  private mutateOwnedDispatches<
    Request extends WorkflowActivityDispatchReservationRef,
  >(
    requests: readonly Request[],
    mutation: (
      dispatch: StoredWorkflowActivityDispatch,
      request: Request,
    ) => void,
  ): readonly WorkflowActivityDispatchReservationRef[] {
    const applied: WorkflowActivityDispatchReservationRef[] = [];

    for (const request of requests) {
      const dispatch = this.dispatches.get(request.dispatchId);
      if (dispatch?.reservationToken !== request.reservationToken) continue;
      mutation(dispatch, request);
      applied.push({
        dispatchId: request.dispatchId,
        reservationToken: request.reservationToken,
      });
    }

    return applied;
  }

  private enqueueTimerTask(
    id: string,
    executionId: string,
    sequence: number,
    target: string,
    payload: WorkflowPayload,
    delayMs: number,
    now: Date,
  ): void {
    this.tasks.set(id, {
      id,
      executionId,
      kind: "timer",
      commandSequence: sequence,
      target,
      payload: cloneWorkflowPayload(payload),
      attempt: 0,
      availableAt: new Date(now.getTime() + delayMs),
      createdAt: now,
    });
  }

  private prepareCommand(
    execution: WorkflowExecution,
    command: CommitWorkflowActivationRequest["commands"][number],
    now: Date,
    stagedChildren: Map<string, WorkflowExecution>,
  ): () => void {
    if (command.kind === "activity") {
      const taskId = this.createTaskId();
      return () => {
        this.enqueueActivityTask(taskId, execution.executionId, command, now);
      };
    }

    if (command.kind === "timer") {
      const durationMs = readNumber(command.payload, "durationMs");
      const taskId = this.createTaskId();
      return () => {
        this.enqueueTimerTask(
          taskId,
          execution.executionId,
          command.sequence,
          "sleep",
          command.payload,
          durationMs,
          now,
        );
      };
    }

    if (command.kind === "signal") {
      const timeoutMs = readOptionalNumber(command.payload, "timeoutMs");
      if (timeoutMs === undefined) return () => {};
      const taskId = this.createTaskId();
      return () => {
        this.enqueueTimerTask(
          taskId,
          execution.executionId,
          command.sequence,
          `signal:${command.target}`,
          command.payload,
          timeoutMs,
          now,
        );
      };
    }

    if (command.kind === "capture") {
      return () => {
        this.appendCompletion(execution, command.sequence, now, command.captureError === undefined
          ? { result: command.payload }
          : { error: command.captureError });
      };
    }

    if (command.kind === "child") {
      return this.prepareChild(execution, command, now, stagedChildren);
    }

    throw new TypeError(`Unsupported workflow command kind "${command.kind}".`);
  }

  /** Matches buffered signals in command order without consuming them. */
  private matchBufferedSignals(
    executionId: string,
    history: readonly WorkflowHistoryEvent[],
    newCommands: CommitWorkflowActivationRequest["commands"],
  ): readonly { signal: StoredWorkflowSignal; sequence: number }[] {
    const completed = new Set(history
      .filter((event) => event.type === "command-completed")
      .map((event) => event.sequence));
    const commands = [...history.filter((event) => event.type === "command-scheduled"), ...newCommands];
    const matches: { signal: StoredWorkflowSignal; sequence: number }[] = [];
    const usedSignals = new Set<StoredWorkflowSignal>();

    for (const command of commands) {
      if (command.kind !== "signal" || completed.has(command.sequence)) continue;

      const signal = this.signals.find((candidate) =>
        candidate.executionId === executionId
        && candidate.name === command.target
        && candidate.consumedBySequence === undefined
        && !usedSignals.has(candidate));

      if (signal === undefined) continue;
      usedSignals.add(signal);
      matches.push({ signal, sequence: command.sequence });
    }

    return matches;
  }

  private appendCompletion(
    execution: WorkflowExecution,
    sequence: number,
    now: Date,
    completion: {
      result?: WorkflowPayload | undefined;
      error?: WorkflowExecutionError;
      sourceId?: string;
    },
  ): void {
    const history = this.getRequiredHistory(execution.executionId);
    const event: WorkflowCommandCompletedEvent = {
      type: "command-completed",
      eventIndex: execution.revision,
      sequence,
      completionOrder: history.filter(
        (candidate) => candidate.type === "command-completed",
      ).length,
      ...(completion.result === undefined
        ? {}
        : { result: cloneWorkflowPayload(completion.result) }),
      ...(completion.error === undefined
        ? {}
        : { error: cloneWorkflowError(completion.error) }),
      ...(completion.sourceId === undefined ? {} : { sourceId: completion.sourceId }),
      occurredAt: now,
    };
    history.push(event);
    execution.revision += 1;
  }

  private prepareChild(
    parent: WorkflowExecution,
    command: CommitWorkflowActivationRequest["commands"][number],
    now: Date,
    stagedChildren: Map<string, WorkflowExecution>,
  ): () => void {
    const childInput = readPayload(command.payload, "input");
    const version = readNumber(command.payload, "version");
    const requestedId = readOptionalString(command.payload, "executionId");
    const childId = requestedId ?? workflowCommandIdentity({
      executionId: parent.executionId,
      sequence: command.sequence,
      historyGeneration: parent.historyGeneration,
    });
    const existing = this.executions.get(childId) ?? stagedChildren.get(childId);

    if (existing !== undefined) {
      // A matching active child can still complete the command. A terminal
      // child from an archived generation cannot produce another completion.
      if (
        existing.workflowName !== command.target
        || existing.workflowVersion !== version
        || existing.parentExecutionId !== parent.executionId
        || existing.parentCommandSequence !== command.sequence
        || !isDeepStrictEqual(existing.input, childInput)
        || isTerminalWorkflowStatus(existing.status)
      ) {
        throw new WorkflowExecutionConflictError(childId);
      }
      return () => {};
    }

    const concurrency = readOptionalConcurrency(command.payload);
    const keyed = concurrency?.keyed;
    const concurrencyAdmitted = keyed?.scope !== "execution"
      || [...this.executions.values(), ...stagedChildren.values()].filter((candidate) =>
        candidate.workflowName === command.target
        && candidate.concurrency?.keyed?.key === keyed.key
        && candidate.concurrencyAdmitted
        && !isTerminalWorkflowStatus(candidate.status)).length < keyed.limit;
    const child: WorkflowExecution = {
      executionId: childId,
      workflowName: command.target,
      workflowVersion: version,
      historyGeneration: 1,
      input: cloneWorkflowPayload(childInput),
      status: concurrencyAdmitted ? "queued" : "pending",
      cancellationRequested: false,
      parentExecutionId: parent.executionId,
      parentCommandSequence: command.sequence,
      rootExecutionId: parent.rootExecutionId,
      ...(concurrency === undefined
        ? {}
        : { concurrency: cloneConcurrency(concurrency) }),
      concurrencyAdmitted,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const taskId = concurrencyAdmitted ? this.createTaskId() : undefined;
    stagedChildren.set(childId, child);
    return () => {
      this.executions.set(childId, child);
      this.initialInputs.set(childId, cloneWorkflowPayload(childInput));
      this.histories.set(childId, []);
      if (taskId !== undefined) this.enqueueWorkflowTask(childId, now, taskId);
    };
  }

  /** Allocates a parent's wake-up before settling its child or recording the result. */
  private prepareParentCompletion(
    child: WorkflowExecution,
    now: Date,
    prepareWake = (parentId: string) => this.prepareWorkflowTask(parentId, now),
    closedParentIds?: ReadonlySet<string>,
  ): (() => void) | undefined {
    const { parentExecutionId, parentCommandSequence } = child;
    if (parentExecutionId === undefined || parentCommandSequence === undefined || closedParentIds?.has(parentExecutionId)) return undefined;

    const parent = this.executions.get(parentExecutionId);

    // Low-level starts can retain a parent link after the parent has been removed.
    if (parent === undefined || parent === child || isTerminalWorkflowStatus(parent.status)) {
      return undefined;
    }

    const history = this.getRequiredHistory(parent.executionId);
    const alreadyCompleted = () => history.some(
      (event) => event.type === "command-completed"
        && event.sequence === parentCommandSequence,
    );
    // An already resolved low-level link can never need another wake allocation.
    if (alreadyCompleted()) return undefined;
    const wake = prepareWake(parent.executionId);
    return () => {
      // Two pending children in one cancellation batch can share a low-level parent link.
      if (isTerminalWorkflowStatus(parent.status) || alreadyCompleted()) return;
      const completion = child.status === "completed"
        ? { result: child.output }
        : { error: child.error ?? {
          // Failed activations and forced termination already persist their error.
          name: "WorkflowCancellationError",
          message: `Child workflow "${child.executionId}" cancelled.`,
          details: { executionId: child.executionId },
        } };
      this.appendCompletion(parent, parentCommandSequence, now, completion);
      parent.status = "queued";
      parent.updatedAt = now;
      if (wake !== undefined) this.tasks.set(wake.id, wake);
    };
  }

  /** Stages all wake-ups so cancellation of a lineage can be retried without partial state. */
  private prepareCancellation(roots: readonly WorkflowExecution[], now: Date, closingId?: string): () => void {
    const queue = [...roots];
    const seen = new Set<string>();
    const executions: WorkflowExecution[] = [];
    const wakes = new Map<string, StoredWorkflowTask | undefined>();
    const prepareWake = (executionId: string) => {
      if (!wakes.has(executionId)) wakes.set(executionId, this.prepareWorkflowTask(executionId, now));
      return wakes.get(executionId);
    };
    for (const execution of queue) {
      const id = execution.executionId;
      if (id === closingId || seen.has(id) || execution.cancellationRequested || isTerminalWorkflowStatus(execution.status)) continue;
      seen.add(id);
      executions.push(execution);
      for (const child of this.executions.values()) {
        if (child.parentExecutionId === id) queue.push(child);
      }
    }
    const closing = new Set(executions.filter((execution) => execution.status === "pending").map(({ executionId }) => executionId));
    const transitions = executions.map((execution) => {
      const pending = closing.has(execution.executionId);
      return {
        execution,
        pending,
        completeParent: pending && execution.parentExecutionId !== undefined
          && execution.parentExecutionId !== closingId && !closing.has(execution.parentExecutionId)
          ? this.prepareParentCompletion(execution, now, prepareWake)
          : undefined,
        wake: pending ? undefined : prepareWake(execution.executionId),
      };
    });
    return () => {
      for (const { execution, pending, completeParent, wake } of transitions) {
        const id = execution.executionId;
        const event: WorkflowCancellationRequestedEvent = {
          type: "cancellation-requested", eventIndex: execution.revision, occurredAt: now,
        };
        this.getRequiredHistory(id).push(event);
        execution.revision += 1;
        execution.cancellationRequested = true;
        execution.updatedAt = now;
        delete execution.pausedAt;
        execution.status = pending ? "cancelled" : "queued";
        for (const [taskId, task] of this.tasks) {
          if (task.executionId === id && task.kind !== "workflow") this.tasks.delete(taskId);
        }
        if (wake !== undefined) this.tasks.set(wake.id, wake);
        if (pending) {
          execution.completedAt = now;
          completeParent?.();
        }
      }
      // Pending descendants may use different configured limits from earlier
      // executions in their group. Recheck admission after marking them terminal.
      for (const { execution, pending } of transitions) {
        if (!pending) continue;
        this.releaseConcurrency(execution, now);
        this.resolveTerminalWaiters(execution);
      }
    };
  }

  private deleteCommandTasks(executionId: string, sequence: number): void {
    for (const [taskId, task] of this.tasks) {
      if (
        task.executionId === executionId
        && task.commandSequence === sequence
      ) {
        this.tasks.delete(taskId);
      }
    }
  }

  private getOwnedTask(
    reservation: WorkflowTaskReservationRef,
  ): StoredWorkflowTask | undefined {
    const task = this.tasks.get(reservation.taskId);
    return task?.reservationToken === reservation.reservationToken
      ? task
      : undefined;
  }

  private async mutateOwnedTasks<Request extends WorkflowTaskReservationRef>(
    reservations: readonly Request[],
    mutate: (task: StoredWorkflowTask, reservation: Request) => void,
  ): Promise<readonly WorkflowTaskReservationRef[]> {
    const changed: WorkflowTaskReservationRef[] = [];

    for (const reservation of reservations) {
      const task = this.getOwnedTask(reservation);

      if (task === undefined) {
        continue;
      }

      mutate(task, reservation);
      changed.push({
        taskId: reservation.taskId,
        reservationToken: reservation.reservationToken,
      });
    }

    return changed;
  }

  private getRequiredHistory(executionId: string): WorkflowHistoryEvent[] {
    const history = this.histories.get(executionId);

    if (history === undefined) {
      throw new WorkflowExecutionNotFoundError(executionId);
    }

    return history;
  }

  private getRequiredExecution(executionId: string): WorkflowExecution {
    const execution = this.executions.get(executionId);

    if (execution === undefined) {
      throw new WorkflowExecutionNotFoundError(executionId);
    }

    return execution;
  }
}

function compareVersionSummaries(
  left: WorkflowExecutionVersionSummary,
  right: WorkflowExecutionVersionSummary,
): number {
  return left.workflowName.localeCompare(right.workflowName)
    || left.workflowVersion - right.workflowVersion
    || left.status.localeCompare(right.status);
}

function compareExecutionsNewestFirst(
  left: WorkflowExecution,
  right: WorkflowExecution,
): number {
  return right.createdAt.getTime() - left.createdAt.getTime()
    || right.executionId.localeCompare(left.executionId);
}

function validateExecutionQuery(query: WorkflowExecutionQuery): void {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) {
    throw new TypeError("Workflow execution query limit must be between 1 and 200.");
  }
}

function assertCommandsSettledBeforeContinuation(
  executionId: string,
  history: readonly WorkflowHistoryEvent[],
): void {
  const completed = new Set(history
    .filter((event) => event.type === "command-completed")
    .map((event) => event.sequence));
  const pending = history.find((event): event is WorkflowCommandScheduledEvent =>
    event.type === "command-scheduled" && !completed.has(event.sequence));
  if (pending !== undefined) {
    throw new TypeError(
      `Workflow execution "${executionId}" cannot continue as new with pending command ${pending.sequence}.`,
    );
  }
}

function cloneHistoryArchive(
  archive: WorkflowHistoryArchive,
): WorkflowHistoryArchive {
  return {
    ...archive,
    input: cloneWorkflowPayload(archive.input),
    history: cloneHistory(archive.history),
    continuedAt: new Date(archive.continuedAt),
  };
}

function validateExecutionId(executionId: string): void {
  if (executionId.length === 0) {
    throw new TypeError("Workflow execution IDs cannot be empty.");
  }
}

function cloneExecution(execution: WorkflowExecution): WorkflowExecution {
  return {
    ...execution,
    input: cloneWorkflowPayload(execution.input),
    ...(execution.output === undefined
      ? {}
      : { output: cloneWorkflowPayload(execution.output) }),
    createdAt: new Date(execution.createdAt),
    updatedAt: new Date(execution.updatedAt),
    ...(execution.completedAt === undefined
      ? {}
      : { completedAt: new Date(execution.completedAt) }),
    ...(execution.pausedAt === undefined
      ? {}
      : { pausedAt: new Date(execution.pausedAt) }),
    ...(execution.error === undefined
      ? {}
      : { error: cloneWorkflowError(execution.error) }),
    ...(execution.concurrency === undefined
      ? {}
      : { concurrency: cloneConcurrency(execution.concurrency) }),
  };
}

function cloneConcurrency(
  concurrency: ResolvedWorkflowConcurrency,
): ResolvedWorkflowConcurrency {
  return {
    ...concurrency,
    ...(concurrency.keyed === undefined
      ? {}
      : { keyed: { ...concurrency.keyed } }),
  };
}

function toReservedTask(
  task: StoredWorkflowTask,
  execution: WorkflowExecution,
  reservationToken: string,
  reservedAt: Date,
): ReservedWorkflowTask {
  return {
    id: task.id,
    executionId: task.executionId,
    workflowName: execution.workflowName,
    workflowVersion: execution.workflowVersion,
    historyGeneration: execution.historyGeneration,
    rootExecutionId: execution.rootExecutionId,
    ...(execution.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: execution.parentExecutionId }),
    kind: task.kind,
    ...(task.commandSequence === undefined
      ? {}
      : { commandSequence: task.commandSequence }),
    ...(task.target === undefined ? {} : { target: task.target }),
    ...(task.payload === undefined
      ? {}
      : { payload: cloneWorkflowPayload(task.payload) }),
    attempt: task.attempt,
    availableAt: new Date(task.availableAt),
    reservedAt: new Date(reservedAt),
    reservationToken,
    createdAt: new Date(task.createdAt),
  };
}

function cloneHistory(
  history: readonly WorkflowHistoryEvent[],
): readonly WorkflowHistoryEvent[] {
  return history.map((event) => {
    const occurredAt = new Date(event.occurredAt);
    switch (event.type) {
      case "command-scheduled":
      case "signal-received":
        return { ...event, occurredAt, payload: cloneWorkflowPayload(event.payload) };
      case "command-completed":
        return {
          ...event,
          occurredAt,
          ...(event.result === undefined ? {} : { result: cloneWorkflowPayload(event.result) }),
          ...(event.error === undefined ? {} : { error: cloneWorkflowError(event.error) }),
        };
      case "cancellation-requested":
        return { ...event, occurredAt };
    }
  });
}

function cloneWorkflowError(
  error: WorkflowExecutionError,
): WorkflowExecutionError {
  return {
    ...error,
    ...(error.details === undefined
      ? {}
      : { details: { ...error.details } }),
  };
}

function readRecord(
  payload: WorkflowPayload,
  message = "Workflow command payload must be an object.",
): Readonly<Record<string, WorkflowPayload>> {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new TypeError(message);
  }

  return payload as Readonly<Record<string, WorkflowPayload>>;
}

function readNumber(payload: WorkflowPayload, key: string): number {
  const value = readRecord(payload)[key];

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Workflow command field "${key}" must be non-negative.`);
  }

  return value;
}

function readOptionalNumber(
  payload: WorkflowPayload,
  key: string,
): number | undefined {
  return readRecord(payload)[key] === undefined
    ? undefined
    : readNumber(payload, key);
}

function readOptionalString(
  payload: WorkflowPayload,
  key: string,
): string | undefined {
  const value = readRecord(payload)[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Workflow command field "${key}" must be non-empty.`);
  }

  return value;
}

function readPayload(payload: WorkflowPayload, key: string): WorkflowPayload {
  const value = readRecord(payload)[key];

  if (value === undefined) {
    throw new TypeError(`Workflow command field "${key}" is required.`);
  }

  return value;
}

function readOptionalConcurrency(
  payload: WorkflowPayload,
): ResolvedWorkflowConcurrency | undefined {
  const value = readRecord(payload).concurrency;

  if (value === undefined) return undefined;

  const record = readRecord(value, "Workflow child concurrency must be an object.");
  const definitionLimit = record.definitionLimit;
  const keyedValue = record.keyed;
  const keyed = keyedValue === undefined
    ? undefined
    : readResolvedKeyedConcurrency(keyedValue);

  if (definitionLimit !== undefined
    && (typeof definitionLimit !== "number"
      || !Number.isSafeInteger(definitionLimit)
      || definitionLimit < 1)) {
    throw new TypeError("Workflow definition concurrency limit is invalid.");
  }

  return {
    ...(definitionLimit === undefined ? {} : { definitionLimit }),
    ...(keyed === undefined ? {} : { keyed }),
  };
}

function readResolvedKeyedConcurrency(
  value: WorkflowPayload,
): NonNullable<ResolvedWorkflowConcurrency["keyed"]> {
  const record = readRecord(value, "Workflow keyed concurrency must be an object.");
  const { key, limit, conflict, scope } = record;

  if (typeof key !== "string" || key.length === 0
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1
    || (conflict !== "enqueue" && conflict !== "reject"
      && conflict !== "return-existing")
    || (scope !== "execution" && scope !== "active-work")) {
    throw new TypeError("Workflow keyed concurrency metadata is invalid.");
  }

  // Child calls always queue behind retained permits instead of attaching to
  // another execution, because their parent relationship must remain unique.
  return { key, limit, conflict: "enqueue", scope };
}

function hasConcurrencyCapacity(
  execution: WorkflowExecution,
  definitions: ReadonlyMap<string, number>,
  keys: ReadonlyMap<string, number>,
): boolean {
  const definitionLimit = execution.concurrency?.definitionLimit;

  if (definitionLimit !== undefined
    && (definitions.get(execution.workflowName) ?? 0) >= definitionLimit) {
    return false;
  }

  const keyed = execution.concurrency?.keyed;
  return keyed?.scope !== "active-work"
    || (keys.get(concurrencyMapKey(execution.workflowName, keyed.key)) ?? 0)
      < keyed.limit;
}

function concurrencyMapKey(workflowName: string, key: string): string {
  return JSON.stringify([workflowName, key]);
}

function validateReservationRequest(
  request: ReserveWorkflowTasksRequest,
): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
    throw new TypeError("Workflow task reservation limit must be positive.");
  }

  if (!Number.isSafeInteger(request.leaseMs) || request.leaseMs < 1) {
    throw new TypeError("Workflow task leaseMs must be positive.");
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Workflow activity dispatch ${name} must be positive.`);
  }
}

function cloneDispatch(
  dispatch: StoredWorkflowActivityDispatch,
  historyGeneration: number,
  reservationToken: string,
  reservedAt: Date,
): ReservedWorkflowActivityDispatch {
  return {
    id: dispatch.id,
    executionId: dispatch.executionId,
    historyGeneration,
    sequence: dispatch.sequence,
    target: dispatch.target,
    payload: cloneWorkflowPayload(dispatch.payload),
    attempt: dispatch.attempt,
    availableAt: new Date(dispatch.availableAt),
    reservedAt: new Date(reservedAt),
    reservationToken,
    createdAt: new Date(dispatch.createdAt),
  };
}

function isRunnableExecutionStatus(
  status: WorkflowExecution["status"],
): boolean {
  return status === "queued" || status === "running" || status === "waiting";
}
