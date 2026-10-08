import { setTimeout as sleep } from "node:timers/promises";

import {
  DeferredTasks,
  DeferredTasksClosedError,
} from "../concurrency/index.js";
import type {
  ActualCostReconciliationMode,
  AdmissionPolicyDefinition,
  CircuitBreakerConstraint,
  ConcurrencyLimitConstraint,
  LocalResourcePressureConstraint,
  RateLimitConstraint,
  ThrottlingDefinition,
} from "./definitions.js";
import { validateThrottlingDefinition } from "./definitions.js";
import {
  ThrottlingAcquisitionAbortedError,
  ThrottlingAcquisitionTimeoutError,
  ThrottlingAdapterCapabilityError,
  ThrottlingBackendUnavailableError,
  ThrottlingCircuitOpenError,
  ThrottlingClosedError,
  ThrottlingCostExceedsBurstError,
  ThrottlingCostValidationError,
  ThrottlingPermitCompletedError,
  ThrottlingQueueFullError,
  ThrottlingRejectedError,
  ThrottlingResourcePressureError,
} from "./errors.js";
import type {
  ThrottlingAcquisitionResult,
  ThrottlingClassifiedFeedback,
  ThrottlingCircuitState,
  ThrottlingInstrumentation,
  ThrottlingInstrumentationEvent,
} from "./observations.js";
import type {
  LocalResourcePressureEvaluation,
  LocalResourcePressureMonitor,
} from "./resource_pressure/index.js";
import type {
  AdmissionAvailability,
  AdmissionReason,
  Awaitable,
  RateLimitAdapter,
  RateLimitBatchReservationResult,
  RateLimitReconciliationRequest,
  RateLimitReservationRequest,
  RateLimitReservationSource,
  Throttling,
  ThrottlingAcquireOptions,
  ThrottlingCost,
  ThrottlingFeedback,
  ThrottlingInspectOptions,
  ThrottlingManagerOptions,
  ThrottlingPermit,
  ThrottlingPermitCompletion,
  ThrottlingRunContext,
  ThrottlingRunOptions,
} from "./types.js";

interface CompiledRateLimit extends RateLimitConstraint {
  readonly key: string;
}

interface CompiledConcurrencyLimit extends ConcurrencyLimitConstraint {
  readonly key: string;
}

interface CompiledCircuitBreaker extends CircuitBreakerConstraint {
  readonly key: string;
}

interface CompiledLocalResourcePressure
  extends LocalResourcePressureConstraint {
  readonly key: string;
}

interface CompiledPolicy {
  readonly id: string;
  readonly definitionSignature: string;
  readonly rates: readonly CompiledRateLimit[];
  readonly concurrency: readonly CompiledConcurrencyLimit[];
  readonly circuits: readonly CompiledCircuitBreaker[];
  readonly pressure: readonly CompiledLocalResourcePressure[];
  readonly units: readonly string[];
  readonly simple: boolean;
  readonly reconciliationMode: ActualCostReconciliationMode;
}

interface AttemptCounter {
  value: number;
}

interface AcquiredPermitResult {
  permit: ThrottlingPermit;
  remaining?: number;
  source?: RateLimitReservationSource;
}

interface DeniedAttempt {
  readonly admitted: false;
  readonly blockedBy: "circuit" | "concurrency" | "pressure" | "rate";
  readonly circuitId?: string;
  readonly pressureConstraintId?: string;
  readonly pressureSignalIds?: readonly string[];
  readonly nextAttemptAtMs?: number;
  readonly remaining?: number;
  readonly retryAt?: Date;
  readonly source?: RateLimitReservationSource;
}

interface AdmittedAttempt {
  readonly admitted: true;
  readonly permit: ThrottlingPermit;
  readonly remaining?: number;
  readonly source?: RateLimitReservationSource;
}

type AcquisitionAttempt = AdmittedAttempt | DeniedAttempt;

interface PendingAcquisition {
  policy: CompiledPolicy;
  estimatedCost: ThrottlingCost;
  deadlineMs: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  attemptCounter: AttemptCounter;
  resolve: (result: AcquiredPermitResult) => void;
  reject: (error: unknown) => void;
}

interface WaitQueue {
  key: string;
  waiters: PendingAcquisition[];
  nextAttemptAtMs: number;
  blockedCircuitId?: string;
  blockedPressureConstraintId?: string;
  blockedPressureSignalIds?: readonly string[];
  blockedByConcurrency: boolean;
  wakeController?: AbortController;
  drainPromise?: Promise<void>;
}

interface ConcurrencyState {
  active: number;
  limit: number;
}

interface CircuitState {
  activeProbes: number;
  consecutiveFailures: number;
  generation: number;
  halfOpenSuccesses: number;
  openUntilMs?: number;
  state: ThrottlingCircuitState;
}

interface CircuitReservation {
  readonly constraint: CompiledCircuitBreaker;
  readonly generation: number;
  readonly probe: boolean;
}

type CircuitAcquisition =
  | { readonly admitted: false; readonly circuitId: string; readonly retryAt?: Date }
  | { readonly admitted: true; readonly reservations: readonly CircuitReservation[] };

const DEFAULT_MAX_PENDING_ACQUISITIONS = 1_000;

/** Coordinates composed admission while keeping the simple API unchanged. */
export class ThrottlingManager implements Throttling {
  private readonly now: () => Date;

  private readonly monotonicNow: () => number;

  private readonly sleep: NonNullable<ThrottlingManagerOptions["sleep"]>;

  private readonly instrumentation: ThrottlingInstrumentation | undefined;

  private readonly formatObservationKey: (key: string) => string;

  private readonly maxPendingAcquisitions: number;

  private readonly namespace: string;

  private readonly waitQueues = new Map<string, WaitQueue>();

  private readonly definitionSignatures = new Map<string, string>();

  private readonly constraintSignatures = new Map<string, string>();

  private readonly concurrencyStates = new Map<string, ConcurrencyState>();

  private readonly circuitStates = new Map<string, CircuitState>();

  private readonly resourcePressureMonitor: LocalResourcePressureMonitor | undefined;

  /** Tracks best-effort adjustments so graceful disposal can await them. */
  private readonly deferredReconciliations = new DeferredTasks();

  private pendingAcquisitions = 0;

