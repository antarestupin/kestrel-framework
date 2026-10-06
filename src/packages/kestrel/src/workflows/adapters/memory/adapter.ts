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

/** Process-local workflow storage used by clients, tests, and phase one. */
export class MemoryWorkflowAdapter implements WorkflowAdapter {
  public readonly activityDispatchMode: WorkflowActivityDispatchMode;

  private readonly executions = new Map<string, WorkflowExecution>();

  /** Preserves start idempotency after current input rotates by generation. */
  private readonly initialInputs = new Map<string, WorkflowPayload>();

  private readonly signals: StoredWorkflowSignal[] = [];

  private readonly signalByIdempotencyKey = new Map<
    string,
    StoredWorkflowSignal
  >();

  private readonly terminalWaiters = new Map<string, Set<TerminalWaiter>>();

  private readonly histories = new Map<string, WorkflowHistoryEvent[]>();

  private readonly historyArchives = new Map<string, WorkflowHistoryArchive[]>();

  private readonly tasks = new Map<string, StoredWorkflowTask>();

  private readonly dispatches = new Map<string, StoredWorkflowActivityDispatch>();

  private readonly now: () => Date;

  private readonly createSignalId: () => string;

  private readonly createTaskId: () => string;

  private readonly createReservationToken: () => string;

