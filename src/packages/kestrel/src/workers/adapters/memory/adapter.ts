import { isDeepStrictEqual } from "node:util";

import { createUuid } from "../../../utils/uuid.js";
import { WorkerJobIdentityConflictError } from "../../errors.js";

import type {
  DeadLetterJob,
  DeadLetterJobRequest,
  DeferJobRequest,
  EnqueueJobRequest,
  ExtendJobLeaseRequest,
  JobReservationRef,
  ReservedJob,
  ReserveJobsRequest,
  RetryJobRequest,
  WorkerAdapter,
  WorkerAcknowledgementGrouping,
  WorkerJobCorrelation,
  WorkerJobError,
  WorkerQueueStatistics,
} from "../../types.js";

interface StoredJob {
  id: string;
  identity?: string;
  queue: string;
  payload: unknown;
  correlation?: WorkerJobCorrelation;
  groupId?: string;
  executionId?: string;
  attempt: number;
  availableAt: Date;
  reservedAt?: Date;
  reservationToken?: string;
  lastError?: WorkerJobError;
  createdAt: Date;
}

export interface MemoryWorkerAdapterOptions {
  now?: () => Date;
  createId?: () => string;
  createReservationToken?: () => string;
  acknowledgementGrouping?: WorkerAcknowledgementGrouping;
}

/** Deterministic process-local adapter used by tests and local composition. */
export class MemoryWorkerAdapter implements WorkerAdapter {
  public readonly acknowledgementGrouping: WorkerAcknowledgementGrouping;

  private readonly jobs = new Map<string, StoredJob>();

  private readonly deadLetters: DeadLetterJob[] = [];

  private readonly queueControls = new Map<string, boolean>();

  private readonly now: () => Date;

  private readonly createId: () => string;

  private readonly createReservationToken: () => string;

  public constructor(options: MemoryWorkerAdapterOptions = {}) {
    this.acknowledgementGrouping = options.acknowledgementGrouping ?? "global";
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? createUuid;
    this.createReservationToken = options.createReservationToken
      ?? createUuid;
  }

  public async enqueue<Payload>(
    requests: readonly EnqueueJobRequest<Payload>[],
  ): Promise<readonly string[]> {
    const now = this.now();
    const stagedJobs = new Map(this.jobs);
    const jobIds = requests.map((request) => {
      if (request.identity !== undefined) {
        const existing = [...stagedJobs.values()].find(
          (job) => job.identity === request.identity,
        );

        if (existing !== undefined) {
          if (!matchesIdentity(existing, request)) {
            throw new WorkerJobIdentityConflictError(request.identity);
          }

          return existing.id;
        }
      }

      const id = this.createId();
      stagedJobs.set(id, {
        id,
        ...(request.identity === undefined
          ? {}
          : { identity: request.identity }),
        queue: request.queue,
        payload: request.payload,
        ...(request.correlation === undefined
          ? {}
          : { correlation: request.correlation }),
        ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
        ...(request.executionId === undefined
          ? {}
          : { executionId: request.executionId }),
        attempt: 0,
        availableAt: request.availableAt ?? now,
        createdAt: now,
      });

      return id;
    });

    // Commit only after every identity in the batch has been validated.
    this.jobs.clear();
    for (const [id, job] of stagedJobs) this.jobs.set(id, job);

    return jobIds;
  }

  public async reserve(
    request: ReserveJobsRequest,
  ): Promise<readonly ReservedJob[]> {
    validateReserveRequest(request);
    const now = this.now();
    const selected: StoredJob[] = [];
    const selectedIds = new Set<string>();

    // First honor each queue allocation in scheduler order.
    for (const preference of request.queues) {
      const remaining = request.totalLimit - selected.length;

      if (remaining === 0) {
        break;
      }

      const candidates = this.readyJobs(preference.queue, now, selectedIds)
        .slice(0, Math.min(preference.reservationLimit, remaining));

      for (const job of candidates) {
        selected.push(job);
        selectedIds.add(job.id);
      }
    }

    // Fill allocations missed by empty queues without overflowing batch-only
    // queues whose handlers prioritize complete batches.
    for (const preference of request.queues) {
      if (!preference.allowOverflow || selected.length >= request.totalLimit) {
        continue;
      }

      const candidates = this.readyJobs(preference.queue, now, selectedIds)
        .slice(0, request.totalLimit - selected.length);

      for (const job of candidates) {
        selected.push(job);
        selectedIds.add(job.id);
      }
    }

    return selected.map((job) => {
      const reservationToken = this.createReservationToken();
      const availableAt = new Date(now.getTime() + request.leaseMs);
      job.attempt += 1;
      job.availableAt = availableAt;
      job.reservedAt = now;
      job.reservationToken = reservationToken;

      return toReservedJob(job, reservationToken, now);
    });
  }

  public async ack(
    jobs: readonly JobReservationRef[],
  ): Promise<readonly JobReservationRef[]> {
    return this.mutate(jobs, (stored) => {
      this.jobs.delete(stored.id);
    });
  }

  public async retry(
    jobs: readonly RetryJobRequest[],
  ): Promise<readonly JobReservationRef[]> {
    return this.mutate(jobs, (stored, request) => {
      stored.availableAt = request.retryAt;
      stored.lastError = request.error;
      delete stored.reservedAt;
      delete stored.reservationToken;
    });
  }

  public async defer(
    jobs: readonly DeferJobRequest[],
  ): Promise<readonly JobReservationRef[]> {
    return this.mutate(jobs, (stored, request) => {
      stored.availableAt = request.availableAt;
      stored.attempt = Math.max(0, stored.attempt - 1);
      delete stored.reservedAt;
      delete stored.reservationToken;
    });
  }