  private closed = false;

  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly adapter: RateLimitAdapter,
    private readonly options: ThrottlingManagerOptions,
  ) {
    validateManagerOptions(options);
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.instrumentation = options.instrumentation;
    this.formatObservationKey = options.formatObservationKey ?? ((key) => key);
    this.maxPendingAcquisitions = options.maxPendingAcquisitions
      ?? DEFAULT_MAX_PENDING_ACQUISITIONS;
    this.namespace = options.namespace.trim();
    this.resourcePressureMonitor = options.resourcePressureMonitor;
  }

  public async acquire(
    definition: ThrottlingDefinition,
    options: ThrottlingAcquireOptions = {},
  ): Promise<ThrottlingPermit> {
    const policy = this.compileAndRegister(definition, options.rateKey);
    const estimatedCost = validateEstimatedCost(policy, options.estimatedCost);
    const maxWaitMs = options.maxWaitMs ?? 0;
    validateNonNegativeFinite("maxWaitMs", maxWaitMs);
    const mode = maxWaitMs === 0 ? "immediate" : "wait";
    const startedAt = this.measureTime();
    const attemptCounter: AttemptCounter = { value: 0 };

    try {
      const result = await this.acquireInternal(
        policy,
        estimatedCost,
        maxWaitMs,
        options.signal,
        attemptCounter,
      );

      this.recordInstrumentation({
        type: "acquisition",
        outcome: "success",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          key: policy.id,
          mode,
          result: "acquired",
          cost: sumCost(estimatedCost),
          estimatedCost,
          constraints: policy.rates.length + policy.concurrency.length
            + policy.circuits.length + policy.pressure.length,
          attempts: attemptCounter.value,
          ...(result.remaining === undefined
            ? {}
            : { remaining: result.remaining }),
          ...(result.source === undefined ? {} : { source: result.source }),
          ...(mode === "wait" ? { waitTimeoutMs: maxWaitMs } : {}),
        },
      });

      return result.permit;
    } catch (error) {
      const rejection = error instanceof ThrottlingRejectedError
        ? error
        : undefined;

      this.recordInstrumentation({
        type: "acquisition",
        outcome: "failure",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          key: policy.id,
          mode,
          result: getAcquisitionErrorResult(error),
          cost: sumCost(estimatedCost),
          estimatedCost,
          constraints: policy.rates.length + policy.concurrency.length
            + policy.circuits.length + policy.pressure.length,
          attempts: attemptCounter.value,
          ...(mode === "wait" ? { waitTimeoutMs: maxWaitMs } : {}),
          ...(rejection?.retryAt === undefined
            ? {}
            : { retryAt: rejection.retryAt.toISOString() }),
          ...(rejection?.source === undefined
            ? {}
            : { source: rejection.source }),
          ...(rejection?.remaining === undefined
            ? {}
            : { remaining: rejection.remaining }),
        },
      });

      throw error;
    }
  }

  public run<Value>(
    definition: ThrottlingDefinition,
    handler: (context: ThrottlingRunContext) => Awaitable<Value>,
  ): Promise<Value>;

  public run<Value>(
    definition: ThrottlingDefinition,
    options: ThrottlingRunOptions,
    handler: (context: ThrottlingRunContext) => Awaitable<Value>,
  ): Promise<Value>;

  public async run<Value>(
    definition: ThrottlingDefinition,
    optionsOrHandler:
      | ThrottlingRunOptions
      | ((context: ThrottlingRunContext) => Awaitable<Value>),
    possibleHandler?: (context: ThrottlingRunContext) => Awaitable<Value>,
  ): Promise<Value> {
    const options = typeof optionsOrHandler === "function"
      ? {}
      : optionsOrHandler;
    const handler = typeof optionsOrHandler === "function"
      ? optionsOrHandler
      : possibleHandler;

    if (handler === undefined) {
      throw new TypeError("A throttled operation handler is required.");
    }

    const policy = this.compileAndRegister(definition, options.rateKey);
    let reportedActualCost: ThrottlingCost | undefined;
    let reportedFeedback: ThrottlingFeedback | undefined;
    const context: ThrottlingRunContext = {
      reportActualCost: (cost) => {
        if (reportedActualCost !== undefined) {
          throw new ThrottlingCostValidationError(
            "Actual throttling cost can only be reported once.",
          );
        }

        reportedActualCost = validateActualCost(policy, cost);
      },
      reportFeedback: (feedback) => {
        if (reportedFeedback !== undefined) {
          throw new TypeError(
            "Throttling feedback can only be reported once.",
          );
        }

        reportedFeedback = validateFeedback(feedback);
      },
    };
    const permit = await this.acquire(definition, options);

    try {
      const result = await handler(context);
      await permit.complete({
        outcome: "success",
        ...(reportedActualCost === undefined
          ? {}
          : { actualCost: reportedActualCost }),
        ...(reportedFeedback === undefined
          ? {}
          : { feedback: reportedFeedback }),
      });
      return result;
    } catch (operationError) {
      try {
        await permit.complete({
          outcome: "failure",
          ...(reportedActualCost === undefined
            ? {}
            : { actualCost: reportedActualCost }),
          ...(reportedFeedback === undefined
            ? {}
            : { feedback: reportedFeedback }),
        });
      } catch (completionError) {
        // A completion error after successful completion is not aggregated.
        if (completionError instanceof ThrottlingPermitCompletedError) {
          throw operationError;
        }

        throw new AggregateError(
          [operationError, completionError],
          `Throttled operation and permit completion both failed for "${policy.id}".`,
        );
      }

      throw operationError;
    }
  }

  public async inspect(
    definition: ThrottlingDefinition,
    options: ThrottlingInspectOptions = {},
  ): Promise<AdmissionAvailability> {
    const policy = this.compileAndRegister(definition, options.rateKey);
    const estimatedCost = validateEstimatedCost(policy, options.estimatedCost);
    const pressureInspection = this.inspectPressure(policy);
    const reasons: AdmissionReason[] = [
      ...pressureInspection.reasons,
      ...this.inspectCircuits(policy),
      ...this.inspectConcurrency(policy),
    ];
    let degraded = pressureInspection.degraded;

    if (pressureInspection.unknown) {
      return { state: "unknown", reasons };
    }

    if (policy.rates.length > 0) {
      if (this.adapter.inspectMany === undefined) {
        throw new ThrottlingAdapterCapabilityError("advisory inspection");
      }

      const requests = this.createRateRequests(policy, estimatedCost);

      if (requests.length === 0) {
        if (reasons.length > 0) return { state: "limited", reasons };
        return degraded
          ? { state: "degraded", reasons: pressureInspection.degradedReasons }
          : { state: "available", reasons: [] };
      }

      try {
        const results = await this.adapter.inspectMany(requests);

        if (results.length !== requests.length) {
          throw new TypeError(
            "The throttling adapter returned an incomplete inspection.",
          );
        }

        results.forEach((result, index) => {
          const constraint = policy.rates.filter(
            (rate) => estimatedCost[rate.unit]! > 0,
          )[index];

          if (result.source === "emergency-local") degraded = true;

          if (!result.available && constraint !== undefined) {
            reasons.push({
              constraintId: constraint.id,
              kind: "rate",
              remaining: result.remaining,
              ...(result.retryAt === undefined
                ? {}
                : { retryAt: result.retryAt }),
            });
          }
        });
      } catch (error) {
        if (!(error instanceof ThrottlingBackendUnavailableError)) throw error;

        return {
          state: "unknown",
          reasons: [
            ...reasons,
            ...policy.rates.map((constraint) => ({
              constraintId: constraint.id,
              kind: "rate" as const,
            })),
          ],
        };
      }
    }

    if (reasons.length > 0) {
      return {
        state: "limited",
        reasons,
        ...getReasonsRetryAt(reasons),
      };
    }

    return degraded
      ? { state: "degraded", reasons: pressureInspection.degradedReasons }
      : { state: "available", reasons: [] };
  }

  /** Rejects queued waiters and prevents later admissions. */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;

    this.closed = true;

    for (const queue of this.waitQueues.values()) this.wakeQueue(queue);
    this.resourcePressureMonitor?.close();

    this.closePromise = Promise.all([
      ...[...this.waitQueues.values()]
        .map((queue) => queue.drainPromise)
        .filter((promise): promise is Promise<void> => promise !== undefined),
      this.deferredReconciliations.close(),
    ])
      .then(() => this.options.closeAdapter === false ? undefined : this.adapter.close?.())
      .then(() => undefined);

    return this.closePromise;
  }

  private async acquireInternal(
    policy: CompiledPolicy,
    estimatedCost: ThrottlingCost,
    maxWaitMs: number,
    signal: AbortSignal | undefined,
    attemptCounter: AttemptCounter,
  ): Promise<AcquiredPermitResult> {
    this.throwIfUnavailable(policy.id, signal);
    const deadlineMs = this.getNowMs() + maxWaitMs;
    const existingQueue = this.waitQueues.get(policy.id);

    if (existingQueue !== undefined && existingQueue.waiters.length > 0) {
      if (maxWaitMs === 0) {
        const retryAt = finiteDate(existingQueue.nextAttemptAtMs);
        if (existingQueue.blockedCircuitId !== undefined) {
          throw new ThrottlingCircuitOpenError(
            policy.id,
            existingQueue.blockedCircuitId,
            retryAt,
          );
        }

        if (existingQueue.blockedPressureConstraintId !== undefined) {
          throw new ThrottlingResourcePressureError(
            policy.id,
            existingQueue.blockedPressureConstraintId,
            existingQueue.blockedPressureSignalIds ?? [],
          );
        }

        throw new ThrottlingRejectedError(policy.id, retryAt);
      }

      return this.enqueue(
        existingQueue,
        policy,
        estimatedCost,
        deadlineMs,
        signal,
        attemptCounter,
      );
    }

    attemptCounter.value += 1;
    const attempt = await this.tryAcquire(policy, estimatedCost);

    if (attempt.admitted) return attempt;

    if (maxWaitMs === 0) {
      if (attempt.blockedBy === "circuit") {
        throw new ThrottlingCircuitOpenError(
          policy.id,
          attempt.circuitId!,
          attempt.retryAt,
        );
      }

      if (attempt.blockedBy === "pressure") {
        throw new ThrottlingResourcePressureError(
          policy.id,
          attempt.pressureConstraintId!,
          attempt.pressureSignalIds ?? [],
        );
      }

      throw new ThrottlingRejectedError(
        policy.id,
        attempt.retryAt,
        attempt.source,
        attempt.remaining,
      );
    }

    this.throwIfUnavailable(policy.id, signal);
    this.throwIfDeadlineElapsed(policy.id, deadlineMs);
    const queue = this.waitQueues.get(policy.id)
      ?? this.createWaitQueue(policy.id, attempt);

    return this.enqueue(
      queue,
      policy,
      estimatedCost,
      deadlineMs,
      signal,
      attemptCounter,
    );
  }

  private async tryAcquire(
    policy: CompiledPolicy,
    estimatedCost: ThrottlingCost,
  ): Promise<AcquisitionAttempt> {
    const pressureAcquisition = this.tryAcquirePressure(policy.pressure);
    if (!pressureAcquisition.admitted) return pressureAcquisition;

    const circuitAcquisition = this.tryAcquireCircuits(policy.circuits);

    if (!circuitAcquisition.admitted) {
      return {
        admitted: false,
        blockedBy: "circuit",
        circuitId: circuitAcquisition.circuitId,
        ...(circuitAcquisition.retryAt === undefined
          ? {}
          : { retryAt: circuitAcquisition.retryAt }),
        source: "local",
      };
    }

    const circuitReservations = circuitAcquisition.reservations;
    const releaseConcurrency = this.tryAcquireConcurrency(policy.concurrency);

    if (releaseConcurrency === undefined) {
      this.releaseCircuitReservations(circuitReservations);
      return { admitted: false, blockedBy: "concurrency", source: "local" };
    }

    try {
      const requests = this.createRateRequests(policy, estimatedCost);
      const result = await this.reserveRates(requests);

      if (!result.admitted) {
        releaseConcurrency();
        this.releaseCircuitReservations(circuitReservations);
        const remaining = minimumRemaining(result.remaining);
        return {
          admitted: false,
          blockedBy: "rate",
          retryAt: result.retryAt,
          ...(remaining === undefined ? {} : { remaining }),
          ...(result.source === undefined ? {} : { source: result.source }),
        };
      }

      const remaining = minimumRemaining(result.remaining);
      return {
        admitted: true,
        permit: this.createPermit(
          policy,
          estimatedCost,
          result.source,
          releaseConcurrency,
          circuitReservations,
        ),
        ...(remaining === undefined ? {} : { remaining }),
        ...(result.source === undefined ? {} : { source: result.source }),
      };
    } catch (error) {
      releaseConcurrency();
      this.releaseCircuitReservations(circuitReservations);
      throw error;
    }
  }

  private reserveRates(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<RateLimitBatchReservationResult> {
    if (requests.length === 0) {
      return Promise.resolve({ admitted: true, remaining: {}, source: "local" });
    }

    if (requests.length === 1) {
      const request = requests[0]!;
      return this.adapter.reserve(request).then((result) => result.admitted
        ? {
            admitted: true,
            remaining: { [request.key]: result.remaining },
            ...(result.source === undefined ? {} : { source: result.source }),
          }
        : {
            admitted: false,
            remaining: { [request.key]: result.remaining },
            retryAt: result.retryAt,
            ...(result.source === undefined ? {} : { source: result.source }),
          });
    }

    if (this.adapter.reserveMany === undefined) {
      throw new ThrottlingAdapterCapabilityError("atomic batch reservation");
    }

    return this.adapter.reserveMany(requests);
  }

  /** Checks cached local pressure before reserving any other capacity. */
  private tryAcquirePressure(
    constraints: readonly CompiledLocalResourcePressure[],
  ): { readonly admitted: true } | DeniedAttempt {
    if (constraints.length === 0) return { admitted: true };
    const monitor = this.requireResourcePressureMonitor();

    for (const constraint of constraints) {
      const evaluation = monitor.evaluate(
        constraint.key,
        constraint.signals,
        constraint.onUnavailable,
      );
      const rejected = evaluation.state === "limited"
        || evaluation.state === "unknown";
      this.recordPressureEvaluation(constraint, evaluation, rejected);

      if (rejected) {
        return {
          admitted: false,
          blockedBy: "pressure",
          pressureConstraintId: constraint.id,
          pressureSignalIds: evaluation.signals
            .filter((signal) =>
              signal.state === "limited"
              || (signal.state === "unknown"
                && constraint.onUnavailable === "reject"))
            .map((signal) => signal.signalId),
          nextAttemptAtMs: evaluation.refreshAt.getTime(),
          source: "local",
        };
      }
    }

    return { admitted: true };
  }

  private inspectPressure(policy: CompiledPolicy): {
    readonly degraded: boolean;
    readonly degradedReasons: readonly AdmissionReason[];
    readonly reasons: readonly AdmissionReason[];
    readonly unknown: boolean;
  } {
    if (policy.pressure.length === 0) {
      return {
        degraded: false,
        degradedReasons: [],
        reasons: [],
        unknown: false,
      };
    }

    const monitor = this.requireResourcePressureMonitor();
    const evaluations = policy.pressure.map((constraint) => ({
      constraint,
      evaluation: monitor.evaluate(
        constraint.key,
        constraint.signals,
        constraint.onUnavailable,
      ),
    }));

    for (const { constraint, evaluation } of evaluations) {
      this.recordPressureEvaluation(constraint, evaluation, false);
    }

    const toReasons = (
      predicate: (
        constraint: CompiledLocalResourcePressure,
        state: LocalResourcePressureEvaluation["signals"][number]["state"],
      ) => boolean,
    ): AdmissionReason[] => evaluations.flatMap(({ constraint, evaluation }) =>
      evaluation.signals.flatMap((signal) => predicate(
          constraint,
          signal.state,
        )
        ? [{
            constraintId: constraint.id,
            kind: "pressure" as const,
            signalId: signal.signalId,
            ...(signal.value === undefined ? {} : { value: signal.value }),
          }]
        : []));
    const unknown = evaluations.some(({ evaluation, constraint }) =>
      constraint.onUnavailable === "reject"
      && evaluation.signals.some((signal) => signal.state === "unknown"));
    const limited = evaluations.some(({ evaluation }) =>
      evaluation.state === "limited");
    const degraded = evaluations.some(({ evaluation }) =>
      evaluation.state === "degraded");

    return {
      degraded,
      degradedReasons: toReasons((constraint, state) =>
        state === "degraded"
        || (state === "unknown" && constraint.onUnavailable === "ignore")),
      reasons: limited || unknown
        ? toReasons((constraint, state) =>
            state === "limited"
            || (state === "unknown"
              && constraint.onUnavailable === "reject"))
        : [],
      unknown,
    };
  }

  private requireResourcePressureMonitor(): LocalResourcePressureMonitor {
    if (this.resourcePressureMonitor === undefined) {
      throw new ThrottlingAdapterCapabilityError(
        "process-local resource pressure monitoring",
      );
    }

    return this.resourcePressureMonitor;
  }

  private recordPressureEvaluation(
    constraint: CompiledLocalResourcePressure,
    evaluation: LocalResourcePressureEvaluation,
    rejected: boolean,
  ): void {
    for (const signal of evaluation.signals) {
      if (signal.previousState !== undefined) {
        this.recordInstrumentation({
          type: "pressure",
          durationMs: 0,
          outcome: signal.state === "limited" || signal.state === "unknown"
            ? "failure"
            : "success",
          data: {
            key: constraint.key,
            operation: "transition",
            signal: signal.signalId,
            state: signal.state,
            previousState: signal.previousState,
            ...(signal.value === undefined ? {} : { value: signal.value }),
          },
        });
      }

      if (
        rejected
        && (signal.state === "limited"
          || (signal.state === "unknown"
            && constraint.onUnavailable === "reject"))
      ) {
        this.recordInstrumentation({
          type: "pressure",
          durationMs: 0,
          outcome: "failure",
          data: {
            key: constraint.key,
            operation: "rejection",
            signal: signal.signalId,
            state: signal.state,
            ...(signal.value === undefined ? {} : { value: signal.value }),
          },
        });
      }
    }
  }

  private enqueue(
    queue: WaitQueue,
    policy: CompiledPolicy,
    estimatedCost: ThrottlingCost,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    attemptCounter: AttemptCounter,
  ): Promise<AcquiredPermitResult> {
    if (this.pendingAcquisitions >= this.maxPendingAcquisitions) {
      throw new ThrottlingQueueFullError(policy.id);
    }

    this.throwIfUnavailable(policy.id, signal);
    this.throwIfDeadlineElapsed(policy.id, deadlineMs);
    this.pendingAcquisitions += 1;

    const result = new Promise<AcquiredPermitResult>((resolve, reject) => {
      const waiter: PendingAcquisition = {
        policy,
        estimatedCost,
        deadlineMs,
        ...(signal === undefined ? {} : { signal }),
        attemptCounter,
        resolve,
        reject,
      };

      if (signal !== undefined) {
        const abortListener = () => this.wakeQueue(queue);
        waiter.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }

      queue.waiters.push(waiter);
    });

    this.wakeQueue(queue);
    this.startDraining(queue);
    return result;
  }

  private createWaitQueue(
    key: string,
    attempt: DeniedAttempt,
  ): WaitQueue {
    const queue: WaitQueue = {
      key,
      waiters: [],
      nextAttemptAtMs: attempt.nextAttemptAtMs
        ?? attempt.retryAt?.getTime()
        ?? Number.POSITIVE_INFINITY,
      blockedByConcurrency: attempt.blockedBy === "concurrency",
      ...(attempt.blockedBy === "circuit"
        ? { blockedCircuitId: attempt.circuitId }
        : {}),
      ...(attempt.blockedBy === "pressure"
        ? {
            blockedPressureConstraintId: attempt.pressureConstraintId,
            blockedPressureSignalIds: attempt.pressureSignalIds,
          }
        : {}),
    };

    this.waitQueues.set(key, queue);
    return queue;
  }

  private startDraining(queue: WaitQueue): void {
    if (queue.drainPromise !== undefined) return;

    queue.drainPromise = this.drainQueue(queue)
      .catch((error: unknown) => this.rejectAll(queue, error))
      .finally(() => {
        delete queue.drainPromise;

        if (queue.waiters.length === 0) this.waitQueues.delete(queue.key);
        else this.startDraining(queue);
      });
  }

  private async drainQueue(queue: WaitQueue): Promise<void> {
    while (queue.waiters.length > 0) {
      if (this.closed) {
        this.rejectAll(queue, new ThrottlingClosedError());
        return;
      }

      const nowMs = this.getNowMs();
      this.rejectUnavailableWaiters(queue, nowMs);
      if (queue.waiters.length === 0) return;

      const earliestDeadlineMs = Math.min(
        ...queue.waiters.map((waiter) => waiter.deadlineMs),
      );
      const nextWakeAtMs = Math.min(queue.nextAttemptAtMs, earliestDeadlineMs);

      if (nextWakeAtMs > nowMs) {
        await this.waitForQueue(queue, nextWakeAtMs - nowMs);
        continue;
      }

      const waiter = queue.waiters[0]!;
      waiter.attemptCounter.value += 1;
      const attempt = await this.tryAcquire(waiter.policy, waiter.estimatedCost);

      if (attempt.admitted) {
        queue.waiters.shift();
        queue.nextAttemptAtMs = this.getNowMs();
        queue.blockedByConcurrency = false;
        delete queue.blockedCircuitId;
        delete queue.blockedPressureConstraintId;
        delete queue.blockedPressureSignalIds;
        this.resolveWaiter(queue, waiter, attempt);
      } else {
        queue.nextAttemptAtMs = attempt.nextAttemptAtMs
          ?? attempt.retryAt?.getTime()
          ?? Number.POSITIVE_INFINITY;
        queue.blockedByConcurrency = attempt.blockedBy === "concurrency";
        if (attempt.blockedBy === "circuit") {
          queue.blockedCircuitId = attempt.circuitId!;
        } else {
          delete queue.blockedCircuitId;
        }
        if (attempt.blockedBy === "pressure") {
          queue.blockedPressureConstraintId = attempt.pressureConstraintId!;
          queue.blockedPressureSignalIds = attempt.pressureSignalIds ?? [];
        } else {
          delete queue.blockedPressureConstraintId;
          delete queue.blockedPressureSignalIds;
        }
      }
    }
  }

  private rejectUnavailableWaiters(queue: WaitQueue, nowMs: number): void {
    const remaining: PendingAcquisition[] = [];

    for (const waiter of queue.waiters) {
      if (waiter.signal?.aborted === true) {
        this.rejectWaiter(
          queue,
          waiter,
          new ThrottlingAcquisitionAbortedError(waiter.policy.id),
        );
      } else if (waiter.deadlineMs <= nowMs) {
        this.rejectWaiter(
          queue,
          waiter,
          new ThrottlingAcquisitionTimeoutError(waiter.policy.id),
        );
      } else {
        remaining.push(waiter);
      }
    }

    queue.waiters = remaining;
  }

  private async waitForQueue(queue: WaitQueue, delayMs: number): Promise<void> {
    const controller = new AbortController();
    queue.wakeController = controller;

    try {
      await this.sleep(delayMs, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (queue.wakeController === controller) delete queue.wakeController;
    }
  }

  private wakeQueue(queue: WaitQueue): void {
    queue.wakeController?.abort();
  }

  private wakeConcurrencyQueues(): void {
    const nowMs = this.getNowMs();

    for (const queue of this.waitQueues.values()) {
      if (!queue.blockedByConcurrency) continue;
      queue.nextAttemptAtMs = nowMs;
      this.wakeQueue(queue);
    }
  }

  private rejectAll(queue: WaitQueue, error: unknown): void {
    for (const waiter of queue.waiters.splice(0)) {
      this.rejectWaiter(queue, waiter, error);
    }
  }

  private resolveWaiter(
    queue: WaitQueue,
    waiter: PendingAcquisition,
    result: AdmittedAttempt,
  ): void {
    this.finishWaiter(waiter);
    waiter.resolve({
      permit: result.permit,
      ...(result.remaining === undefined ? {} : { remaining: result.remaining }),
      ...(result.source === undefined ? {} : { source: result.source }),
    });
    this.wakeQueue(queue);
  }

  private rejectWaiter(
    queue: WaitQueue,
    waiter: PendingAcquisition,
    error: unknown,
  ): void {
    this.finishWaiter(waiter);
    waiter.reject(error);
    this.wakeQueue(queue);
  }

  private finishWaiter(waiter: PendingAcquisition): void {
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }

    this.pendingAcquisitions -= 1;
  }

  /** Reserves half-open probes atomically across every local circuit. */
  private tryAcquireCircuits(
    constraints: readonly CompiledCircuitBreaker[],
  ): CircuitAcquisition {
    const nowMs = this.getNowMs();
    const states = constraints.map((constraint) => {
      const state = this.getCircuitState(constraint);
      this.refreshCircuitState(constraint, state, nowMs);
      return { constraint, state };
    });

    for (const { constraint, state } of states) {
      if (state.state === "open") {
        return {
          admitted: false,
          circuitId: constraint.id,
          ...getCircuitRetryAt(state),
        };
      }

      if (
        state.state === "half-open"
        && state.activeProbes >= constraint.halfOpen.maxConcurrentProbes
      ) {
        return { admitted: false, circuitId: constraint.id };
      }
    }

    const reservations = states.map(({ constraint, state }) => {
      const probe = state.state === "half-open";

      if (probe) {
        state.activeProbes += 1;
        this.recordCircuitEvent(constraint, state, "probe");
      }

      return {
        constraint,
        generation: state.generation,
        probe,
      } satisfies CircuitReservation;
    });

    return { admitted: true, reservations };
  }

  /** Returns probes when a later composed constraint rejects admission. */
  private releaseCircuitReservations(
    reservations: readonly CircuitReservation[],
  ): void {
    for (const reservation of reservations) {
      if (!reservation.probe) continue;
      const state = this.circuitStates.get(reservation.constraint.key);

      if (
        state === undefined
        || state.generation !== reservation.generation
        || state.state !== "half-open"
      ) {
        continue;
      }

      state.activeProbes = Math.max(0, state.activeProbes - 1);
      this.recordCircuitEvent(reservation.constraint, state, "probe");
      this.wakeCircuitQueues(reservation.constraint.id);
    }
  }

  private getCircuitState(constraint: CompiledCircuitBreaker): CircuitState {
    const existing = this.circuitStates.get(constraint.key);
    if (existing !== undefined) return existing;

    const state: CircuitState = {
      activeProbes: 0,
      consecutiveFailures: 0,
      generation: 0,
      halfOpenSuccesses: 0,
      state: "closed",
    };
    this.circuitStates.set(constraint.key, state);
    return state;
  }

  private refreshCircuitState(
    constraint: CompiledCircuitBreaker,
    state: CircuitState,
    nowMs: number,
  ): void {
    if (
      state.state !== "open"
      || state.openUntilMs === undefined
      || state.openUntilMs > nowMs
    ) {
      return;
    }

    this.transitionCircuit(constraint, state, "half-open");
  }

  private inspectCircuits(policy: CompiledPolicy): AdmissionReason[] {
    const nowMs = this.getNowMs();

    return policy.circuits.flatMap((constraint) => {
      const state = this.getCircuitState(constraint);
      this.refreshCircuitState(constraint, state, nowMs);

      if (state.state === "open") {
        return [{
          constraintId: constraint.id,
          kind: "circuit" as const,
          ...getCircuitRetryAt(state),
        }];
      }

      return state.state === "half-open"
        && state.activeProbes >= constraint.halfOpen.maxConcurrentProbes
        ? [{ constraintId: constraint.id, kind: "circuit" as const }]
        : [];
    });
  }

  private wakeCircuitQueues(circuitId: string, retryAtMs?: number): void {
    for (const queue of this.waitQueues.values()) {
      if (queue.blockedCircuitId !== circuitId) continue;
      queue.nextAttemptAtMs = retryAtMs ?? this.getNowMs();
      this.wakeQueue(queue);
    }
  }

  private tryAcquireConcurrency(
    constraints: readonly CompiledConcurrencyLimit[],
  ): (() => void) | undefined {
    const states = constraints.map((constraint) => {
      const state = this.concurrencyStates.get(constraint.key) ?? {
        active: 0,
        limit: constraint.limit,
      };

      if (state.limit !== constraint.limit) {
        throw new TypeError(
          `Concurrency limit "${constraint.id}" uses conflicting capacities.`,
        );
      }

      this.concurrencyStates.set(constraint.key, state);
      return state;
    });

    if (states.some((state) => state.active >= state.limit)) return undefined;

    for (const state of states) state.active += 1;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      for (const state of states) state.active -= 1;
      this.wakeConcurrencyQueues();
    };
  }

  private inspectConcurrency(policy: CompiledPolicy): AdmissionReason[] {
    return policy.concurrency.flatMap((constraint) => {
      const state = this.concurrencyStates.get(constraint.key);
      const active = state?.active ?? 0;

      return active >= constraint.limit
        ? [{ constraintId: constraint.id, kind: "concurrency" as const }]
        : [];
    });
  }

  private createRateRequests(
    policy: CompiledPolicy,
    estimatedCost: ThrottlingCost,
  ): readonly RateLimitReservationRequest[] {
    return policy.rates.flatMap((constraint) => {
      const cost = estimatedCost[constraint.unit]!;

      if (cost === 0) return [];

      if (cost > constraint.burst) {
        throw new ThrottlingCostExceedsBurstError(
          constraint.id,
          cost,
          constraint.burst,
        );
      }

      return [{
        key: constraint.key,
        limit: constraint.limit,
        periodMs: constraint.periodMs,
        burst: constraint.burst,
        cost,
        coordination: constraint.coordination,
      }];
    });
  }

  /** Applies one invocation-wide terminal classification to local circuits. */
  private applyCircuitFeedback(
    reservations: readonly CircuitReservation[],
    feedback: ThrottlingClassifiedFeedback,
    completion: ThrottlingPermitCompletion,
  ): void {
    const nowMs = this.getNowMs();

    for (const reservation of reservations) {
      const { constraint } = reservation;
      const state = this.circuitStates.get(constraint.key);

      // Completions from an older closed or half-open generation are stale.
      if (state === undefined || state.generation !== reservation.generation) {
        continue;
      }

      if (reservation.probe && state.state === "half-open") {
        state.activeProbes = Math.max(0, state.activeProbes - 1);
      }

      this.recordCircuitEvent(constraint, state, "feedback", feedback);

      if (feedback === "throttled") {
        const reportedRetryAt = completion.feedback?.kind === "throttled"
          ? completion.feedback.retryAt?.getTime()
          : undefined;
        const openUntilMs = reportedRetryAt !== undefined
          && reportedRetryAt > nowMs
          ? reportedRetryAt
          : nowMs + constraint.cooldownMs;
        this.openCircuit(constraint, state, openUntilMs);
        continue;
      }

      const healthy = feedback === "success" || feedback === "permanent";

      if (state.state === "half-open") {
        if (!healthy) {
          this.openCircuit(
            constraint,
            state,
            nowMs + constraint.cooldownMs,
          );
          continue;
        }

        state.halfOpenSuccesses += 1;
        if (state.halfOpenSuccesses >= constraint.halfOpen.successThreshold) {
          this.transitionCircuit(constraint, state, "closed");
        } else {
          this.wakeCircuitQueues(constraint.id);
        }
        continue;
      }

      if (state.state !== "closed") continue;

      if (healthy) {
        state.consecutiveFailures = 0;
        continue;
      }

      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= constraint.failureThreshold) {
        this.openCircuit(
          constraint,
          state,
          nowMs + constraint.cooldownMs,
        );
      }
    }
  }

  private openCircuit(
    constraint: CompiledCircuitBreaker,
    state: CircuitState,
    openUntilMs: number,
  ): void {
    state.openUntilMs = openUntilMs;
    this.transitionCircuit(constraint, state, "open");
    this.wakeCircuitQueues(constraint.id, openUntilMs);
  }

  private transitionCircuit(
    constraint: CompiledCircuitBreaker,
    state: CircuitState,
    nextState: ThrottlingCircuitState,
  ): void {
    const previousState = state.state;
    state.state = nextState;
    state.generation += 1;
    state.activeProbes = 0;
    state.halfOpenSuccesses = 0;

    if (nextState === "closed") {
      state.consecutiveFailures = 0;
      delete state.openUntilMs;
    } else if (nextState === "half-open") {
      delete state.openUntilMs;
    }

    this.recordCircuitEvent(
      constraint,
      state,
      "transition",
      undefined,
      previousState,
    );
  }

  private recordCircuitEvent(
    constraint: CompiledCircuitBreaker,
    state: CircuitState,
    operation: "feedback" | "probe" | "transition",
    feedback?: ThrottlingClassifiedFeedback,
    previousState?: ThrottlingCircuitState,
  ): void {
    this.recordInstrumentation({
      type: "circuit",
      outcome: state.state === "open"
        || feedback === "timeout"
        || feedback === "transient"
        || feedback === "throttled"
        ? "failure"
        : "success",
      durationMs: 0,
      data: {
        key: constraint.key,
        operation,
        state: state.state,
        consecutiveFailures: state.consecutiveFailures,
        activeProbes: state.activeProbes,
        ...(previousState === undefined ? {} : { previousState }),
        ...(feedback === undefined ? {} : { feedback }),
        ...getCircuitRetryAtIso(state),
      },
    });
  }

  private createPermit(
    policy: CompiledPolicy,
    estimatedCost: ThrottlingCost,
    source: RateLimitReservationSource | undefined,
    releaseConcurrency: () => void,
    circuitReservations: readonly CircuitReservation[],
  ): ThrottlingPermit {
    const acquiredAtMs = this.measureTime();

    return new ThrottlingPermitImpl(
      policy.id,
      (completion) => this.completePermit(
        policy,
        estimatedCost,
        source,
        releaseConcurrency,
        circuitReservations,
        acquiredAtMs,
        completion,
      ),
    );
  }

  private async completePermit(
    policy: CompiledPolicy,
    estimatedCost: ThrottlingCost,
    source: RateLimitReservationSource | undefined,
    releaseConcurrency: () => void,
    circuitReservations: readonly CircuitReservation[],
    acquiredAtMs: number,
    completion: ThrottlingPermitCompletion,
  ): Promise<void> {
    const startedAt = this.measureTime();
    let reconciliation:
      | "disabled"
      | "failed"
      | "not-needed"
      | "reconciled"
      | "scheduled" = "not-needed";
    let actualCost = estimatedCost;
    let reconciliationError: unknown;
    const feedback = classifyCompletionFeedback(completion);

    try {
      // Circuit health changes synchronously and never waits on cost storage.
      this.applyCircuitFeedback(circuitReservations, feedback, completion);

      if (completion.actualCost !== undefined) {
        actualCost = validateActualCost(policy, completion.actualCost);
        const requests = this.createReconciliationRequests(
          policy,
          estimatedCost,
          actualCost,
          source,
        );

        if (
          requests.length > 0
          && policy.reconciliationMode === "disabled"
        ) {
          reconciliation = "disabled";
        } else if (requests.length > 0) {
          if (this.adapter.reconcile === undefined) {
            throw new ThrottlingAdapterCapabilityError("cost reconciliation");
          }

          if (policy.reconciliationMode === "asynchronous") {
            this.scheduleReconciliation(
              policy,
              estimatedCost,
              actualCost,
              requests,
            );
            reconciliation = "scheduled";
          } else {
            await this.adapter.reconcile(requests);
            reconciliation = "reconciled";
          }
        }
      }
    } catch (error) {
      reconciliation = "failed";
      reconciliationError = error;
    } finally {
      releaseConcurrency();
    }

    const completedAt = this.measureTime();
    this.recordInstrumentation({
      type: "completion",
      outcome: reconciliationError === undefined
        ? completion.outcome
        : "failure",
      durationMs: getDuration(startedAt, completedAt),
      data: {
        key: policy.id,
        result: completion.outcome,
        cost: sumCost(actualCost),
        estimatedCost,
        actualCost,
        reconciliation,
        heldDurationMs: getDuration(acquiredAtMs, completedAt),
        ...(policy.circuits.length === 0 && completion.feedback === undefined
          ? {}
          : { feedback }),
      },
    });

    if (reconciliationError !== undefined) throw reconciliationError;
  }

  private scheduleReconciliation(
    policy: CompiledPolicy,
    estimatedCost: ThrottlingCost,
    actualCost: ThrottlingCost,
    requests: readonly RateLimitReconciliationRequest[],
  ): void {
    // Capability is checked by the caller before ownership is transferred.
    const reconcile = this.adapter.reconcile!;

    const task = async () => {
      const startedAt = this.measureTime();
      let result: "failed" | "reconciled" = "reconciled";

      try {
        await reconcile.call(this.adapter, requests);
      } catch {
        // Best-effort mode never changes the already returned operation result.
        result = "failed";
      }

      this.recordInstrumentation({
        type: "reconciliation",
        outcome: result === "reconciled" ? "success" : "failure",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          key: policy.id,
          result,
          estimatedCost,
          actualCost,
          constraints: requests.length,
        },
      });
    };

    try {
      this.deferredReconciliations.defer(task, {
        name: `throttling-reconciliation:${policy.id}`,
      });
    } catch (error) {
      if (!(error instanceof DeferredTasksClosedError)) throw error;

      // A permit may finish while manager disposal is already complete.
      this.recordInstrumentation({
        type: "reconciliation",
        outcome: "failure",
        durationMs: 0,
        data: {
          key: policy.id,
          result: "failed",
          estimatedCost,
          actualCost,
          constraints: requests.length,
        },
      });
    }
  }

  private createReconciliationRequests(
    policy: CompiledPolicy,
    estimatedCost: ThrottlingCost,
    actualCost: ThrottlingCost,
    source: RateLimitReservationSource | undefined,
  ): readonly RateLimitReconciliationRequest[] {
    return policy.rates.flatMap((constraint) => {
      const estimated = estimatedCost[constraint.unit]!;
      const actual = actualCost[constraint.unit]!;

      if (estimated === actual) return [];

      return [{
        key: constraint.key,
        limit: constraint.limit,
        periodMs: constraint.periodMs,
        burst: constraint.burst,
        // The base request cost remains the admitted estimate for validation.
        cost: estimated === 0 ? Number.EPSILON : estimated,
        estimatedCost: estimated,
        actualCost: actual,
        coordination: constraint.coordination,
        ...(source === undefined ? {} : { reservationSource: source }),
      }];
    });
  }

  private compileAndRegister(
    definition: ThrottlingDefinition,
    rateKey?: string,
  ): CompiledPolicy {
    validateThrottlingDefinition(definition);
    const policy = compileDefinition(this.namespace, definition);
    const existing = this.definitionSignatures.get(policy.id);

    if (existing !== undefined && existing !== policy.definitionSignature) {
      throw new TypeError(
        `Throttling definition id "${policy.id}" is already registered with another policy.`,
      );
    }

    this.definitionSignatures.set(policy.id, policy.definitionSignature);

    for (const constraint of [
      ...policy.rates,
      ...policy.concurrency,
      ...policy.circuits,
      ...policy.pressure,
    ]) {
      const signature = constraint.kind === "rate-limit-constraint"
        ? [
            constraint.kind,
            constraint.unit,
            constraint.scope,
            constraint.limit,
            constraint.periodMs,
            constraint.burst,
            JSON.stringify(constraint.coordination),
          ].join(":")
        : constraint.kind === "concurrency-limit"
          ? [constraint.kind, constraint.scope, constraint.limit].join(":")
          : constraint.kind === "local-resource-pressure"
            ? [
                constraint.kind,
                constraint.scope,
                constraint.onUnavailable,
                JSON.stringify(constraint.signals),
              ].join(":")
          : [
              constraint.kind,
              constraint.scope,
              constraint.failureThreshold,
              constraint.cooldownMs,
              constraint.halfOpen.maxConcurrentProbes,
              constraint.halfOpen.successThreshold,
            ].join(":");
      const registered = this.constraintSignatures.get(constraint.key);

      if (registered !== undefined && registered !== signature) {
        throw new TypeError(
          `Throttling constraint id "${constraint.id}" is already registered with another policy.`,
        );
      }

      this.constraintSignatures.set(constraint.key, signature);

      if (constraint.kind === "local-resource-pressure") {
        const monitor = this.requireResourcePressureMonitor();
        const unsupported = constraint.signals.find((signal) =>
          !monitor.supports(signal.id));

        if (unsupported !== undefined) {
          throw new ThrottlingAdapterCapabilityError(
            `local resource pressure signal "${unsupported.id}"`,
          );
        }
      }
    }

    return partitionRatePolicy(policy, rateKey);
  }

  private throwIfUnavailable(definitionId: string, signal?: AbortSignal): void {
    if (this.closed) throw new ThrottlingClosedError();
    if (signal?.aborted === true) {
      throw new ThrottlingAcquisitionAbortedError(definitionId);
    }
  }

  private getNowMs(): number {
    const value = this.now().getTime();

    if (!Number.isFinite(value)) {
      throw new TypeError("The throttling clock returned an invalid date.");
    }

    return value;
  }

  private throwIfDeadlineElapsed(definitionId: string, deadlineMs: number): void {
    if (this.getNowMs() >= deadlineMs) {
      throw new ThrottlingAcquisitionTimeoutError(definitionId);
    }
  }

  private measureTime(): number {
    if (this.instrumentation === undefined) return 0;

    try {
      const value = this.monotonicNow();
      return Number.isFinite(value) ? value : performance.now();
    } catch {
      return performance.now();
    }
  }

  private recordInstrumentation(event: ThrottlingInstrumentationEvent): void {
    if (this.instrumentation === undefined) return;

    try {
      this.instrumentation.record({
        ...event,
        data: {
          ...event.data,
          key: this.formatObservationKey(event.data.key),
        },
      } as ThrottlingInstrumentationEvent);
    } catch {
      // Instrumentation cannot alter admission or permit completion.
    }
  }
}

