import { addAbortListener } from "node:events";

import { parseSchema } from "../definitions/index.js";
import {
  type RuntimeApp,
  executionCompletedObservation,
  executionStartedObservation,
  getExecutionObservationError,
  getExecutionObservationContext,
  setExecutionLogContext,
  type ExecutionOutcome,
  type ExecutionScope,
} from "../app/index.js";
import { runAggregatedResult } from "../concurrency/index.js";
import {
  abortableDelay,
  startLeaseHeartbeat,
} from "../scheduling/index.js";
import {
  type Observer,
  observerDependency,
} from "../observability/index.js";
import {
  ThrottlingAcquisitionAbortedError,
  ThrottlingAcquisitionTimeoutError,
  ThrottlingBackendUnavailableError,
  ThrottlingClosedError,
  ThrottlingQueueFullError,
  ThrottlingRejectedError,
  type Throttling,
  type AdmissionPolicyDefinition,
  type ThrottlingCost,
  type ThrottlingFeedback,
  type ThrottlingPermit,
} from "../throttling/index.js";
import { WorkerAcknowledgementBuffer } from "./acknowledgement_buffer.js";
import { WorkerDeferralBuffer } from "./deferral_buffer.js";
import {
  WorkerBatchResultError,
  WorkerRetryError,
} from "./errors.js";
import {
  serializeWorkerError,
  type DeadLetterJobRequest,
  type DeferJobRequest,
  type JobReservationRef,
  type ReservedJob,
  type RetryJobRequest,
  type WorkerAdapter,
  type WorkerCorrelatedCompletion,
} from "./types.js";
import type {
  AnyWorker,
  WorkerBatchFailureData,
  WorkerThrottling,
  WorkerThrottlingRequirement,
} from "./worker.js";

export type WorkerShutdownBehavior = "expire" | "release" | "wait";

export interface WorkerSchedulerOptions {
  slots: number;
  leaseMs: number;
  reservationLimit?: number;
  pollIntervalMs?: number;
  readyQueueRefreshMs?: number;
  ackBufferSize?: number;
  ackFlushIntervalMs?: number;
  deferBufferSize?: number;
  deferFlushIntervalMs?: number;
  shutdownBehavior?: WorkerShutdownBehavior;
  now?: () => Date;
  monotonicNow?: () => number;
  reportError?: (error: unknown) => void;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  throttling?: Throttling;
  /** Advisory local-pressure gate checked before any queue storage read. */
  reservationPressure?: AdmissionPolicyDefinition;
  recordThrottlingDecision?: (decision: WorkerThrottlingDecision) => void;
  /** Persists a correlated terminal result before the queue transition. */
  completeCorrelatedJob?: (
    completion: WorkerCorrelatedCompletion,
  ) => Promise<void>;
}

export interface WorkerThrottlingDecision {
  worker: string;
  jobIds: readonly string[];
  result: "admitted" | "deferred" | "held" | "released";
  retryAt?: Date;
}

interface JobSuccess {
  kind: "success";
  job: ReservedJob;
  result?: unknown;
}

interface JobFailure {
  kind: "failure";
  job: ReservedJob;
  error: unknown;
  retryDelayMs?: number;
  maxAttempts?: number;
}

type JobOutcome = JobFailure | JobSuccess;

interface WorkerInvocationResult {
  outcomes: readonly JobOutcome[];
  interruption?: { error: unknown };
}

interface WorkerInvocation {
  readonly worker: AnyWorker;
  readonly jobs: readonly ReservedJob[];
  readonly executionId?: string;
}

interface CombinedRequirement {
  readonly admission: WorkerThrottlingRequirement["admission"];
  readonly estimatedCost: ThrottlingCost;
}

interface CycleAdmission {
  shutdownBehavior?: WorkerShutdownBehavior;
}

interface TrackedReservation {
  readonly job: ReservedJob;
  invocation?: AbortController;
}

/** Distinguishes reservation loss from cancellation of the whole scheduler. */
class WorkerReservationLostError extends Error {
  public constructor(jobId: string) {
    super(`Worker reservation lost for job "${jobId}".`);
  }
}

/**
 * Coordinates queue reservations and application-scoped worker executions.
 *
 * Scheduling policy stays backend-independent; ownership checks and atomic
 * transitions remain the adapter's responsibility.
 */
export class WorkerScheduler<Config> {
  private readonly workersByQueue = new Map<string, AnyWorker>();

  private readonly workerNames = new Set<string>();

  private readonly now: () => Date;

  private readonly sleep: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;

  private readonly reservationLimit: number;

  private readonly pollIntervalMs: number;

  private readonly readyQueueRefreshMs: number;

  private readonly monotonicNow: () => number;

  private readonly reportError: (error: unknown) => void;

  private readonly shutdownBehavior: WorkerShutdownBehavior;

  private readonly leasedJobs = new Map<string, TrackedReservation>();

  private readonly acknowledgements: WorkerAcknowledgementBuffer;

  private readonly deferrals: WorkerDeferralBuffer;

  private readonly handlerSlots: HandlerSlotGate;

  private readonly blockedJobs = new Map<string, number>();

  private readonly throttling: Throttling | undefined;

  private readonly reservationPressure: AdmissionPolicyDefinition | undefined;

  private readonly recordThrottlingDecision: (
    decision: WorkerThrottlingDecision,
  ) => void;

  private readonly completeCorrelatedJob: ((
    completion: WorkerCorrelatedCompletion,
  ) => Promise<void>) | undefined;

  private loopAbortController: AbortController | undefined;

  private handlerAbortController = new AbortController();

  private pollingLifetime: Promise<void> | undefined;

  private loopPromise: Promise<void> | undefined;

  private activeCycle: Promise<number> | undefined;

  private activeAdmission: CycleAdmission | undefined;

  private rotationOffset = 0;

  private readyQueues = new Set<string>();

  private nextReadyQueueRefreshAt = 0;

