import { parseSchema } from "../definitions/index.js";
import {
  type RuntimeApp,
  executionCompletedObservation,
  executionStartedObservation,
  getExecutionObservationError,
  getExecutionObservationContext,
  setExecutionLogContext,
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

interface WorkerInvocation {
  readonly worker: AnyWorker;
  readonly jobs: readonly ReservedJob[];
  readonly executionId?: string;
}

interface CombinedRequirement {
  readonly admission: WorkerThrottlingRequirement["admission"];
  readonly estimatedCost: ThrottlingCost;
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

  private readonly leasedJobs = new Map<string, ReservedJob>();

  private readonly acknowledgements: WorkerAcknowledgementBuffer;

  private readonly deferrals: WorkerDeferralBuffer;

  private readonly handlerSlots: HandlerSlotGate;

  private readonly blockedJobs = new Map<string, number>();

  private readonly throttling: Throttling | undefined;

  private readonly reservationPressure: AdmissionPolicyDefinition | undefined;

  private readonly recordThrottlingDecision: (
    decision: WorkerThrottlingDecision,
  ) => void;

  private readonly completeCorrelatedJob: (
    completion: WorkerCorrelatedCompletion,
  ) => Promise<void>;

  private loopAbortController: AbortController | undefined;

  private handlerAbortController = new AbortController();

  private loopPromise: Promise<void> | undefined;

  private activeCycle: Promise<number> | undefined;

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
    this.completeCorrelatedJob = options.completeCorrelatedJob
      ?? (() => Promise.resolve());
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
          this.leasedJobs.delete(job.jobId);
        }
      },
    });
    this.deferrals = new WorkerDeferralBuffer(adapter, {
      maxSize: options.deferBufferSize ?? 100,
      flushIntervalMs: options.deferFlushIntervalMs ?? 10,
      onDeferred: (jobs) => {
        for (const job of jobs) this.leasedJobs.delete(job.jobId);
      },
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

  /** Starts polling until stop is requested. */
  public start(): void {
    if (this.loopPromise !== undefined) {
      throw new Error("The worker scheduler is already running.");
    }

    this.handlerAbortController = new AbortController();
    this.loopAbortController = new AbortController();
    this.loopPromise = this.runLoop(this.loopAbortController.signal)
      .finally(() => {
        this.loopPromise = undefined;
        this.loopAbortController = undefined;
      });
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
    this.loopAbortController?.abort();

    if (behavior === "wait") {
      await this.loopPromise;
      return;
    }

    this.handlerAbortController.abort();

    // Persist buffered decisions before releasing remaining leases.
    await Promise.all([
      this.acknowledgements.flush(),
      this.deferrals.flush(),
    ]);

    if (behavior === "release") {
      await this.adapter.release(
        [...this.leasedJobs.values()].map(toReservationRef),
      );
    }

    // Observe eventual failures even when shutdown deliberately does not wait.
    void this.loopPromise?.catch(() => undefined);
  }

  /** Performs one complete reserve, execute and flush cycle. */
  public runOnce(): Promise<number> {
    if (this.activeCycle !== undefined) {
      return this.activeCycle;
    }

    const cycle = this.executeCycle().finally(() => {
      if (this.activeCycle === cycle) {
        this.activeCycle = undefined;
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

      if (handled === 0) {
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

  private async executeCycle(): Promise<number> {
    if (this.workers.length === 0) {
      return 0;
    }

    if (!await this.canReserveUnderPressure()) return 0;

    const orderedWorkers = rotate(this.workers, this.rotationOffset);
    this.rotationOffset = (this.rotationOffset + 1) % this.workers.length;
    const readyQueues = await this.getReadyQueues(orderedWorkers);
    const readyWorkers = orderedWorkers.filter((worker) =>
      readyQueues.has(worker.queue)
    );

    if (readyWorkers.length === 0) {
      return 0;
    }

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

    for (const job of jobs) {
      this.leasedJobs.set(job.id, job);
    }

    const leaseExtensions = this.keepLeasesAlive(jobs);

    try {
      const outcomes = await Promise.all(
        this.createInvocations(jobs).map((invocation) =>
          this.runInvocation(invocation)),
      );

      // Independent storage transitions can complete together at the cycle
      // boundary instead of serializing deferrals behind acknowledgements.
      const transitions = await Promise.allSettled([
        this.flushOutcomes(outcomes.flat()),
        this.deferrals.flush(),
      ]);
      // One failed buffer must not end lease maintenance while another is
      // still persisting outcomes or waiting for correlated result delivery.
      const errors = transitions.flatMap((transition) =>
        transition.status === "rejected" ? [transition.reason as unknown] : []);
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
          for (const job of jobs) this.leasedJobs.delete(job.id);
        }
      }
    }

    return jobs.length;
  }

  /** Avoids reserving jobs while a job-independent local gate is unavailable. */
  private async canReserveUnderPressure(): Promise<boolean> {
    if (this.reservationPressure === undefined) return true;

    if (this.throttling === undefined) {
      throw new Error(
        "Worker reservation pressure requires a throttling facade.",
      );
    }

    const availability = await this.throttling.inspect(
      this.reservationPressure,
    );
    return availability.state === "available"
      || availability.state === "degraded";
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
      intervalMs: Math.max(1, Math.floor(this.options.leaseMs / 2)),
      extend: async () => {
        if (this.handlerAbortController.signal.aborted) return;
        const ownedJobs = jobs.filter((job) => this.leasedJobs.has(job.id));
        if (ownedJobs.length === 0) return;
        await this.adapter.extendLease(ownedJobs.map((job) => ({
          ...toReservationRef(job),
          leaseMs: this.options.leaseMs,
        })));
      },
    });
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
    let parsedJobs: readonly ReservedJob[];

    try {
      parsedJobs = await Promise.all(invocation.jobs.map(async (job) => ({
        ...job,
        payload: await parseSchema(
          invocation.worker.inputSchema,
          job.payload,
          invocation.worker.validation.input,
        ),
      })));
    } catch (error) {
      return this.runPreparationFailure(invocation, error);
    }

    if (invocation.worker.throttling === undefined) {
      return this.runPreparedInvocation(
        invocation,
        parsedJobs,
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
      );
    }

    let requirement: CombinedRequirement;

    try {
      requirement = combineRequirements(
        invocation.worker,
        parsedJobs,
      );
    } catch (error) {
      return this.runPreparationFailure(invocation, error);
    }

    let permit: ThrottlingPermit | undefined;

    try {
      permit = await this.acquireInvocationPermit(invocation, requirement);
    } catch (error) {
      return this.runPreparationFailure(invocation, error);
    }

    if (permit === undefined) return [];

    let actualCost: ThrottlingCost | undefined;
    let feedback: ThrottlingFeedback | undefined;
    const reportActualCost = (cost: ThrottlingCost) => {
      if (actualCost !== undefined) {
        throw new TypeError(
          "Worker actual throttling cost can only be reported once per invocation.",
        );
      }

      actualCost = cost;
    };
    const reportFeedback = (reported: ThrottlingFeedback) => {
      if (feedback !== undefined) {
        throw new TypeError(
          "Worker throttling feedback can only be reported once per invocation.",
        );
      }

      feedback = reported;
    };

    let outcomes: readonly JobOutcome[];

    try {
      outcomes = await this.runPreparedInvocation(
        invocation,
        parsedJobs,
        reportActualCost,
        reportFeedback,
      );
    } catch (error) {
      await permit.complete({
        outcome: "failure",
        ...(actualCost === undefined ? {} : { actualCost }),
        ...(feedback === undefined ? {} : { feedback }),
      });

      if (this.handlerAbortController.signal.aborted) return [];
      throw error;
    }

    await permit.complete({
      outcome: outcomes.some((outcome) => outcome.kind === "failure")
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
  ): Promise<ThrottlingPermit | undefined> {
    const throttling = this.throttling!;
    const signal = this.handlerAbortController.signal;
    let firstError: unknown;

    try {
      const permit = await throttling.acquire(requirement.admission, {
        estimatedCost: requirement.estimatedCost,
        signal,
      });
      this.recordDecision(invocation, "admitted");
      return permit;
    } catch (error) {
      if (isShutdownAdmissionError(error, signal)) return undefined;
      if (!isUnavailableAdmissionError(error)) throw error;
      firstError = error;
    }

    const buffering = invocation.worker.throttling!.buffering;

    if (buffering.strategy === "release") {
      await this.deferInvocation(invocation, this.now(), "released");
      return undefined;
    }

    if (buffering.strategy === "defer") {
      await this.deferInvocation(
        invocation,
        getAdmissionRetryAt(firstError)
          ?? this.fallbackRetryAt(buffering.fallbackDelayMs),
        "deferred",
      );
      return undefined;
    }

    if (!this.enterBlockedBuffer(invocation)) {
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
      if (isShutdownAdmissionError(error, signal)) return undefined;
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

  private enterBlockedBuffer(invocation: WorkerInvocation): boolean {
    const buffering = invocation.worker.throttling!.buffering;
    if (buffering.strategy !== "hold") return false;
    const current = this.blockedJobs.get(invocation.worker.name) ?? 0;
    const maxBlockedJobs = buffering.maxBlockedJobs
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
    if (this.handlerAbortController.signal.aborted) return;
    const requests: DeferJobRequest[] = invocation.jobs.map((job) => ({
      ...toReservationRef(job),
      availableAt,
    }));
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
    reportActualCost: (cost: ThrottlingCost) => void,
    reportFeedback: (feedback: ThrottlingFeedback) => void,
  ): Promise<readonly JobOutcome[]> {
    return this.handlerSlots.run(
      () => invocation.worker.batch === false
        ? this.runIndividual(
            invocation.worker,
            parsedJobs[0]!,
            invocation.executionId,
            reportActualCost,
            reportFeedback,
          )
        : this.runBatch(
            invocation.worker,
            parsedJobs,
            invocation.executionId,
            reportActualCost,
            reportFeedback,
          ),
      this.handlerAbortController.signal,
    );
  }

  private runPreparationFailure(
    invocation: WorkerInvocation,
    error: unknown,
  ): Promise<readonly JobOutcome[]> {
    return this.handlerSlots.run(
      () => this.runObservedInvocation(
        invocation.worker,
        invocation.executionId,
        async () => invocation.jobs.map((job) => ({
          kind: "failure" as const,
          job,
          error,
        })),
      ),
      this.handlerAbortController.signal,
    );
  }

  private async runIndividual(
    worker: AnyWorker,
    job: ReservedJob,
    executionId: string | undefined,
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
          const dependencies = execution.container.resolveDependencies(
            worker.dependencies,
          );
          await worker.handler(
            job,
            dependencies,
            {
              signal: this.handlerAbortController.signal,
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

          return [{
            kind: "success",
            job,
            ...(hasResult ? { result } : {}),
          }];
        } catch (error) {
          return [{
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
          }];
        }
      },
    );
  }

  private async runBatch(
    worker: AnyWorker,
    jobs: readonly ReservedJob[],
    executionId: string | undefined,
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
        const failuresByJobId = new Map<string, WorkerBatchFailureData>();

        try {
          const dependencies = execution.container.resolveDependencies(
            worker.dependencies,
          );
          const aggregated = await runAggregatedResult<
            string,
            unknown,
            WorkerBatchFailureData,
            unknown
          >(
            () => worker.handler(
              jobs,
              dependencies,
              {
                signal: this.handlerAbortController.signal,
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

                if (result.status === "success") {
                  successfulResults.set(result.key, result.result);
                  if (job.correlation === undefined) {
                    // Preserve progressive durability when no result handoff
                    // must precede the queue acknowledgement.
                    eagerlyAcknowledgedJobIds.add(result.key);
                    this.acknowledgements.enqueue(
                      job.queue,
                      toReservationRef(job),
                    );
                  }
                } else {
                  validateBatchFailure(result.error);
                  failuresByJobId.set(result.key, result.error);
                }
              },
            },
          );

          return this.completeBatchOutcomes(
            jobs,
            aggregated.results.length + aggregated.errors.length,
            successfulResults,
            eagerlyAcknowledgedJobIds,
            failuresByJobId,
          );
        } catch (error) {
          return jobs.flatMap((job): JobOutcome[] => {
            if (eagerlyAcknowledgedJobIds.has(job.id)) return [];

            if (successfulResults.has(job.id)) {
              return [{
                kind: "success",
                job,
                result: successfulResults.get(job.id),
              }];
            }

            const failure = failuresByJobId.get(job.id);

            return [failure === undefined
              ? { kind: "failure", job, error }
              : failureOutcome(job, failure)];
          });
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
    failuresByJobId: ReadonlyMap<string, WorkerBatchFailureData>,
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

      const failure = failuresByJobId.get(job.id);

      return [failure === undefined
        ? { kind: "failure", job, error: missingResultError }
        : failureOutcome(job, failure)];
    });
  }

  /** Records one worker handler invocation as an application execution. */
  private async runObservedInvocation(
    worker: AnyWorker,
    executionId: string | undefined,
    callback: (
      execution: ExecutionScope<Config>,
    ) => Promise<readonly JobOutcome[]>,
  ): Promise<readonly JobOutcome[]> {
    const execution = await this.app.createExecutionScope(executionId);
    setExecutionLogContext(execution.context, {
      operation: worker.name,
      transport: "worker",
      workload: "workers",
    });
    const observer = this.resolveObserver(execution);
    const startedAt = performance.now();
    let outcome: "failure" | "success" = "failure";
    let executionError: unknown;

    return this.app.runInObservationContext(observer, async () => {
      observer?.record(executionStartedObservation, {
        operation: worker.name,
        transport: "worker",
      });

      try {
        const outcomes = await callback(execution);
        const failure = outcomes.find((item) => item.kind === "failure");
        executionError = failure?.error;
        outcome = failure === undefined
          ? "success"
          : "failure";

        return outcomes;
      } catch (error: unknown) {
        executionError = error;
        throw error;
      } finally {
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
            outcome,
            durationMs: performance.now() - startedAt,
          },
        );
        await execution.dispose(outcome);
      }
    });
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
    await Promise.all(completions.map(this.completeCorrelatedJob));

    for (const { job } of successes) {
      this.acknowledgements.enqueue(job.queue, toReservationRef(job));
    }

    // Independent batches let adapters issue one statement per transition.
    await Promise.all([
      this.acknowledgements.flush(),
      retries.length === 0 ? undefined : this.adapter.retry(retries),
      deadLetters.length === 0
        ? undefined
        : this.adapter.deadLetter(deadLetters),
    ]);
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
  validateBatchFailure(failure);

  return {
    kind: "failure",
    job,
    error: failure.cause,
    ...(failure.retryDelayMs === undefined
      ? {}
      : { retryDelayMs: failure.retryDelayMs }),
    ...(failure.maxAttempts === undefined
      ? {}
      : { maxAttempts: failure.maxAttempts }),
  };
}

function combineRequirements(
  worker: AnyWorker,
  jobs: readonly ReservedJob[],
): CombinedRequirement {
  const throttling = worker.throttling;

  if (throttling === undefined || jobs.length === 0) {
    throw new TypeError("A throttled worker invocation requires jobs.");
  }

  const requirements = jobs.map((job) => throttling.requirements(job));
  const first = requirements[0];

  if (first === undefined || !isThrottlingRequirement(first)) {
    throw new TypeError(
      `Worker "${worker.name}" returned an invalid throttling requirement.`,
    );
  }

  const definitionSignature = JSON.stringify(first.admission);
  const costs = requirements.map((requirement) => {
    if (!isThrottlingRequirement(requirement)) {
      throw new TypeError(
        `Worker "${worker.name}" returned an invalid throttling requirement.`,
      );
    }

    if (JSON.stringify(requirement.admission) !== definitionSignature) {
      throw new TypeError(
        `Every job in one "${worker.name}" invocation must use the same admission policy.`,
      );
    }

    return requirement.estimatedCost
      ?? defaultWorkerEstimatedCost(requirement.admission, worker.name);
  });
  const dimensions = Object.keys(costs[0] ?? {}).sort();
  const combined: Record<string, number> = Object.fromEntries(
    dimensions.map((dimension) => [dimension, 0]),
  );

  for (const cost of costs) {
    const keys = Object.keys(cost).sort();

    if (
      keys.length !== dimensions.length
      || keys.some((key, index) => key !== dimensions[index])
    ) {
      throw new TypeError(
        `Every job in one "${worker.name}" invocation must use the same cost dimensions.`,
      );
    }

    for (const [dimension, value] of Object.entries(cost)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(
          `Worker throttling cost "${dimension}" must be non-negative and finite.`,
        );
      }

      combined[dimension] = (combined[dimension] ?? 0) + value;
    }
  }

  return { admission: first.admission, estimatedCost: combined };
}

function isThrottlingRequirement(
  value: unknown,
): value is WorkerThrottlingRequirement {
  if (typeof value !== "object" || value === null) return false;
  const admission = (value as { admission?: unknown }).admission;

  return typeof admission === "object"
    && admission !== null
    && (admission as { kind?: unknown }).kind !== undefined;
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

function getAdmissionRetryAt(error: unknown): Date | undefined {
  return error instanceof ThrottlingRejectedError ? error.retryAt : undefined;
}

function validateBatchFailure(failure: WorkerBatchFailureData): void {
  if (
    failure.retryDelayMs !== undefined
    && (!Number.isFinite(failure.retryDelayMs) || failure.retryDelayMs < 0)
  ) {
    throw new WorkerBatchResultError(
      "Batch retry delays must be non-negative finite numbers.",
    );
  }

  if (failure.maxAttempts !== undefined
    && (!Number.isSafeInteger(failure.maxAttempts) || failure.maxAttempts < 1)) {
    throw new WorkerBatchResultError(
      "Batch maxAttempts must be a positive integer.",
    );
  }
}

interface HandlerSlotWaiter {
  reject(error: unknown): void;
  resolve(): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Limits handlers only; throttling waits happen before this semaphore. */
class HandlerSlotGate {
  private active = 0;

  private readonly waiters: HandlerSlotWaiter[] = [];

  public constructor(private readonly capacity: number) {}

  public async run<Value>(
    operation: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    await this.enter(signal);

    try {
      return await operation();
    } finally {
      this.leave();
    }
  }

  private enter(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(signal.reason);

    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: HandlerSlotWaiter = { resolve, reject };

      if (signal !== undefined) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }

  private leave(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;

      if (waiter.signal?.aborted === true) continue;
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
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