/** Mutable internal permit with reconciliation and terminal local release. */
class ThrottlingPermitImpl implements ThrottlingPermit {
  private completed = false;

  public constructor(
    public readonly definitionId: string,
    private readonly onComplete: (
      completion: ThrottlingPermitCompletion,
    ) => Promise<void>,
  ) {}

  public async complete(completion: ThrottlingPermitCompletion): Promise<void> {
    if (this.completed) {
      throw new ThrottlingPermitCompletedError(this.definitionId);
    }

    if (completion.outcome !== "success" && completion.outcome !== "failure") {
      throw new TypeError("A throttling permit outcome must be terminal.");
    }

    let normalizedCompletion = completion;

    if (completion.feedback !== undefined) {
      const feedback = validateFeedback(completion.feedback);
      normalizedCompletion = { ...completion, feedback };
    }

    this.completed = true;
    await this.onComplete(normalizedCompletion);
  }
}

function compileDefinition(
  namespace: string,
  definition: ThrottlingDefinition,
): CompiledPolicy {
  if (definition.kind === "rate-limit") {
    const rate: CompiledRateLimit = {
      kind: "rate-limit-constraint",
      id: definition.id,
      unit: "requests",
      limit: definition.limit,
      periodMs: definition.periodMs,
      burst: definition.burst,
      scope: "application",
      coordination: definition.coordination,
      key: `${namespace}:${definition.id}`,
    };

    return {
      id: definition.id,
      definitionSignature: JSON.stringify(definition),
      rates: [rate],
      concurrency: [],
      circuits: [],
      pressure: [],
      units: ["requests"],
      simple: true,
      reconciliationMode: "disabled",
    };
  }

  const rates = definition.limits
    .filter((limit): limit is RateLimitConstraint =>
      limit.kind === "rate-limit-constraint")
    .map((limit) => ({ ...limit, key: `${namespace}:${limit.id}` }));
  const concurrency = definition.limits
    .filter((limit): limit is ConcurrencyLimitConstraint =>
      limit.kind === "concurrency-limit")
    .map((limit) => ({ ...limit, key: `${namespace}:${limit.id}` }));
  const circuits = definition.limits
    .filter((limit): limit is CircuitBreakerConstraint =>
      limit.kind === "circuit-breaker")
    .map((limit) => ({ ...limit, key: `${namespace}:${limit.id}` }));
  const pressure = definition.limits
    .filter((limit): limit is LocalResourcePressureConstraint =>
      limit.kind === "local-resource-pressure")
    .map((limit) => ({ ...limit, key: `${namespace}:${limit.id}` }));

  return {
    id: definition.id,
    definitionSignature: JSON.stringify(definition),
    rates,
    concurrency,
    circuits,
    pressure,
    units: [...new Set(rates.map((rate) => rate.unit))].sort(),
    simple: false,
    reconciliationMode: definition.costAccounting.reconciliation,
  };
}