  public constructor(
    private readonly app: RuntimeApp<Config>,
    private readonly adapter: WorkerAdapter,
    private readonly workers: readonly AnyWorker[],
    private readonly options: WorkerSchedulerOptions,
  ) {
    validateSchedulerOptions(options);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableDelay;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.readyQueueRefreshMs = options.readyQueueRefreshMs ?? 1_000;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.reportError = options.reportError ?? (() => undefined);
    this.shutdownBehavior = options.shutdownBehavior ?? "wait";
    this.throttling = options.throttling;
    this.reservationPressure = options.reservationPressure;
    this.recordThrottlingDecision = options.recordThrottlingDecision
      ?? (() => undefined);
    this.completeCorrelatedJob = options.completeCorrelatedJob;
    this.handlerSlots = new HandlerSlotGate(options.slots);
    this.reservationLimit = options.reservationLimit
      ?? options.slots * Math.max(
        1,
        ...workers.map((worker) =>
          worker.batch === false ? 1 : worker.batch.size
        ),
      );
    this.acknowledgements = new WorkerAcknowledgementBuffer(adapter, {
      maxSize: options.ackBufferSize ?? 100,
      flushIntervalMs: options.ackFlushIntervalMs ?? 10,
      grouping: adapter.acknowledgementGrouping ?? "global",
      onAcknowledged: (jobs) => {
        for (const job of jobs) {
          this.forgetReservation(job);
        }
      },
    });
    this.deferrals = new WorkerDeferralBuffer(adapter, {
      maxSize: options.deferBufferSize ?? 100,
      flushIntervalMs: options.deferFlushIntervalMs ?? 10,
      onDeferred: (jobs) => { for (const job of jobs) this.forgetReservation(job); },
    });

    for (const worker of workers) {
      if (this.workerNames.has(worker.name)) {
        throw new TypeError(`Worker names must be unique: "${worker.name}".`);
      }

      if (this.workersByQueue.has(worker.queue)) {
        throw new TypeError(
          `Only one worker can consume queue "${worker.queue}".`,
        );
      }

      this.workerNames.add(worker.name);
      this.workersByQueue.set(worker.queue, worker);
    }
  }

  private get executionSignal(): AbortSignal {
    return AbortSignal.any([this.handlerAbortController.signal, this.app.shutdown.signal]);
  }

  /** Current polling lifetime; ordinary cycle failures retain existing recovery. */
  public get completion(): Promise<void> | undefined { return this.pollingLifetime; }

  /** Starts polling until stop is requested. */
  public start(): void {
    if (this.loopPromise !== undefined) {
      throw new Error("The worker scheduler is already running.");
    }

    // A one-shot cycle may already own the current handler cancellation signal.
    if (this.handlerAbortController.signal.aborted) this.handlerAbortController = new AbortController();
    this.loopAbortController = new AbortController();
    this.loopPromise = this.runLoop(this.loopAbortController.signal)
      .finally(() => {
        this.loopPromise = undefined;
        this.loopAbortController = undefined;
      });
    this.pollingLifetime = this.loopPromise;
    void this.loopPromise.catch(() => undefined);
  }

  /**
   * Stops polling according to the configured ownership behavior.
   *
   * Non-waiting modes abort cooperative handlers and return after optional
   * release; handlers ignoring the signal may continue until process exit.
   */
  public async stop(
    behavior: WorkerShutdownBehavior = this.shutdownBehavior,
  ): Promise<void> {
    // An in-flight storage call may return new reservations after polling stops.
    if (this.activeAdmission !== undefined) {
      this.activeAdmission.shutdownBehavior ??= behavior;
    }
    this.loopAbortController?.abort();

    if (behavior === "wait") {
      await (this.loopPromise ?? this.activeCycle);
      return;
    }

    this.handlerAbortController.abort();

    // Wait for both drains before releasing. A failed acknowledgement must not
    // overtake a peer deferral or prevent us from returning the remaining jobs.
    const drains = await Promise.allSettled([
      this.acknowledgements.flush(),
      this.deferrals.flush(),
    ]);
    const errors = drains.flatMap((drain) => drain.status === "rejected" ? [drain.reason as unknown] : []);

    if (behavior === "release") {
      const reservations = [...this.leasedJobs.values()].map(({ job }) => toReservationRef(job));
      try {
        await this.adapter.release(reservations);
        for (const reservation of reservations) this.forgetReservation(reservation);
      } catch (error) {
        errors.push(error);
      }
    }

    // Observe eventual failures even when shutdown deliberately does not wait.
    void this.loopPromise?.catch(() => undefined);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Several worker shutdown transitions failed.");
  }