  public async deadLetter(
    jobs: readonly DeadLetterJobRequest[],
  ): Promise<readonly JobReservationRef[]> {
    return this.mutate(jobs, (stored, request) => {
      this.jobs.delete(stored.id);
      this.deadLetters.push({
        id: this.createId(),
        originalJobId: stored.id,
        ...(stored.identity === undefined ? {} : { identity: stored.identity }),
        queue: stored.queue,
        payload: stored.payload,
        ...(stored.correlation === undefined
          ? {}
          : { correlation: stored.correlation }),
        ...(stored.groupId === undefined ? {} : { groupId: stored.groupId }),
        ...(stored.executionId === undefined
          ? {}
          : { executionId: stored.executionId }),
        attempt: stored.attempt,
        error: request.error,
        createdAt: stored.createdAt,
        failedAt: this.now(),
      });
    });
  }

  public async release(
    jobs: readonly JobReservationRef[],
  ): Promise<readonly JobReservationRef[]> {
    return this.mutate(jobs, (stored) => {
      stored.availableAt = this.now();
      delete stored.reservedAt;
      delete stored.reservationToken;
    });
  }

  public async extendLease(
    jobs: readonly ExtendJobLeaseRequest[],
  ): Promise<readonly JobReservationRef[]> {
    return this.mutate(jobs, (stored, request) => {
      stored.availableAt = new Date(this.now().getTime() + request.leaseMs);
    });
  }

  public async listReadyQueues(
    queues: readonly string[],
  ): Promise<readonly string[]> {
    const now = this.now();

    return queues.filter((queue) =>
      this.isQueueEnabled(queue) && this.readyJobs(queue, now).length > 0
    );
  }

  public async listQueueStatistics(
    queues: readonly string[],
  ): Promise<readonly WorkerQueueStatistics[]> {
    const now = this.now().getTime();

    return queues.map((queue) => {
      const jobs = [...this.jobs.values()].filter((job) => job.queue === queue);

      return {
        queue,
        enabled: this.isQueueEnabled(queue),
        ready: jobs.filter((job) => job.availableAt.getTime() <= now).length,
        scheduled: jobs.filter((job) =>
          job.reservationToken === undefined && job.availableAt.getTime() > now
        ).length,
        reserved: jobs.filter((job) =>
          job.reservationToken !== undefined && job.availableAt.getTime() > now
        ).length,
      };
    });
  }

  public async setQueueEnabled(queue: string, enabled: boolean): Promise<void> {
    this.queueControls.set(queue, enabled);
  }

  /** Exposes immutable snapshots for adapter and scheduler tests. */
  public inspectJobs(): readonly Readonly<StoredJob>[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  /** Exposes immutable dead-letter snapshots for tests and local tooling. */
  public inspectDeadLetters(): readonly Readonly<DeadLetterJob>[] {
    return this.deadLetters.map((job) => ({ ...job }));
  }

  private readyJobs(
    queue: string,
    now: Date,
    excluded = new Set<string>(),
  ): StoredJob[] {
    return [...this.jobs.values()]
      .filter((job) =>
        job.queue === queue
        && job.availableAt.getTime() <= now.getTime()
        && !excluded.has(job.id)
      )
      .sort((left, right) =>
        left.availableAt.getTime() - right.availableAt.getTime()
        || left.id.localeCompare(right.id)
      );
  }

  private isQueueEnabled(queue: string): boolean {
    return this.queueControls.get(queue) ?? true;
  }

  private mutate<Request extends JobReservationRef>(
    requests: readonly Request[],
    mutation: (job: StoredJob, request: Request) => void,
  ): readonly JobReservationRef[] {
    const applied: JobReservationRef[] = [];

    for (const request of requests) {
      const job = this.jobs.get(request.jobId);

      if (job?.reservationToken !== request.reservationToken) {
        continue;
      }

      mutation(job, request);
      applied.push({
        jobId: request.jobId,
        reservationToken: request.reservationToken,
      });
    }

    return applied;
  }
}

function toReservedJob(
  job: StoredJob,
  reservationToken: string,
  reservedAt: Date,
): ReservedJob {
  return {
    id: job.id,
    ...(job.identity === undefined ? {} : { identity: job.identity }),
    queue: job.queue,
    payload: job.payload,
    ...(job.correlation === undefined
      ? {}
      : { correlation: job.correlation }),
    ...(job.groupId === undefined ? {} : { groupId: job.groupId }),
    ...(job.executionId === undefined ? {} : { executionId: job.executionId }),
    attempt: job.attempt,
    availableAt: job.availableAt,
    reservedAt,
    reservationToken,
    createdAt: job.createdAt,
  };
}

function matchesIdentity<Payload>(
  stored: StoredJob,
  request: EnqueueJobRequest<Payload>,
): boolean {
  return stored.queue === request.queue
    && stored.groupId === request.groupId
    && stored.executionId === request.executionId
    && isDeepStrictEqual(stored.payload, request.payload)
    && isDeepStrictEqual(stored.correlation, request.correlation);
}

function validateReserveRequest(request: ReserveJobsRequest): void {
  for (const [name, value] of [
    ["totalLimit", request.totalLimit],
    ["leaseMs", request.leaseMs],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }

  for (const preference of request.queues) {
    if (
      !Number.isInteger(preference.reservationLimit)
      || preference.reservationLimit <= 0
    ) {
      throw new TypeError("reservationLimit must be a positive integer.");
    }
  }
}