/** Applies caller cardinality only after registering the stable definition. */
function partitionRatePolicy(
  policy: CompiledPolicy,
  rateKey: string | undefined,
): CompiledPolicy {
  if (rateKey === undefined) {
    return policy;
  }

  const normalized = rateKey.trim();

  if (normalized.length === 0 || normalized.length > 256) {
    throw new TypeError(
      "Throttling rate keys must contain between 1 and 256 characters.",
    );
  }

  return {
    ...policy,
    rates: policy.rates.map((rate) => ({
      ...rate,
      key: `${rate.key}:${normalized}`,
    })),
  };
}

function validateEstimatedCost(
  policy: CompiledPolicy,
  provided: ThrottlingCost | undefined,
): ThrottlingCost {
  if (provided === undefined && policy.simple) {
    return Object.freeze({ requests: 1 });
  }

  if (provided === undefined && policy.units.length > 0) {
    throw new ThrottlingCostValidationError(
      `Admission policy "${policy.id}" requires estimatedCost.`,
    );
  }

  return validateCostRecord(policy, provided ?? {}, "estimatedCost");
}

function validateActualCost(
  policy: CompiledPolicy,
  cost: ThrottlingCost,
): ThrottlingCost {
  return validateCostRecord(policy, cost, "actualCost");
}