  /** Performs one complete reserve, execute and flush cycle. */
  public runOnce(): Promise<number> {
    if (this.activeCycle !== undefined) {
      return this.activeCycle;
    }

    // Publish ownership before application or adapter callbacks can reenter.
    const admission: CycleAdmission = {};
    this.activeAdmission = admission;
    const cycle = Promise.resolve().then(() => this.executeCycle(admission)).finally(() => {
      if (this.activeCycle === cycle) {
        this.activeCycle = undefined;
        this.activeAdmission = undefined;
      }
    });
    this.activeCycle = cycle;

    return cycle;
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let handled = 0;

      try {
        handled = await this.runOnce();
      } catch (error) {
        // A transient backend failure must not permanently stop the process.
        // The bootstrap supplies structured logging through this callback.
        this.reportError(error);
      }

      if (handled === 0 && !signal.aborted) {
        try {
          await this.sleep(this.pollIntervalMs, signal);
        } catch (error) {
          if (!signal.aborted) {
            throw error;
          }
        }
      }
    }
  }

  private async executeCycle(admission: CycleAdmission): Promise<number> {
    if (this.workers.length === 0 || this.isAdmissionClosed(admission)) return 0;
    if (!await this.canReserveUnderPressure() || this.isAdmissionClosed(admission)) return 0;

    const orderedWorkers = rotate(this.workers, this.rotationOffset);
    this.rotationOffset = (this.rotationOffset + 1) % this.workers.length;
    const readyQueues = await this.getReadyQueues(orderedWorkers);
    const readyWorkers = orderedWorkers.filter((worker) =>
      readyQueues.has(worker.queue)
    );

    if (readyWorkers.length === 0 || this.isAdmissionClosed(admission)) return 0;

    const jobs = await this.adapter.reserve({
      queues: readyWorkers.map((worker) => ({
        queue: worker.queue,
        reservationLimit: getReservationAllocation(
          worker,
          this.options.slots,
        ),
        allowOverflow: worker.batch === false
          || worker.batch.allowOverflow,
      })),
      totalLimit: this.reservationLimit,
      leaseMs: this.options.leaseMs,
    });
    if (this.isAdmissionClosed(admission)) {
      await this.finishLateReservations(admission, jobs);
      return 0;
    }

    for (const job of jobs) {
      this.leasedJobs.set(job.id, { job });
    }

    const leaseExtensions = this.keepLeasesAlive(jobs);

    try {
      // An execution-scope failure must not end sibling handlers or their lease
      // protection. Drain all invocations and persist the outcomes that did finish.
      const invocations = await Promise.allSettled(
        this.createInvocations(jobs).map((invocation) =>
          this.runInvocation(invocation)),
      );
      const outcomes = invocations.flatMap((invocation) =>
        invocation.status === "fulfilled" ? invocation.value : []);
      const invocationErrors = invocations.flatMap((invocation) =>
        invocation.status === "rejected" ? [invocation.reason as unknown] : []);

      // Independent storage transitions can complete together at the cycle
      // boundary instead of serializing deferrals behind acknowledgements.
      const transitions = await Promise.allSettled([
        this.flushOutcomes(outcomes),
        this.deferrals.flush(),
      ]);
      // One failed buffer must not end lease maintenance while another is
      // still persisting outcomes or waiting for correlated result delivery.
      const errors = [...invocationErrors, ...transitions.flatMap((transition) =>
        transition.status === "rejected" ? [transition.reason as unknown] : [])];
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Several worker transitions failed.");
      }
    } finally {
      try {
        // Drain even if a correlated result handoff fails. Deferred jobs never
        // entered a handler and must not turn into ordinary worker retries.
        await this.deferrals.flush();
      } finally {
        try {
          await leaseExtensions.close();
        } finally {
          for (const job of jobs) this.forgetReservation(toReservationRef(job));
        }
      }
    }

    return jobs.length;
  }

  /** Avoids reserving jobs while a job-independent local gate is unavailable. */
  private async canReserveUnderPressure(): Promise<boolean> {
    if (this.reservationPressure === undefined) return true;

    // Construction validates that a reservation policy has a throttling facade.
    const availability = await this.throttling!.inspect(
      this.reservationPressure,
    );
    return availability.state === "available"
      || availability.state === "degraded";
  }

  private isAdmissionClosed(admission: CycleAdmission): boolean {
    return admission.shutdownBehavior !== undefined || this.executionSignal.aborted;
  }

  /** Leaves admissions that never entered a handler ready for another poller. */
  private async finishLateReservations(admission: CycleAdmission, jobs: readonly ReservedJob[]): Promise<void> {
    if (admission.shutdownBehavior !== "expire" && jobs.length > 0) {
      await this.adapter.release(jobs.map(toReservationRef));
    }
  }

  /** Refreshes the backend readiness hint independently from reservation pace. */
  private async getReadyQueues(
    workers: readonly AnyWorker[],
  ): Promise<ReadonlySet<string>> {
    const now = this.monotonicNow();

    if (now < this.nextReadyQueueRefreshAt) {
      return this.readyQueues;
    }

    this.readyQueues = new Set(await this.adapter.listReadyQueues(
      workers.map((worker) => worker.queue),
    ));
    this.nextReadyQueueRefreshAt = now + this.readyQueueRefreshMs;

    return this.readyQueues;
  }

  /** Extends buffered and running jobs in one non-overlapping adapter batch. */
  private keepLeasesAlive(
    jobs: readonly ReservedJob[],
  ): { close(): Promise<void> } {
    return startLeaseHeartbeat({
      signal: this.executionSignal,
      intervalMs: Math.max(1, Math.floor(this.options.leaseMs / 2)),
      extend: async () => {
        if (this.executionSignal.aborted) return;
        const ownedJobs = jobs.filter((job) => this.ownsJob(job));
        if (ownedJobs.length === 0) return;
        const renewed = await this.adapter.extendLease(ownedJobs.map((job) => ({
          ...toReservationRef(job),
          leaseMs: this.options.leaseMs,
        })));
        const renewedTokens = new Map(renewed.map(({ jobId, reservationToken }) => [jobId, reservationToken]));

        for (const job of ownedJobs) {
          if (renewedTokens.get(job.id) === job.reservationToken) continue;
          // A missing token confirms lost ownership. A completed acknowledgement
          // or deferral may already have removed it during this extension.
          const tracked = this.forgetReservation(toReservationRef(job));
          tracked?.invocation?.abort(new WorkerReservationLostError(job.id));
        }
      },
    });
  }

  private ownsJob(job: ReservedJob): boolean {
    return this.leasedJobs.get(job.id)?.job.reservationToken === job.reservationToken;
  }

  private forgetReservation(reservation: JobReservationRef): TrackedReservation | undefined {
    const tracked = this.leasedJobs.get(reservation.jobId);
    if (tracked?.job.reservationToken !== reservation.reservationToken) return undefined;
    this.leasedJobs.delete(reservation.jobId);
    return tracked;
  }

  /** A batch shares one signal, while independent invocations retain their leases. */
  private watchInvocation(invocation: WorkerInvocation): AbortSignal {
    const leaseLoss = new AbortController();
    for (const job of invocation.jobs) {
      const tracked = this.leasedJobs.get(job.id);
      if (tracked?.job.reservationToken !== job.reservationToken) {
        leaseLoss.abort(new WorkerReservationLostError(job.id));
      } else {
        tracked.invocation = leaseLoss;
      }
    }
    return AbortSignal.any([this.executionSignal, leaseLoss.signal]);
  }

  private createInvocations(
    jobs: readonly ReservedJob[],
  ): readonly WorkerInvocation[] {
    const jobsByQueue = Map.groupBy(jobs, (job) => job.queue);
    const invocations: WorkerInvocation[] = [];

    for (const worker of this.workers) {
      const workerJobs = jobsByQueue.get(worker.queue) ?? [];

      if (worker.batch === false) {
        for (const job of workerJobs) {
          const executionId = getFirstAttemptExecutionId(job);
          invocations.push({
            worker,
            jobs: [job],
            ...(executionId === undefined ? {} : { executionId }),
          });
        }
        continue;
      }

      let pendingBatch: ReservedJob[] = [];
      const flushPendingBatch = () => {
        if (pendingBatch.length === 0) {
          return;
        }

        const batch = pendingBatch;
        pendingBatch = [];
        invocations.push({ worker, jobs: batch });
      };

      for (const job of workerJobs) {
        const executionId = getFirstAttemptExecutionId(job);

        if (executionId !== undefined) {
          // A correlated job needs its own invocation so its publisher can
          // follow one unambiguous execution, including for batch workers.
          flushPendingBatch();
          invocations.push({
            worker,
            jobs: [job],
            executionId,
          });
          continue;
        }

        pendingBatch.push(job);

        if (pendingBatch.length === worker.batch.size) {
          flushPendingBatch();
        }
      }

      flushPendingBatch();
    }

    return invocations;
  }

  /** Admits work before it enters the handler-slot semaphore. */
  private async runInvocation(
    invocation: WorkerInvocation,
  ): Promise<readonly JobOutcome[]> {
    const signal = this.watchInvocation(invocation);
    if (signal.aborted) return this.skipInvocation(invocation, signal);
    let parsedJobs: readonly ReservedJob[];

    try {
      // Handlers own their input copies. Delivery must retain the original
      // reservation token, identity and nested correlation metadata.
      parsedJobs = await Promise.all(invocation.jobs.map(async ({ payload, ...reservation }) => ({
        ...structuredClone(reservation),
        payload: await parseSchema(
          invocation.worker.inputSchema,
          payload,
          invocation.worker.validation.input,
        ),
      })));
    } catch (error) {
      return this.runPreparationFailure(invocation, error, signal);
    }

    if (signal.aborted) return this.skipInvocation(invocation, signal);
    if (invocation.worker.throttling === undefined) {
      return this.runPreparedInvocation(
        invocation,
        parsedJobs,
        signal,
        unavailableActualCostReporter(invocation.worker.name),
        unavailableFeedbackReporter(invocation.worker.name),
      );
    }

    if (this.throttling === undefined) {
      return this.runPreparationFailure(
        invocation,
        new Error(
          `Worker "${invocation.worker.name}" declares throttling but no throttling facade is configured.`,
        ),
        signal,
      );
    }

    let requirement: CombinedRequirement;

    try {
      requirement = combineRequirements(
        invocation.worker.name,
        invocation.worker.throttling,
        parsedJobs,
      );
    } catch (error) {
      return this.runPreparationFailure(invocation, error, signal);
    }

    let permit: ThrottlingPermit | undefined;

    try {
      permit = await this.acquireInvocationPermit(invocation, requirement, signal);
    } catch (error) {
      return this.runPreparationFailure(invocation, error, signal);
    }

    if (permit === undefined) return this.skipInvocation(invocation, signal);

    let actualCost: ThrottlingCost | undefined;
    let feedback: ThrottlingFeedback | undefined;
    const reportActualCost = (cost: ThrottlingCost) => {
      if (actualCost !== undefined) {
        throw new TypeError(
          "Worker actual throttling cost can only be reported once per invocation.",
        );
      }

      // Reconcile what the handler reported, even if it reuses its input object.
      actualCost = { ...cost };
    };
    const reportFeedback = (reported: ThrottlingFeedback) => {
      if (feedback !== undefined) {
        throw new TypeError(
          "Worker throttling feedback can only be reported once per invocation.",
        );
      }

      feedback = structuredClone(reported);
    };

    let outcomes: readonly JobOutcome[];

    try {
      outcomes = await this.runPreparedInvocation(
        invocation,
        parsedJobs,
        signal,
        reportActualCost,
        reportFeedback,
      );
    } catch (error) {
      await permit.complete({
        outcome: "failure",
        ...(actualCost === undefined ? {} : { actualCost }),
        ...(feedback === undefined ? {} : { feedback }),
      });

      if (signal.aborted) return [];
      throw error;
    }

    await permit.complete({
      outcome: signal.aborted || outcomes.some((outcome) => outcome.kind === "failure")
        ? "failure"
        : "success",
      ...(actualCost === undefined ? {} : { actualCost }),
      ...(feedback === undefined ? {} : { feedback }),
    });
    return outcomes;
  }

  private async acquireInvocationPermit(
    invocation: WorkerInvocation,
    requirement: CombinedRequirement,
    signal: AbortSignal,
  ): Promise<ThrottlingPermit | undefined> {
    const throttling = this.throttling!;
    let firstError: unknown;

    try {
      const permit = await throttling.acquire(requirement.admission, {
        estimatedCost: requirement.estimatedCost,
        signal,
      });
      this.recordDecision(invocation, "admitted");
      return permit;
    } catch (error) {
      if (signal.reason instanceof WorkerReservationLostError || isShutdownAdmissionError(error, signal)) return undefined;
      if (!isUnavailableAdmissionError(error)) throw error;
      firstError = error;
    }

    const buffering = invocation.worker.throttling!.buffering;

    if (buffering.strategy === "release") {
      await this.deferInvocation(invocation, this.now(), "released");
      return undefined;
    }

    if (buffering.strategy !== "hold" || !this.enterBlockedBuffer(invocation, buffering.maxBlockedJobs)) {
      await this.deferInvocation(
        invocation,
        getAdmissionRetryAt(firstError)
          ?? this.fallbackRetryAt(buffering.fallbackDelayMs),
        "deferred",
      );
      return undefined;
    }

    this.recordDecision(invocation, "held", getAdmissionRetryAt(firstError));

    try {
      const permit = await throttling.acquire(requirement.admission, {
        estimatedCost: requirement.estimatedCost,
        maxWaitMs: buffering.maxHoldMs,
        signal,
      });
      this.recordDecision(invocation, "admitted");
      return permit;
    } catch (error) {
      if (signal.reason instanceof WorkerReservationLostError || isShutdownAdmissionError(error, signal)) return undefined;
      if (!isUnavailableAdmissionError(error)) throw error;

      await this.deferInvocation(
        invocation,
        getAdmissionRetryAt(error)
          ?? getAdmissionRetryAt(firstError)
          ?? this.fallbackRetryAt(buffering.fallbackDelayMs),
        "deferred",
      );
      return undefined;
    } finally {
      this.leaveBlockedBuffer(invocation);
    }
  }

  private enterBlockedBuffer(invocation: WorkerInvocation, configuredLimit: number | undefined): boolean {
    const current = this.blockedJobs.get(invocation.worker.name) ?? 0;
    const maxBlockedJobs = configuredLimit
      ?? (invocation.worker.batch === false
        ? this.options.slots
        : invocation.worker.batch.size);

    if (current + invocation.jobs.length > maxBlockedJobs) return false;
    this.blockedJobs.set(
      invocation.worker.name,
      current + invocation.jobs.length,
    );
    return true;
  }

  private leaveBlockedBuffer(invocation: WorkerInvocation): void {
    const remaining = (this.blockedJobs.get(invocation.worker.name) ?? 0)
      - invocation.jobs.length;

    if (remaining <= 0) this.blockedJobs.delete(invocation.worker.name);
    else this.blockedJobs.set(invocation.worker.name, remaining);
  }

  private async deferInvocation(
    invocation: WorkerInvocation,
    availableAt: Date,
    result: "deferred" | "released",
  ): Promise<void> {
    if (this.executionSignal.aborted) return;
    const requests: DeferJobRequest[] = invocation.jobs.filter((job) => this.ownsJob(job)).map((job) => ({
      ...toReservationRef(job),
      availableAt,
    }));
    if (requests.length === 0) return;
    // Do not wait per invocation: a cycle can collect all rejected work before
    // its final flush, while the timer also handles long-running peer jobs.
    this.deferrals.enqueue(requests, () => {
      this.recordDecision(invocation, result, availableAt);
    });
  }

  private fallbackRetryAt(delayMs: number): Date {
    return new Date(this.now().getTime() + delayMs);
  }

  private recordDecision(
    invocation: WorkerInvocation,
    result: WorkerThrottlingDecision["result"],
    retryAt?: Date,
  ): void {
    try {
      this.recordThrottlingDecision({
        worker: invocation.worker.name,
        jobIds: invocation.jobs.map((job) => job.id),
        result,
        ...(retryAt === undefined ? {} : { retryAt }),
      });
    } catch {
      // Instrumentation cannot change queue ownership or admission behavior.
    }
  }

  private runPreparedInvocation(
    invocation: WorkerInvocation,
    parsedJobs: readonly ReservedJob[],
    signal: AbortSignal,
    reportActualCost: (cost: ThrottlingCost) => void,
    reportFeedback: (feedback: ThrottlingFeedback) => void,
  ): Promise<readonly JobOutcome[]> {
    return this.runInHandlerSlot(
      invocation,
      () => invocation.worker.batch === false
        ? this.runIndividual(
            invocation.worker,
            invocation.jobs[0]!,
            parsedJobs[0]!,
            invocation.executionId,
            signal,
            reportActualCost,
            reportFeedback,
          )
        : this.runBatch(
            invocation.worker,
            invocation.jobs,
            parsedJobs,
            invocation.executionId,
            signal,
            reportActualCost,
            reportFeedback,
          ),
      signal,
    );
  }

  private runPreparationFailure(
    invocation: WorkerInvocation,
    error: unknown,
    signal: AbortSignal,
  ): Promise<readonly JobOutcome[]> {
    return this.runInHandlerSlot(
      invocation,
      () => this.runObservedInvocation(
        invocation.worker,
        invocation.executionId,
        async () => ({
          outcomes: invocation.jobs.map((job) => ({ kind: "failure", job, error })),
        }),
      ),
      signal,
    );
  }

  private async runInHandlerSlot(
    invocation: WorkerInvocation,
    operation: () => Promise<readonly JobOutcome[]>,
    signal: AbortSignal,
  ): Promise<readonly JobOutcome[]> {
    try {
      return await this.handlerSlots.run(operation, signal);
    } catch (error) {
      if (signal.aborted && error === signal.reason) return this.skipInvocation(invocation, signal);
      throw error;
    }
  }

  private skipInvocation(invocation: WorkerInvocation, signal: AbortSignal): readonly JobOutcome[] {
    if (signal.reason instanceof WorkerReservationLostError) this.returnUnfinishedJobs(invocation.jobs);
    return [];
  }

  /** An interrupted batch returns its still-owned, unreported members without charging an attempt. */
  private returnUnfinishedJobs(jobs: readonly ReservedJob[]): void {
    if (this.executionSignal.aborted) return;
    const availableAt = this.now();
    const requests = jobs.filter((job) => this.ownsJob(job)).map((job) => ({
      ...toReservationRef(job),
      availableAt,
    }));
    this.deferrals.enqueue(requests, () => undefined);
  }

  private getReportableBatchJobs(
    jobs: readonly ReservedJob[],
    signal: AbortSignal,
    successes: ReadonlyMap<string, unknown>,
    failures: ReadonlyMap<string, JobFailure>,
    interrupted = false,
  ): readonly ReservedJob[] {
    if (!interrupted && !(signal.reason instanceof WorkerReservationLostError)) return jobs;

    const reported: ReservedJob[] = [];
    const unfinished: ReservedJob[] = [];
    for (const job of jobs) {
      if (successes.has(job.id) || failures.has(job.id)) reported.push(job);
      else unfinished.push(job);
    }
    // Lease loss can return the still-owned members immediately. During
    // shutdown, leave unfinished work to the scheduler's release/expiry mode.
    if (signal.reason instanceof WorkerReservationLostError) this.returnUnfinishedJobs(unfinished);
    return reported;
  }

  private async runIndividual(
    worker: AnyWorker,
    job: ReservedJob,
    parsedJob: ReservedJob,
    executionId: string | undefined,
    signal: AbortSignal,
    reportActualCost: (cost: ThrottlingCost) => void,
    reportFeedback: (feedback: ThrottlingFeedback) => void,
  ): Promise<readonly JobOutcome[]> {
    return this.runObservedInvocation(
      worker,
      executionId,
      async (execution) => {
        let result: unknown;
        let hasResult = false;

        try {
          const dependencies = await execution.container.resolveDependenciesAsync(
            worker.dependencies,
          );
          signal.throwIfAborted();
          await worker.handler(
            parsedJob,
            dependencies,
            {
              signal,
              execution,
              setResult: (value: unknown) => {
                if (hasResult) {
                  throw new TypeError(
                    "A worker result can only be reported once per job.",
                  );
                }

                hasResult = true;
                result = value;
              },
              reportActualCost,
              reportFeedback,
            },
          );

          return {
            outcomes: [{ kind: "success", job, ...(hasResult ? { result } : {}) }],
          };
        } catch (error) {
          if (isInvocationAbort(error, signal)) {
            return { outcomes: [], interruption: { error } };
          }

          return {
            outcomes: [{
              kind: "failure",
              job,
              error,
              ...(error instanceof WorkerRetryError
                ? {
                    retryDelayMs: error.retryDelayMs,
                    ...(error.maxAttempts === undefined
                      ? {}
                      : { maxAttempts: error.maxAttempts }),
                  }
                : {}),
            }],
          };
        }
      },
    );
  }

  private async runBatch(
    worker: AnyWorker,
    jobs: readonly ReservedJob[],
    parsedJobs: readonly ReservedJob[],
    executionId: string | undefined,
    signal: AbortSignal,
    reportActualCost: (cost: ThrottlingCost) => void,
    reportFeedback: (feedback: ThrottlingFeedback) => void,
  ): Promise<readonly JobOutcome[]> {
    return this.runObservedInvocation(
      worker,
      executionId,
      async (execution) => {
        const jobsById = new Map(jobs.map((job) => [job.id, job]));
        const yieldedJobIds = new Set<string>();
        const successfulResults = new Map<string, unknown>();
        const eagerlyAcknowledgedJobIds = new Set<string>();
        const failuresByJobId = new Map<string, JobFailure>();
        let reportableJobs: readonly ReservedJob[] | undefined;

        try {
          const dependencies = await execution.container.resolveDependenciesAsync(
            worker.dependencies,
          );
          signal.throwIfAborted();
          const aggregated = await runAggregatedResult<
            string,
            unknown,
            WorkerBatchFailureData,
            unknown
          >(
            () => worker.handler(
              parsedJobs,
              dependencies,
              {
                signal,
                execution,
                setResult: () => {
                  throw new TypeError(
                    "Batch workers must return results with jobSuccess().",
                  );
                },
                reportActualCost,
                reportFeedback,
              },
            ),
            {
              onYield: (result) => {
                const job = jobsById.get(result.key);

                if (job === undefined) {
                  throw new WorkerBatchResultError(
                    `Batch result references unknown job "${result.key}".`,
                  );
                }

                if (yieldedJobIds.has(result.key)) {
                  throw new WorkerBatchResultError(
                    `Batch returned more than one result for job "${result.key}".`,
                  );
                }

                yieldedJobIds.add(result.key);
                const tracked = this.leasedJobs.get(job.id);
                if (tracked?.job.reservationToken !== job.reservationToken) return;

                if (result.status === "success") {
                  successfulResults.set(result.key, result.result);
                  if (job.correlation === undefined) {
                    // Preserve progressive durability when no result handoff
                    // must precede the queue acknowledgement.
                    // The ack may commit before its response arrives. Continue
                    // renewing ownership, but do not cancel the running batch
                    // if an extension observes this completed member missing.
                    delete tracked.invocation;
                    eagerlyAcknowledgedJobIds.add(result.key);
                    this.acknowledgements.enqueue(
                      job.queue,
                      toReservationRef(job),
                    );
                  }
                } else {
                  // Capture the accepted failure before the generator can reuse its data object.
                  failuresByJobId.set(result.key, failureOutcome(job, result.error));
                }
              },
            },
          );

          reportableJobs = this.getReportableBatchJobs(jobs, signal, successfulResults, failuresByJobId);
          return {
            outcomes: this.completeBatchOutcomes(
              reportableJobs,
              aggregated.results.length + aggregated.errors.length,
              successfulResults,
              eagerlyAcknowledgedJobIds,
              failuresByJobId,
            ),
          };
        } catch (error) {
          const interrupted = isInvocationAbort(error, signal);
          reportableJobs ??= this.getReportableBatchJobs(jobs, signal, successfulResults, failuresByJobId, interrupted);
          const outcomes = reportableJobs.flatMap((job): JobOutcome[] => {
            if (eagerlyAcknowledgedJobIds.has(job.id)) return [];

            if (successfulResults.has(job.id)) {
              return [{
                kind: "success",
                job,
                result: successfulResults.get(job.id),
              }];
            }

            return [failuresByJobId.get(job.id) ?? { kind: "failure", job, error }];
          });
          return { outcomes, ...(interrupted ? { interruption: { error } } : {}) };
        }
      },
    );
  }

  /** Resolves completed, missing and implicit batch outcomes in job order. */
  private completeBatchOutcomes(
    jobs: readonly ReservedJob[],
    yieldedCount: number,
    successfulResults: ReadonlyMap<string, unknown>,
    eagerlyAcknowledgedJobIds: ReadonlySet<string>,
    failuresByJobId: ReadonlyMap<string, JobFailure>,
  ): readonly JobOutcome[] {
    if (yieldedCount === 0) {
      return jobs.map((job) => ({ kind: "success", job }));
    }

    const missingResultError = new WorkerBatchResultError(
      "Batch must yield exactly one result for every job.",
    );

    return jobs.flatMap((job): JobOutcome[] => {
      if (eagerlyAcknowledgedJobIds.has(job.id)) return [];

      if (successfulResults.has(job.id)) {
        return [{
          kind: "success",
          job,
          result: successfulResults.get(job.id),
        }];
      }

      return [failuresByJobId.get(job.id) ?? { kind: "failure", job, error: missingResultError }];
    });
  }

  /** Records one worker handler invocation as an application execution. */
  private async runObservedInvocation(
    worker: AnyWorker,
    executionId: string | undefined,
    callback: (
      execution: ExecutionScope<Config>,
    ) => Promise<WorkerInvocationResult>,
  ): Promise<readonly JobOutcome[]> {
    const execution = await this.app.createExecutionScope(executionId);
    try {
      setExecutionLogContext(execution.context, {
        operation: worker.name,
        transport: "worker",
        workload: "workers",
      });
      const observer = this.resolveObserver(execution);
      const startedAt = performance.now();

      const run = async () => {
        let outcome: ExecutionOutcome = "failure";
        let executionError: unknown;
        try {
          const { outcomes, interruption } = await callback(execution);
          const failure = outcomes.find((item) => item.kind === "failure");
          executionError = failure === undefined ? interruption?.error : failure.error;
          if (failure === undefined) outcome = interruption === undefined ? "success" : "cancelled";
          return outcomes;
        } catch (error: unknown) {
          executionError = error;
          throw error;
        } finally {
          try {
            observer?.record(
              executionCompletedObservation,
              {
                operation: worker.name,
                transport: "worker",
                ...getExecutionObservationContext(execution.context),
                ...(executionError === undefined
                  ? {}
                  : getExecutionObservationError(executionError)),
              },
              {
                // Observations retain their binary success/failure outcome.
                outcome: outcome === "cancelled" ? "failure" : outcome,
                durationMs: performance.now() - startedAt,
              },
            );
          } finally {
            await execution.dispose(outcome);
          }
        }
      };

      // Setup failures are synchronous. Once the handler starts, its promise
      // owns disposal inside the observation context, including on rejection.
      return this.app.runInObservationContext(observer, () => {
        observer?.record(executionStartedObservation, {
          operation: worker.name,
          transport: "worker",
        });
        return run();
      });
    } catch (error: unknown) {
      await execution.dispose("failure");
      throw error;
    }
  }

  /** Resolves optional instrumentation from the invocation scope. */
  private resolveObserver(
    execution: ExecutionScope<Config>,
  ): Observer | undefined {
    return execution.container.hasRegistration("observer")
      ? execution.container.resolve(observerDependency)
      : undefined;
  }

  private async flushOutcomes(
    outcomes: readonly JobOutcome[],
  ): Promise<void> {
    const retries: RetryJobRequest[] = [];
    const deadLetters: DeadLetterJobRequest[] = [];
    const completions: WorkerCorrelatedCompletion[] = [];
    const successes: JobSuccess[] = [];

    for (const outcome of outcomes) {
      if (!this.ownsJob(outcome.job)) continue;
      const reservation = toReservationRef(outcome.job);

      if (outcome.kind === "success") {
        if (outcome.job.correlation !== undefined) {
          completions.push({
            jobId: outcome.job.id,
            ...(outcome.job.identity === undefined
              ? {}
              : { identity: outcome.job.identity }),
            correlation: outcome.job.correlation,
            status: "completed",
            ...(Object.hasOwn(outcome, "result")
              ? { result: outcome.result }
              : {}),
          });
        }
        successes.push(outcome);
        continue;
      }

      const worker = this.workersByQueue.get(outcome.job.queue);

      if (worker === undefined) {
        throw new Error(`No worker consumes queue "${outcome.job.queue}".`);
      }

      const error = serializeWorkerError(outcome.error);

      if (outcome.job.attempt >= (outcome.maxAttempts ?? worker.maxAttempts)) {
        if (outcome.job.correlation !== undefined) {
          completions.push({
            jobId: outcome.job.id,
            ...(outcome.job.identity === undefined
              ? {}
              : { identity: outcome.job.identity }),
            correlation: outcome.job.correlation,
            status: "failed",
            error,
          });
        }
        deadLetters.push({ ...reservation, error });
        continue;
      }

      const retryDelayMs = outcome.retryDelayMs
        ?? getRetryDelay(worker, outcome.job.attempt);
      retries.push({
        ...reservation,
        retryAt: new Date(this.now().getTime() + retryDelayMs),
        error,
      });
    }

    // Keep successes outside the auto-flushing buffer until their result
    // handoffs are durable. A timer or full buffer must never overtake them.
    // A failed handoff must not release sibling reservations while their
    // terminal results are still reaching storage. Normalize synchronous throws
    // as well, so every selected handoff participates in the same drain.
    const handoffs = await Promise.allSettled(completions.map((completion) =>
      Promise.resolve().then(() => this.leasedJobs.has(completion.jobId)
        ? this.completeCorrelatedJob?.(completion)
        : undefined)));
    const handoffErrors = handoffs.flatMap((handoff) =>
      handoff.status === "rejected" ? [handoff.reason as unknown] : []);
    if (handoffErrors.length === 1) throw handoffErrors[0];
    if (handoffErrors.length > 1) {
      throw new AggregateError(handoffErrors, "Several worker result handoffs failed.");
    }

    for (const { job } of successes) {
      if (!this.ownsJob(job)) continue;
      this.acknowledgements.enqueue(job.queue, toReservationRef(job));
    }

    // Independent batches let adapters issue one statement per transition.
    // Preserve lease maintenance until all started queue transitions settle,
    // including when one backend operation fails before its peers complete.
    const transitions = await Promise.allSettled([
      this.acknowledgements.flush(),
      retries.length === 0 ? undefined
        : Promise.resolve().then(() => this.adapter.retry(retries)),
      deadLetters.length === 0
        ? undefined
        : Promise.resolve().then(() => this.adapter.deadLetter(deadLetters)),
    ]);
    const transitionErrors = transitions.flatMap((transition) =>
      transition.status === "rejected" ? [transition.reason as unknown] : []);
    if (transitionErrors.length === 1) throw transitionErrors[0];
    if (transitionErrors.length > 1) {
      throw new AggregateError(transitionErrors, "Several worker queue transitions failed.");
    }
  }
}

