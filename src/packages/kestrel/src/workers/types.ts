/** Serialized error retained with retrying and dead-letter jobs. */
export interface WorkerJobError {
  name: string;
  message: string;
  stack?: string;
}

/** Adapter-neutral metadata used to route a terminal job result to its owner. */
export interface WorkerJobCorrelation<Data = unknown> {
  namespace: string;
  id: string;
  data?: Data;
}

/** A job whose lease is currently owned by one scheduler. */
export interface ReservedJob<Payload = unknown> {
  id: string;
  /** Stable publisher identity used to make enqueue retries idempotent. */
  identity?: string;
  queue: string;
  payload: Payload;
  correlation?: WorkerJobCorrelation;
  groupId?: string;
  /** Requested execution id used only by the first reservation attempt. */
  executionId?: string;
  attempt: number;
  availableAt: Date;
  reservedAt: Date;
  reservationToken: string;
  createdAt: Date;
}

export interface EnqueueJobRequest<Payload = unknown> {
  /** Stable publisher identity. Reusing it with different content is invalid. */
  identity?: string;
  queue: string;
  payload: Payload;
  correlation?: WorkerJobCorrelation;
  availableAt?: Date;
  groupId?: string;
  /** Correlates the first worker invocation with its publisher. */
  executionId?: string;
}

/** Scheduler allocation for one queue in a reservation query. */
export interface QueueReservationPreference {
  queue: string;
  reservationLimit: number;
  allowOverflow: boolean;
}

export interface ReserveJobsRequest {
  queues: readonly QueueReservationPreference[];
  totalLimit: number;
  leaseMs: number;
}

/** Identifies one reservation generation, not merely the persistent job. */
export interface JobReservationRef {
  jobId: string;
  reservationToken: string;
}

export interface RetryJobRequest extends JobReservationRef {
  retryAt: Date;
  error: WorkerJobError;
}

/** Reschedules work that did not start without consuming an attempt. */
export interface DeferJobRequest extends JobReservationRef {
  availableAt: Date;
}

export interface DeadLetterJobRequest extends JobReservationRef {
  error: WorkerJobError;
}

export interface ExtendJobLeaseRequest extends JobReservationRef {
  leaseMs: number;
}

/** Determines whether one adapter ack call may span several queues. */
export type WorkerAcknowledgementGrouping = "global" | "queue";

/** Operational state and job counts exposed for one declared queue. */
export interface WorkerQueueStatistics {
  queue: string;
  enabled: boolean;
  ready: number;
  scheduled: number;
  reserved: number;
}

/** A job retained after its final confirmed failure. */
export interface DeadLetterJob<Payload = unknown> {
  id: string;
  originalJobId: string;
  identity?: string;
  queue: string;
  payload: Payload;
  correlation?: WorkerJobCorrelation;
  groupId?: string;
  executionId?: string;
  attempt: number;
  error: WorkerJobError;
  createdAt: Date;
  failedAt: Date;
}

/** Terminal result delivered before the queue reservation is acknowledged. */
export type WorkerCorrelatedCompletion = {
  jobId: string;
  identity?: string;
  correlation: WorkerJobCorrelation;
} & (
  | { status: "completed"; result?: unknown }
  | { status: "failed"; error: WorkerJobError }
);

/**
 * Storage boundary used by the scheduler.
 *
 * Every post-reservation mutation returns the reservation references it
 * actually changed. Missing references are stale and must be ignored.
 */
export interface WorkerAdapter {
  /** Defaults to global grouping when the backend has no queue restriction. */
  readonly acknowledgementGrouping?: WorkerAcknowledgementGrouping;
  enqueue<Payload>(
    requests: readonly EnqueueJobRequest<Payload>[],
  ): Promise<readonly string[]>;
  reserve(
    request: ReserveJobsRequest,
  ): Promise<readonly ReservedJob[]>;
  ack(
    jobs: readonly JobReservationRef[],
  ): Promise<readonly JobReservationRef[]>;
  retry(
    jobs: readonly RetryJobRequest[],
  ): Promise<readonly JobReservationRef[]>;
  defer(
    jobs: readonly DeferJobRequest[],
  ): Promise<readonly JobReservationRef[]>;
  deadLetter(
    jobs: readonly DeadLetterJobRequest[],
  ): Promise<readonly JobReservationRef[]>;
  release(
    jobs: readonly JobReservationRef[],
  ): Promise<readonly JobReservationRef[]>;
  extendLease(
    jobs: readonly ExtendJobLeaseRequest[],
  ): Promise<readonly JobReservationRef[]>;
  listReadyQueues(
    queues: readonly string[],
  ): Promise<readonly string[]>;
  listQueueStatistics(
    queues: readonly string[],
  ): Promise<readonly WorkerQueueStatistics[]>;
  setQueueEnabled(queue: string, enabled: boolean): Promise<void>;
}

/** Converts an arbitrary thrown value into bounded queue metadata. */
export function serializeWorkerError(
  error: unknown,
  maxStackLength = 8_000,
): WorkerJobError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined
        ? {}
        : { stack: error.stack.slice(0, maxStackLength) }),
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}