function validateCostRecord(
  policy: CompiledPolicy,
  cost: ThrottlingCost,
  label: string,
): ThrottlingCost {
  const keys = Object.keys(cost).sort();

  if (
    keys.length !== policy.units.length
    || keys.some((key, index) => key !== policy.units[index])
  ) {
    throw new ThrottlingCostValidationError(
      `${label} must contain exactly these dimensions: ${policy.units.join(", ") || "none"}.`,
    );
  }

  for (const [unit, value] of Object.entries(cost)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ThrottlingCostValidationError(
        `${label}.${unit} must be a non-negative finite number.`,
      );
    }
  }

  return Object.freeze({ ...cost });
}

function getReasonsRetryAt(
  reasons: readonly AdmissionReason[],
): { retryAt?: Date } {
  const dates = reasons.flatMap((reason) =>
    reason.retryAt === undefined ? [] : [reason.retryAt]);

  return dates.length === 0
    ? {}
    : { retryAt: new Date(Math.max(...dates.map((date) => date.getTime()))) };
}

function minimumRemaining(
  remaining: Readonly<Record<string, number>>,
): number | undefined {
  const values = Object.values(remaining);
  return values.length === 0 ? undefined : Math.min(...values);
}

function finiteDate(value: number): Date | undefined {
  return Number.isFinite(value) ? new Date(value) : undefined;
}