function getReservationAllocation(
  worker: AnyWorker,
  slots: number,
): number {
  const jobsPerInvocation = worker.batch === false ? 1 : worker.batch.size;

  return Math.max(1, Math.ceil(slots * worker.weight * jobsPerInvocation));
}

function getRetryDelay(worker: AnyWorker, attempt: number): number {
  return Math.min(
    worker.retryDelayMs * 2 ** Math.max(0, attempt - 1),
    worker.maxRetryDelayMs,
  );
}

function toReservationRef(job: ReservedJob): JobReservationRef {
  return {
    jobId: job.id,
    reservationToken: job.reservationToken,
  };
}

/** Uses publisher correlation only for the job's first processing attempt. */
function getFirstAttemptExecutionId(job: ReservedJob): string | undefined {
  return job.attempt === 1 ? job.executionId : undefined;
}

function failureOutcome(
  job: ReservedJob,
  failure: WorkerBatchFailureData,
): JobFailure {
  const { cause, retryDelayMs, maxAttempts } = failure;
  if (retryDelayMs !== undefined && (!Number.isFinite(retryDelayMs) || retryDelayMs < 0)) {
    throw new WorkerBatchResultError("Batch retry delays must be non-negative finite numbers.");
  }
  if (maxAttempts !== undefined && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) {
    throw new WorkerBatchResultError("Batch maxAttempts must be a positive integer.");
  }

  return {
    kind: "failure",
    job,
    error: cause,
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

function combineRequirements(
  workerName: string,
  throttling: WorkerThrottling<unknown>,
  jobs: readonly ReservedJob[],
): CombinedRequirement {
  const requirements = jobs.map((job) => {
    const requirement = throttling.requirements(job);
    if (!isThrottlingRequirement(requirement)) {
      throw new TypeError(`Worker "${workerName}" returned an invalid throttling requirement.`);
    }
    return requirement;
  });
  // Invocations are created only for nonempty reservations.
  const { admission } = requirements[0]!;
  const definitionSignature = JSON.stringify(admission);
  const costs = requirements.map((requirement) => {

    if (JSON.stringify(requirement.admission) !== definitionSignature) {
      throw new TypeError(
        `Every job in one "${workerName}" invocation must use the same admission policy.`,
      );
    }

    return requirement.estimatedCost
      ?? defaultWorkerEstimatedCost(requirement.admission, workerName);
  });
  const dimensions = new Set(Object.keys(costs[0]!));
  const combined: Record<string, number> = Object.fromEntries(
    [...dimensions].map((dimension) => [dimension, 0]),
  );

  for (const cost of costs) {
    const entries = Object.entries(cost);

    if (
      entries.length !== dimensions.size
      || entries.some(([key]) => !dimensions.has(key))
    ) {
      throw new TypeError(
        `Every job in one "${workerName}" invocation must use the same cost dimensions.`,
      );
    }

    for (const [dimension, value] of entries) {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(
          `Worker throttling cost "${dimension}" must be non-negative and finite.`,
        );
      }

      const total = combined[dimension]! + value;
      if (!Number.isFinite(total)) {
        throw new TypeError(`Combined worker throttling cost "${dimension}" must be finite.`);
      }
      combined[dimension] = total;
    }
  }

  return { admission, estimatedCost: combined };
}

function isThrottlingRequirement(
  value: unknown,
): value is WorkerThrottlingRequirement {
  if (typeof value !== "object" || value === null) return false;
  const admission = (value as { admission?: unknown }).admission;
  if (typeof admission !== "object" || admission === null) return false;
  const { kind } = admission as { kind?: unknown };
  return kind === "rate-limit" || kind === "admission-policy";
}

function defaultWorkerEstimatedCost(
  admission: WorkerThrottlingRequirement["admission"],
  workerName: string,
): ThrottlingCost {
  if (admission.kind === "rate-limit") return { requests: 1 };
  const hasRateLimits = admission.limits.some((limit) =>
    limit.kind === "rate-limit-constraint");

  if (hasRateLimits) {
    throw new TypeError(
      `Worker "${workerName}" must declare estimatedCost for an advanced admission policy.`,
    );
  }

  return {};
}

function unavailableActualCostReporter(workerName: string) {
  return (_cost: ThrottlingCost): never => {
    throw new TypeError(
      `Worker "${workerName}" cannot report throttling cost without declaring throttling requirements.`,
    );
  };
}

function unavailableFeedbackReporter(workerName: string) {
  return (_feedback: ThrottlingFeedback): never => {
    throw new TypeError(
      `Worker "${workerName}" cannot report throttling feedback without declaring throttling requirements.`,
    );
  };
}

function isUnavailableAdmissionError(error: unknown): boolean {
  return error instanceof ThrottlingRejectedError
    || error instanceof ThrottlingAcquisitionTimeoutError
    || error instanceof ThrottlingQueueFullError
    || error instanceof ThrottlingBackendUnavailableError
    || error instanceof ThrottlingClosedError;
}

function isShutdownAdmissionError(
  error: unknown,
  signal: AbortSignal,
): boolean {
  return signal.aborted
    && (error instanceof ThrottlingAcquisitionAbortedError
      || error instanceof ThrottlingClosedError);
}

/** Recognizes direct cancellation and Node APIs that wrap its reason. */
function isInvocationAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    && (error === signal.reason || (error instanceof Error && error.cause === signal.reason));
}