  public constructor(options: MemoryWorkflowAdapterOptions = {}) {
    this.activityDispatchMode = options.activityDispatchMode ?? "embedded";
    this.now = options.now ?? (() => new Date());
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
    const now = this.now();

    for (const request of requests) {
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
      const atKeyLimit = keyed !== undefined
        && keyedExecutions.length >= keyed.limit;

      if (atKeyLimit && keyed?.conflict === "reject") {
        throw new WorkflowConcurrencyConflictError(
          request.workflowName,
          keyed.key,
        );
      }

      if (atKeyLimit && keyed?.conflict === "return-existing") {
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

    for (const execution of createdExecutions) {
      this.executions.set(execution.executionId, execution);
      this.initialInputs.set(
        execution.executionId,
        stagedInitialInputs.get(execution.executionId)!,
      );
      this.histories.set(execution.executionId, []);
      if (execution.concurrencyAdmitted) {
        this.enqueueWorkflowTask(execution.executionId, now);
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
    return {
      items: items.map(cloneExecution),
      ...(hasMore && items.length > 0
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
    const idempotencyMapKey = idempotencyKey === undefined
      ? undefined
      : `${request.executionId}\u0000${idempotencyKey}`;
    const existing = idempotencyMapKey === undefined
      ? undefined
      : this.signalByIdempotencyKey.get(idempotencyMapKey);

    if (existing !== undefined && idempotencyKey !== undefined) {
      if (
        existing.name !== request.signalName
        || !isDeepStrictEqual(existing.payload, request.payload)
      ) {
        throw new WorkflowSignalConflictError(
          request.executionId,
          idempotencyKey,
        );
      }

      return { id: existing.id, accepted: false };
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

    this.signals.push(signal);

    if (idempotencyMapKey !== undefined) {
      this.signalByIdempotencyKey.set(idempotencyMapKey, signal);
    }


    const history = this.getRequiredHistory(request.executionId);
    const event: WorkflowSignalReceivedEvent = {
      type: "signal-received",
      eventIndex: execution.revision,
      signalId: signal.id,
      name: signal.name,
      payload: cloneWorkflowPayload(signal.payload),
      occurredAt: new Date(signal.receivedAt),
    };
    history.push(event);
    execution.revision += 1;
    execution.updatedAt = this.now();
    if (execution.concurrencyAdmitted) {
      this.enqueueWorkflowTask(request.executionId, execution.updatedAt);
    }

    return { id: signal.id, accepted: true };
  }

  public async reserveTasks(
    request: ReserveWorkflowTasksRequest,
  ): Promise<readonly ReservedWorkflowTask[]> {
    validateReservationRequest(request);
    const now = this.now();
    const kinds = new Set(request.kinds);
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
    const selectedWorkflowExecutions = new Set<string>();
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

      if (
        task.kind === "workflow"
        && (
          selectedWorkflowExecutions.has(task.executionId)
          || this.hasLiveWorkflowReservation(task.executionId, now, task.id)
        )
      ) {
        continue;
      }

      const execution = this.getRequiredExecution(task.executionId);

      if (!hasConcurrencyCapacity(execution, definitionUsage, keyedUsage)) {
        continue;
      }

      selected.push(task);
      this.incrementConcurrencyUsage(execution, definitionUsage, keyedUsage);

      if (task.kind === "workflow") {
        selectedWorkflowExecutions.add(task.executionId);
      }
    }

    return selected.map((task) => {
      const execution = this.getRequiredExecution(task.executionId);
      const reservationToken = this.createReservationToken();
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

    let completedSynchronously = false;

    for (const [offset, command] of request.commands.entries()) {
      const expectedSequence = scheduledCount + offset;

      if (command.sequence !== expectedSequence) {
        throw new TypeError(
          `Expected workflow command sequence ${expectedSequence}, received ${command.sequence}.`,
        );
      }

      const event: WorkflowCommandScheduledEvent = {
        type: "command-scheduled",
        eventIndex: execution.revision,
        sequence: command.sequence,
        kind: command.kind,
        target: command.target,
        payload: cloneWorkflowPayload(command.payload),
        occurredAt: now,
      };
      history.push(event);
      execution.revision += 1;
      completedSynchronously = this.scheduleCommand(
        execution,
        command,
        now,
      ) || completedSynchronously;
    }

    completedSynchronously = this.consumeBufferedSignals(execution, now)
      || completedSynchronously;

    if (execution.cancellationRequested && request.commands.length > 0) {
      const firstNewSequence = request.commands[0]!.sequence;

      for (const [taskId, pending] of this.tasks) {
        if (
          pending.executionId === execution.executionId
          && pending.commandSequence !== undefined
          && pending.commandSequence < firstNewSequence
        ) {
          this.tasks.delete(taskId);
        }
      }
    }

    this.tasks.delete(task.id);
    execution.updatedAt = now;
    this.applyActivationOutcome(execution, request.outcome, now);

    if (
      completedSynchronously
      && !isTerminalWorkflowStatus(execution.status)
      && execution.status !== "blocked"
    ) {
      execution.status = "queued";
      this.enqueueWorkflowTask(execution.executionId, now);
    }
    return true;
  }

  public async completeActivities(
    requests: readonly CompleteWorkflowActivityRequest[],
  ): Promise<readonly WorkflowTaskReservationRef[]> {
    const completed: WorkflowTaskReservationRef[] = [];

    // Apply requests in buffer order so completion order remains deterministic.
    for (const request of requests) {
      if (this.completeActivity(request)) {
        completed.push({
          taskId: request.taskId,
          reservationToken: request.reservationToken,
        });
      }
    }

    return completed;
  }

  private completeActivity(
    request: CompleteWorkflowActivityRequest,
  ): boolean {
    const task = this.getOwnedTask(request);

    if (
      task === undefined
      || (task.kind !== "activity" && task.kind !== "timer")
      || task.executionId !== request.executionId
      || task.commandSequence !== request.sequence
    ) {
      return false;
    }

    const execution = this.getRequiredExecution(request.executionId);
    const history = this.getRequiredHistory(request.executionId);
    const scheduled = history.some((event) =>
      event.type === "command-scheduled"
      && event.sequence === request.sequence);

    if (!scheduled) {
      throw new Error(
        `Workflow execution "${request.executionId}" has no command ${request.sequence}.`,
      );
    }

    const now = this.now();
    const completionOrder = history.filter(
      (event) => event.type === "command-completed",
    ).length;
    const event: WorkflowCommandCompletedEvent = {
      type: "command-completed",
      eventIndex: execution.revision,
      sequence: request.sequence,
      completionOrder,
      ...(request.status === "completed"
        ? request.result === undefined
          ? {}
          : { result: cloneWorkflowPayload(request.result) }
        : { error: { ...request.error } }),
      occurredAt: now,
    };

    history.push(event);
    execution.revision += 1;
    execution.status = "queued";
    execution.updatedAt = now;
    this.tasks.delete(task.id);
    this.enqueueWorkflowTask(request.executionId, now);
    return true;
  }

  public async reserveActivityDispatches(
    request: ReserveWorkflowActivityDispatchesRequest,
  ): Promise<readonly ReservedWorkflowActivityDispatch[]> {
    validatePositiveInteger("limit", request.limit);
    validatePositiveInteger("leaseMs", request.leaseMs);
    const now = this.now();
    const selected = [...this.dispatches.values()]
      .filter((dispatch) =>
        dispatch.publishedAt === undefined
        && dispatch.availableAt <= now
        && !isTerminalWorkflowStatus(
          this.getRequiredExecution(dispatch.executionId).status,
        )
        && this.getRequiredExecution(dispatch.executionId).pausedAt === undefined)
      .sort((left, right) =>
        left.availableAt.getTime() - right.availableAt.getTime())
      .slice(0, request.limit);

    return selected.map((dispatch) => {
      const reservationToken = this.createReservationToken();
      dispatch.attempt += 1;
      dispatch.reservedAt = now;
      dispatch.reservationToken = reservationToken;
      dispatch.availableAt = new Date(now.getTime() + request.leaseMs);
      return cloneDispatch(dispatch, reservationToken, now);
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
    const execution = this.getRequiredExecution(request.executionId);
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
    history.push({
      type: "command-completed",
      eventIndex: execution.revision,
      sequence: request.sequence,
      completionOrder,
      sourceId: request.sourceId,
      ...(request.status === "completed"
        ? request.result === undefined
          ? {}
          : { result: cloneWorkflowPayload(request.result) }
        : { error: { ...request.error } }),
      occurredAt: now,
    });
    execution.revision += 1;
    execution.status = "queued";
    execution.updatedAt = now;
    this.enqueueWorkflowTask(request.executionId, now);
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

    if (isTerminalWorkflowStatus(execution.status) || execution.cancellationRequested) {
      return false;
    }

    const now = this.now();
    const event: WorkflowCancellationRequestedEvent = {
      type: "cancellation-requested",
      eventIndex: execution.revision,
      occurredAt: now,
    };
    this.getRequiredHistory(executionId).push(event);
    execution.revision += 1;
    execution.cancellationRequested = true;
    delete execution.pausedAt;

    if (execution.status === "pending") {
      execution.status = "cancelled";
      execution.completedAt = now;
      execution.updatedAt = now;
      this.resolveTerminalWaiters(execution);
      this.completeParentCommand(execution, now);
      this.releaseConcurrency(execution, now);
      return true;
    }

    execution.status = "queued";
    execution.updatedAt = now;
    for (const [taskId, pending] of this.tasks) {
      if (pending.executionId === executionId && pending.kind !== "workflow") {
        this.tasks.delete(taskId);
      }
    }
    this.enqueueWorkflowTask(executionId, now);

    for (const child of this.executions.values()) {
      if (
        child.parentExecutionId === executionId
        && !isTerminalWorkflowStatus(child.status)
      ) {
        await this.requestCancellation(child.executionId);
      }
    }

    return true;
  }

  public async setPaused(executionId: string, paused: boolean): Promise<boolean> {
    const execution = this.getRequiredExecution(executionId);
    if (isTerminalWorkflowStatus(execution.status)) return false;
    if ((execution.pausedAt !== undefined) === paused) return false;

    const now = this.now();
    execution.updatedAt = now;
    if (paused) {
      execution.pausedAt = now;
    } else {
      delete execution.pausedAt;
      if (execution.concurrencyAdmitted) {
        this.enqueueWorkflowTask(executionId, now);
      }
    }
    return true;
  }

  public async forceTerminate(
    executionId: string,
    reason = "Terminated by an operator.",
  ): Promise<boolean> {
    const execution = this.getRequiredExecution(executionId);
    if (isTerminalWorkflowStatus(execution.status)) return false;

    const now = this.now();
    execution.status = "terminated";
    execution.error = { name: "WorkflowExecutionTerminatedError", message: reason };
    execution.updatedAt = now;
    execution.completedAt = now;
    delete execution.pausedAt;
    this.deleteExecutionTasks(executionId);
    for (const [dispatchId, dispatch] of this.dispatches) {
      if (dispatch.executionId === executionId) this.dispatches.delete(dispatchId);
    }
    this.resolveTerminalWaiters(execution);
    this.completeParentCommand(execution, now);
    this.terminateOpenChildren(executionId, reason);
    this.releaseConcurrency(execution, now);
    return true;
  }

  public async retryExecution(
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

    const result = await this.start({
      executionId: request.executionId,
      workflowName: source.workflowName,
      workflowVersion: request.workflowVersion,
      input: cloneWorkflowPayload(this.initialInputs.get(source.executionId)!),
      ...(source.concurrency === undefined
        ? {}
        : { concurrency: cloneConcurrency(source.concurrency) }),
    });
    const created = this.getRequiredExecution(result.execution.executionId);
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
    return this.mutateOwnedTasks(reservations, (task, reservation) => {
      if (!Number.isSafeInteger(reservation.leaseMs) || reservation.leaseMs < 1) {
        throw new TypeError("Workflow task leaseMs must be a positive integer.");
      }

      task.availableAt = new Date(this.now().getTime() + reservation.leaseMs);
    });
  }

  public async getHistory(
    executionId: string,
  ): Promise<readonly WorkflowHistoryEvent[]> {
    this.getRequiredExecution(executionId);
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
    execution.status = "queued";
    execution.updatedAt = now;
    delete execution.error;
    this.enqueueWorkflowTask(execution.executionId, now);
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
    for (const key of this.signalByIdempotencyKey.keys()) {
      if (key.startsWith(`${request.executionId}\u0000`)) {
        this.signalByIdempotencyKey.delete(key);
      }
    }

    this.histories.set(request.executionId, []);
    execution.workflowVersion = request.workflowVersion;
    execution.historyGeneration += 1;
    execution.input = cloneWorkflowPayload(request.input);
    execution.revision = 0;
    execution.status = "queued";
    execution.cancellationRequested = false;
    execution.updatedAt = now;
    delete execution.output;
    delete execution.error;
    delete execution.completedAt;
    this.enqueueWorkflowTask(request.executionId, now);
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
    execution.status = terminal.status;
    execution.updatedAt = now;
    execution.completedAt = now;

    if (terminal.status === "completed") {
      if (terminal.output !== undefined) {
        execution.output = cloneWorkflowPayload(terminal.output);
      }
    } else {
      execution.error = cloneWorkflowError(terminal.error);
    }

    this.resolveTerminalWaiters(execution);
    return true;
  }

  private resolveTerminalWaiters(execution: WorkflowExecution): void {
    const waiters = this.terminalWaiters.get(execution.executionId);
    this.terminalWaiters.delete(execution.executionId);

    for (const waiter of waiters ?? []) {
      waiter.resolve(cloneExecution(execution));
    }
  }

  private applyActivationOutcome(
    execution: WorkflowExecution,
    outcome: CommitWorkflowActivationRequest["outcome"],
    now: Date,
  ): void {
    execution.status = outcome.status;

    if (outcome.status === "completed") {
      if (outcome.output !== undefined) {
        execution.output = cloneWorkflowPayload(outcome.output);
      }
      execution.completedAt = now;
      this.deleteExecutionTasks(execution.executionId);
      this.resolveTerminalWaiters(execution);
      this.completeParentCommand(execution, now);
      this.cancelOpenChildren(execution.executionId);
      this.releaseConcurrency(execution, now);
    } else if (outcome.status === "cancelled") {
      execution.completedAt = now;
      this.deleteExecutionTasks(execution.executionId);
      this.resolveTerminalWaiters(execution);
      this.completeParentCommand(execution, now);
      this.cancelOpenChildren(execution.executionId);
      this.releaseConcurrency(execution, now);
    } else if (outcome.status === "failed" || outcome.status === "blocked") {
      execution.error = cloneWorkflowError(outcome.error);

      if (outcome.status === "failed") {
        execution.completedAt = now;
        this.deleteExecutionTasks(execution.executionId);
        this.resolveTerminalWaiters(execution);
        this.completeParentCommand(execution, now);
        this.cancelOpenChildren(execution.executionId);
        this.releaseConcurrency(execution, now);
      }
    }
  }

  private enqueueWorkflowTask(executionId: string, now: Date): void {
    const alreadyQueued = [...this.tasks.values()].some((task) =>
      task.executionId === executionId && task.kind === "workflow");

    if (alreadyQueued) {
      return;
    }

    const id = this.createTaskId();
    this.tasks.set(id, {
      id,
      executionId,
      kind: "workflow",
      attempt: 0,
      availableAt: now,
      createdAt: now,
    });
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
    const admitted = [...this.executions.values()].filter((candidate) =>
      candidate.workflowName === execution.workflowName
      && candidate.concurrency?.keyed?.key === keyed.key
      && candidate.concurrencyAdmitted
      && !isTerminalWorkflowStatus(candidate.status)).length;
    const waiting = [...this.executions.values()]
      .filter((candidate) =>
        candidate.workflowName === execution.workflowName
        && candidate.concurrency?.keyed?.key === keyed.key
        && candidate.status === "pending")
      .sort((left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime());

    for (const candidate of waiting.slice(0, Math.max(0, keyed.limit - admitted))) {
      candidate.concurrencyAdmitted = true;
      candidate.status = "queued";
      candidate.updatedAt = now;
      this.enqueueWorkflowTask(candidate.executionId, now);
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
    executionId: string,
    command: CommitWorkflowActivationRequest["commands"][number],
    now: Date,
  ): void {
    const id = this.createTaskId();

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
    executionId: string,
    sequence: number,
    target: string,
    payload: WorkflowPayload,
    delayMs: number,
    now: Date,
  ): void {
    const id = this.createTaskId();
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

  private scheduleCommand(
    execution: WorkflowExecution,
    command: CommitWorkflowActivationRequest["commands"][number],
    now: Date,
  ): boolean {
    if (command.kind === "activity") {
      this.enqueueActivityTask(execution.executionId, command, now);
      return false;
    }

    if (command.kind === "timer") {
      const durationMs = readNumber(command.payload, "durationMs");
      this.enqueueTimerTask(
        execution.executionId,
        command.sequence,
        "sleep",
        command.payload,
        durationMs,
        now,
      );
      return false;
    }

    if (command.kind === "signal") {
      const timeoutMs = readOptionalNumber(command.payload, "timeoutMs");

      if (timeoutMs !== undefined) {
        this.enqueueTimerTask(
          execution.executionId,
          command.sequence,
          `signal:${command.target}`,
          command.payload,
          timeoutMs,
          now,
        );
      }

      return false;
    }

    if (command.kind === "capture") {
      this.appendCompletion(execution, command.sequence, now, {
        result: command.payload,
      });
      return true;
    }

    if (command.kind === "child") {
      this.startChild(execution, command, now);
      return false;
    }

    throw new TypeError(`Unsupported workflow command kind "${command.kind}".`);
  }

  private consumeBufferedSignals(
    execution: WorkflowExecution,
    now: Date,
  ): boolean {
    const history = this.getRequiredHistory(execution.executionId);
    const completed = new Set(history
      .filter((event) => event.type === "command-completed")
      .map((event) => event.sequence));
    let consumed = false;

    for (const command of history) {
      if (command.type !== "command-scheduled"
        || command.kind !== "signal"
        || completed.has(command.sequence)) {
        continue;
      }

      const signal = this.signals.find((candidate) =>
        candidate.executionId === execution.executionId
        && candidate.name === command.target
        && candidate.consumedBySequence === undefined);

      if (signal === undefined) {
        continue;
      }

      signal.consumedBySequence = command.sequence;
      this.appendCompletion(execution, command.sequence, now, {
        result: signal.payload,
        sourceId: signal.id,
      });
      this.deleteCommandTasks(execution.executionId, command.sequence);
      completed.add(command.sequence);
      consumed = true;
    }

    return consumed;
  }

  private appendCompletion(
    execution: WorkflowExecution,
    sequence: number,
    now: Date,
    completion: {
      result?: WorkflowPayload;
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

  private startChild(
    parent: WorkflowExecution,
    command: CommitWorkflowActivationRequest["commands"][number],
    now: Date,
  ): void {
    const childInput = readPayload(command.payload, "input");
    const version = readNumber(command.payload, "version");
    const requestedId = readOptionalString(command.payload, "executionId");
    const childId = requestedId ?? `${parent.executionId}:${command.sequence}`;
    const existing = this.executions.get(childId);

    if (existing !== undefined) {
      if (
        existing.parentExecutionId !== parent.executionId
        || existing.parentCommandSequence !== command.sequence
      ) {
        throw new WorkflowExecutionConflictError(childId);
      }
      return;
    }

    const concurrency = readOptionalConcurrency(command.payload);
    const keyed = concurrency?.keyed;
    const concurrencyAdmitted = keyed?.scope !== "execution"
      || [...this.executions.values()].filter((candidate) =>
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
    this.executions.set(childId, child);
    this.initialInputs.set(childId, cloneWorkflowPayload(childInput));
    this.histories.set(childId, []);
    if (concurrencyAdmitted) this.enqueueWorkflowTask(childId, now);
  }

  private completeParentCommand(child: WorkflowExecution, now: Date): void {
    if (
      child.parentExecutionId === undefined
      || child.parentCommandSequence === undefined
    ) {
      return;
    }

    const parent = this.getRequiredExecution(child.parentExecutionId);

    if (isTerminalWorkflowStatus(parent.status)) {
      return;
    }

    const alreadyCompleted = this.getRequiredHistory(parent.executionId).some(
      (event) => event.type === "command-completed"
        && event.sequence === child.parentCommandSequence,
    );

    if (alreadyCompleted) {
      return;
    }

    this.appendCompletion(parent, child.parentCommandSequence, now,
      child.status === "completed"
        ? child.output === undefined ? {} : { result: child.output }
        : {
            error: child.error ?? {
              name: child.status === "cancelled"
                ? "WorkflowCancellationError"
                : "Error",
              message: `Child workflow "${child.executionId}" ${child.status}.`,
              ...(child.status === "cancelled"
                ? { details: { executionId: child.executionId } }
                : {}),
            },
          });
    parent.status = "queued";
    parent.updatedAt = now;
    this.enqueueWorkflowTask(parent.executionId, now);
  }

  private cancelOpenChildren(parentExecutionId: string): void {
    for (const child of this.executions.values()) {
      if (
        child.parentExecutionId === parentExecutionId
        && !isTerminalWorkflowStatus(child.status)
      ) {
        void this.requestCancellation(child.executionId);
      }
    }
  }

  private terminateOpenChildren(parentExecutionId: string, reason: string): void {
    for (const child of this.executions.values()) {
      if (
        child.parentExecutionId === parentExecutionId
        && !isTerminalWorkflowStatus(child.status)
      ) {
        void this.forceTerminate(child.executionId, reason);
      }
    }
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

  private hasLiveWorkflowReservation(
    executionId: string,
    now: Date,
    excludedTaskId: string,
  ): boolean {
    return [...this.tasks.values()].some((task) =>
      task.id !== excludedTaskId
      && task.executionId === executionId
      && task.kind === "workflow"
      && task.reservationToken !== undefined
      && task.availableAt.getTime() > now.getTime());
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
  const pending = history.find((event) =>
    event.type === "command-scheduled" && !completed.has(event.sequence));
  if (pending !== undefined && pending.type === "command-scheduled") {
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
  return history.map((event) => ({
    ...event,
    occurredAt: new Date(event.occurredAt),
    ...(event.type === "command-scheduled"
      ? { payload: cloneWorkflowPayload(event.payload) }
      : event.type === "signal-received"
        ? { payload: cloneWorkflowPayload(event.payload) }
        : event.type !== "command-completed" || event.result === undefined
          ? {}
          : { result: cloneWorkflowPayload(event.result) }),
    ...(event.type === "command-completed" && event.error !== undefined
      ? { error: cloneWorkflowError(event.error) }
      : {}),
  }));
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

function readRecord(payload: WorkflowPayload): Readonly<Record<string, WorkflowPayload>> {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new TypeError("Workflow command payload must be an object.");
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
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Workflow child concurrency must be an object.");
  }

  const record = value as Readonly<Record<string, WorkflowPayload>>;
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
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Workflow keyed concurrency must be an object.");
  }

  const record = value as Readonly<Record<string, WorkflowPayload>>;
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
  return `${workflowName}\u0000${key}`;
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
  reservationToken: string,
  reservedAt: Date,
): ReservedWorkflowActivityDispatch {
  return {
    id: dispatch.id,
    executionId: dispatch.executionId,
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