function getCircuitRetryAt(state: CircuitState): { retryAt?: Date } {
  return state.state === "open" && state.openUntilMs !== undefined
    ? { retryAt: new Date(state.openUntilMs) }
    : {};
}

function getCircuitRetryAtIso(state: CircuitState): { retryAt?: string } {
  return state.state === "open" && state.openUntilMs !== undefined
    ? { retryAt: new Date(state.openUntilMs).toISOString() }
    : {};
}

function classifyCompletionFeedback(
  completion: ThrottlingPermitCompletion,
): ThrottlingClassifiedFeedback {
  if (completion.feedback !== undefined) return completion.feedback.kind;
  return completion.outcome === "success" ? "success" : "transient";
}

function validateFeedback(feedback: ThrottlingFeedback): ThrottlingFeedback {
  if (typeof feedback !== "object" || feedback === null) {
    throw new TypeError("Throttling feedback must be an object.");
  }

  if (
    feedback.kind !== "permanent"
    && feedback.kind !== "throttled"
    && feedback.kind !== "timeout"
    && feedback.kind !== "transient"
  ) {
    throw new TypeError("Unsupported throttling feedback kind.");
  }

  if (feedback.kind !== "throttled") {
    return Object.freeze({ kind: feedback.kind });
  }

  if (feedback.retryAt === undefined) {
    return Object.freeze({ kind: "throttled" });
  }

  if (!(feedback.retryAt instanceof Date)) {
    throw new TypeError("Throttling feedback retryAt must be a valid date.");
  }

  const retryAtMs = feedback.retryAt.getTime();
  if (!Number.isFinite(retryAtMs)) {
    throw new TypeError("Throttling feedback retryAt must be a valid date.");
  }

  return Object.freeze({
    kind: "throttled",
    retryAt: new Date(retryAtMs),
  });
}

