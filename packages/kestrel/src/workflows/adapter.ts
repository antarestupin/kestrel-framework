import type { WorkflowExecutionError } from "./errors.js";
import type {
  WorkflowActivationSnapshot,
  WorkflowCommand,
  WorkflowHistoryEvent,
} from "./history.js";
import type { WorkflowPayload } from "./serialization.js";
import type { ResolvedWorkflowConcurrency } from "./concurrency.js";

export type WorkflowExecutionStatus =
  | "blocked"
  | "cancelled"
  | "cancelling"
  | "completed"
  | "failed"
  | "pending"
  | "queued"
  | "running"
  | "terminated"
  | "waiting";

export interface WorkflowExecution {
  executionId: string;
  workflowName: string;
  workflowVersion: number;
  /** Increments whenever continue-as-new rotates the replay history. */
  historyGeneration: number;
  input: WorkflowPayload;
  status: WorkflowExecutionStatus;
  output?: WorkflowPayload;
  error?: WorkflowExecutionError;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  cancellationRequested: boolean;
  /** Orthogonal operator hold that prevents new task reservations. */
  pausedAt?: Date;
  parentExecutionId?: string;
  parentCommandSequence?: number;
  rootExecutionId: string;
  /** Failed execution whose original input was used to create this run. */
  retryOfExecutionId?: string;
  concurrency?: ResolvedWorkflowConcurrency;
  concurrencyAdmitted: boolean;
  /** Optimistic journal revision used by replay activation commits. */
  revision: number;
}

/** Bounded operational search ordered from newest to oldest. */
export interface WorkflowExecutionQuery {
  /** Opaque timestamp/identity boundary returned by a previous page. */
  cursor?: string;
  limit: number;
  search?: string;
  workflowNames?: readonly string[];
  workflowVersions?: readonly number[];
  statuses?: readonly WorkflowExecutionStatus[];
  createdAfter?: Date;
  createdBefore?: Date;
  parentExecutionId?: string;
  rootExecutionId?: string;
  retryOfExecutionId?: string;
  paused?: boolean;
}

export interface WorkflowExecutionPage {
  readonly items: readonly WorkflowExecution[];
  /** Self-contained ordering boundary; remains valid after the boundary row is deleted. */
  readonly nextCursor?: string;
}

export interface RetryWorkflowExecutionRequest {
  sourceExecutionId: string;
  executionId: string;
  workflowVersion: number;
}

/** Aggregated storage inventory used by deployment and operator diagnostics. */
export interface WorkflowExecutionVersionSummary {
  workflowName: string;
  workflowVersion: number;
  status: WorkflowExecutionStatus;
  count: number;
}

export interface RecoverVersionBlockedExecutionRequest {
  executionId: string;
  workflowName: string;
  workflowVersion: number;
}

export interface ContinueWorkflowAsNewRequest extends WorkflowTaskReservationRef {
  executionId: string;
  expectedRevision: number;
  workflowVersion: number;
  input: WorkflowPayload;
}

export interface WorkflowHistoryArchive {
  executionId: string;
  historyGeneration: number;
  workflowVersion: number;
  input: WorkflowPayload;
  history: readonly WorkflowHistoryEvent[];
  continuedAt: Date;
}

export interface StartWorkflowExecutionRequest {
  executionId: string;
  workflowName: string;
  workflowVersion: number;
  input: WorkflowPayload;
  parentExecutionId?: string;
  parentCommandSequence?: number;
  rootExecutionId?: string;
  concurrency?: ResolvedWorkflowConcurrency;
}

export interface StartWorkflowExecutionResult {
  readonly execution: WorkflowExecution;
  readonly created: boolean;
}

export interface SendWorkflowSignalRequest {
  executionId: string;
  workflowName: string;
  signalName: string;
  payload: WorkflowPayload;
  idempotencyKey?: string;
}

export interface WorkflowSignalReceipt {
  id: string;
  accepted: boolean;
}

export type WorkflowTaskKind = "activity" | "timer" | "workflow";

/** A generation-owned runnable task reserved by one runtime instance. */
export interface ReservedWorkflowTask {
  id: string;
  executionId: string;
  /** Execution diagnostics projected by reservation to avoid a follow-up read. */
  workflowName: string;
  workflowVersion: number;
  historyGeneration: number;
  rootExecutionId: string;
  parentExecutionId?: string;
  kind: WorkflowTaskKind;
  commandSequence?: number;
  target?: string;
  payload?: WorkflowPayload;
  attempt: number;
  availableAt: Date;
  reservedAt: Date;
  reservationToken: string;
  createdAt: Date;
}

export interface ReserveWorkflowTasksRequest {
  kinds: readonly WorkflowTaskKind[];
  limit: number;
  leaseMs: number;
}

export interface WorkflowTaskReservationRef {
  taskId: string;
  reservationToken: string;
}

/** Snapshot loaded for one still-owned workflow activation reservation. */
export interface LoadedWorkflowActivation {
  taskId: string;
  snapshot: WorkflowActivationSnapshot;
}

export interface ExtendWorkflowTaskLeaseRequest
  extends WorkflowTaskReservationRef {
  leaseMs: number;
}

export interface RetryWorkflowTaskRequest extends WorkflowTaskReservationRef {
  retryAt: Date;
  error: WorkflowExecutionError;
}

export type WorkflowActivationOutcome =
  | { status: "blocked"; error: WorkflowExecutionError }
  | { status: "completed"; output?: WorkflowPayload }
  | { status: "cancelled" }
  | { status: "failed"; error: WorkflowExecutionError }
  | { status: "waiting" };