function getAdmissionRetryAt(error: unknown): Date | undefined {
  return error instanceof ThrottlingRejectedError ? error.retryAt : undefined;
}

interface HandlerSlotWaiter {
  resolve(): void;
  abortSubscription: ReturnType<typeof addAbortListener>;
}

/** Limits handlers only; throttling waits happen before this semaphore. */
class HandlerSlotGate {
  private active = 0;

  private readonly waiters: HandlerSlotWaiter[] = [];

  public constructor(private readonly capacity: number) {}

  public async run<Value>(
    operation: () => Promise<Value>,
    signal: AbortSignal,
  ): Promise<Value> {
    await this.enter(signal);

    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.leave();
    }
  }

  private enter(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);

    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: HandlerSlotWaiter = {
        resolve,
        // An admission facade may already listen to this invocation signal.
        abortSubscription: addAbortListener(signal, () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        }),
      };
      this.waiters.push(waiter);
    });
  }

  private leave(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.abortSubscription[Symbol.dispose]();
      waiter.resolve();
      return;
    }

    this.active -= 1;
  }
}

function rotate<Value>(
  values: readonly Value[],
  offset: number,
): readonly Value[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function validateSchedulerOptions(options: WorkerSchedulerOptions): void {
  for (const [name, value] of [
    ["slots", options.slots],
    ["leaseMs", options.leaseMs],
    ["reservationLimit", options.reservationLimit ?? 1],
    ["pollIntervalMs", options.pollIntervalMs ?? 1_000],
    ["readyQueueRefreshMs", options.readyQueueRefreshMs ?? 1_000],
    ["ackBufferSize", options.ackBufferSize ?? 100],
    ["deferBufferSize", options.deferBufferSize ?? 100],
    ["deferFlushIntervalMs", options.deferFlushIntervalMs ?? 10],
    ["ackFlushIntervalMs", options.ackFlushIntervalMs ?? 10],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }

  if (
    options.reservationPressure !== undefined
    && options.reservationPressure.limits.some((constraint) =>
      constraint.kind !== "local-resource-pressure")
  ) {
    throw new TypeError(
      "Worker reservation pressure may only contain local resource pressure constraints.",
    );
  }

  if (
    options.reservationPressure !== undefined
    && options.throttling === undefined
  ) {
    throw new TypeError(
      "Worker reservation pressure requires a throttling facade.",
    );
  }
}