function sumCost(cost: ThrottlingCost): number {
  return Object.values(cost).reduce((sum, value) => sum + value, 0);
}

function validateManagerOptions(options: ThrottlingManagerOptions): void {
  const namespace = options.namespace.trim();

  if (namespace.length === 0) {
    throw new TypeError("Throttling namespaces cannot be empty.");
  }

  if (namespace.includes(":")) {
    throw new TypeError("Throttling namespaces cannot contain colons.");
  }

  const maxPending = options.maxPendingAcquisitions
    ?? DEFAULT_MAX_PENDING_ACQUISITIONS;

  if (!Number.isInteger(maxPending) || maxPending < 0) {
    throw new TypeError(
      "maxPendingAcquisitions must be a non-negative integer.",
    );
  }
}

function validateNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number.`);
  }
}

function getAcquisitionErrorResult(error: unknown): ThrottlingAcquisitionResult {
  if (error instanceof ThrottlingRejectedError) return "rejected";
  if (error instanceof ThrottlingAcquisitionTimeoutError) return "timeout";
  if (error instanceof ThrottlingAcquisitionAbortedError) return "aborted";
  if (error instanceof ThrottlingQueueFullError) return "queue-full";
  if (error instanceof ThrottlingClosedError) return "closed";
  return "error";
}

function getDuration(startedAt: number, completedAt: number): number {
  return Math.max(0, completedAt - startedAt);
}

async function defaultSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  await sleep(delayMs, undefined, { signal });
}