/** Atomic journal decisions produced by one reserved replay activation. */
export interface CommitWorkflowActivationRequest
  extends WorkflowTaskReservationRef {
  executionId: string;
  expectedRevision: number;
  commands: readonly WorkflowCommand[];
  outcome: WorkflowActivationOutcome;
}

export type CompleteWorkflowActivityRequest = WorkflowTaskReservationRef & {
  executionId: string;
  sequence: number;
} & (
  | { status: "completed"; result?: WorkflowPayload }
  | { status: "failed"; error: WorkflowExecutionError }
);

export type WorkflowActivityDispatchMode = "embedded" | "outbox";

/** Outbox row leased by one publisher independently from workflow replay. */
export interface ReservedWorkflowActivityDispatch {
  id: string;
  executionId: string;
  sequence: number;
  target: string;
  payload: WorkflowPayload;
  attempt: number;
  availableAt: Date;
  reservedAt: Date;
  reservationToken: string;
  createdAt: Date;
}

export interface WorkflowActivityDispatchReservationRef {
  dispatchId: string;
  reservationToken: string;
}

export interface ReserveWorkflowActivityDispatchesRequest {
  limit: number;
  leaseMs: number;
}

export interface RetryWorkflowActivityDispatchRequest
  extends WorkflowActivityDispatchReservationRef {
  retryAt: Date;
}

/** Idempotent result accepted from an external activity transport. */
export type CompleteExternalWorkflowActivityRequest = {
  executionId: string;
  sequence: number;
  sourceId: string;
} & (
  | { status: "completed"; result?: WorkflowPayload }
  | { status: "failed"; error: WorkflowExecutionError }
);

/** Storage boundary used by workflow clients before runtime scheduling exists. */
export interface WorkflowAdapter {
  readonly activityDispatchMode: WorkflowActivityDispatchMode;
  start(
    request: StartWorkflowExecutionRequest,
  ): Promise<StartWorkflowExecutionResult>;
  startMany(
    requests: readonly StartWorkflowExecutionRequest[],
  ): Promise<readonly StartWorkflowExecutionResult[]>;
  get(executionId: string): Promise<WorkflowExecution | undefined>;
  listExecutions(
    query: WorkflowExecutionQuery,
  ): Promise<WorkflowExecutionPage>;
  waitForTerminal(executionId: string): Promise<WorkflowExecution>;
  sendSignal(
    request: SendWorkflowSignalRequest,
  ): Promise<WorkflowSignalReceipt>;
  reserveTasks(
    request: ReserveWorkflowTasksRequest,
  ): Promise<readonly ReservedWorkflowTask[]>;
  loadActivations(
    reservations: readonly WorkflowTaskReservationRef[],
  ): Promise<readonly LoadedWorkflowActivation[]>;
  commitActivation(request: CommitWorkflowActivationRequest): Promise<boolean>;
  completeActivities(
    requests: readonly CompleteWorkflowActivityRequest[],
  ): Promise<readonly WorkflowTaskReservationRef[]>;
  reserveActivityDispatches(
    request: ReserveWorkflowActivityDispatchesRequest,
  ): Promise<readonly ReservedWorkflowActivityDispatch[]>;
  markActivityDispatchesPublished(
    reservations: readonly WorkflowActivityDispatchReservationRef[],
  ): Promise<readonly WorkflowActivityDispatchReservationRef[]>;
  retryActivityDispatches(
    requests: readonly RetryWorkflowActivityDispatchRequest[],
  ): Promise<readonly WorkflowActivityDispatchReservationRef[]>;
  completeExternalActivity(
    request: CompleteExternalWorkflowActivityRequest,
  ): Promise<boolean>;
  retryTask(request: RetryWorkflowTaskRequest): Promise<boolean>;
  requestCancellation(executionId: string): Promise<boolean>;
  /** Pauses or resumes future reservations without interrupting active work. */
  setPaused(executionId: string, paused: boolean): Promise<boolean>;
  /** Closes an execution immediately without running workflow compensation. */
  forceTerminate(executionId: string, reason?: string): Promise<boolean>;
  /** Starts a linked execution from a failed run's original input. */
  retryExecution(
    request: RetryWorkflowExecutionRequest,
  ): Promise<StartWorkflowExecutionResult>;
  releaseTasks(
    reservations: readonly WorkflowTaskReservationRef[],
  ): Promise<readonly WorkflowTaskReservationRef[]>;
  extendTaskLeases(
    reservations: readonly ExtendWorkflowTaskLeaseRequest[],
  ): Promise<readonly WorkflowTaskReservationRef[]>;
  /** Read-only history access used by diagnostics and replay fixtures. */
  getHistory(executionId: string): Promise<readonly WorkflowHistoryEvent[]>;
  /** Returns compact counts without loading execution payloads or histories. */
  summarizeExecutionVersions(): Promise<
    readonly WorkflowExecutionVersionSummary[]
  >;
  /** Requeues only a matching execution blocked by version incompatibility. */
  recoverVersionBlockedExecution(
    request: RecoverVersionBlockedExecutionRequest,
  ): Promise<boolean>;
  /** Atomically archives one completed generation and queues its successor. */
  continueAsNew(request: ContinueWorkflowAsNewRequest): Promise<boolean>;
  getHistoryArchives(
    executionId: string,
  ): Promise<readonly WorkflowHistoryArchive[]>;
}

export function isTerminalWorkflowStatus(
  status: WorkflowExecutionStatus,
): boolean {
  return status === "cancelled"
    || status === "completed"
    || status === "failed"
    || status === "terminated";
}
