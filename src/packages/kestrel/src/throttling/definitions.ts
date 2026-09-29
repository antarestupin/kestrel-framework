import {
  type ThrottlingDuration,
  throttlingDurationToMs,
} from "./duration.js";

export type ThrottlingScope = "application" | "process";

export type ActualCostReconciliationMode =
  | "asynchronous"
  | "disabled"
  | "synchronous";

export interface CostAccountingOptions {
  readonly reconciliation?: ActualCostReconciliationMode;
}

export interface CostAccountingDefinition {
  readonly reconciliation: ActualCostReconciliationMode;
}

export interface ExactCoordinationDefinition {
  readonly strategy: "exact";
}

export interface LeasedCoordinationOptions {
  readonly strategy: "leased";
  readonly maxLeaseUnits: number;
  readonly leaseMs: number;
  readonly maxOutstandingUnits: number;
  readonly guardBandUnits: number;
}

export interface LeasedCoordinationDefinition
  extends LeasedCoordinationOptions {}

export type CoordinationOptions =
  | ExactCoordinationDefinition
  | LeasedCoordinationOptions;

export type CoordinationDefinition =
  | ExactCoordinationDefinition
  | LeasedCoordinationDefinition;

export interface DefineRateLimitOptions {
  readonly id: string;
  readonly requests: number;
  readonly per: ThrottlingDuration;
  readonly burst?: number;
}

/** Immutable shorthand for the common one-request rate limit. */
export interface RateLimitDefinition {
  readonly kind: "rate-limit";
  readonly id: string;
  readonly unit: "requests";
  readonly limit: number;
  readonly periodMs: number;
  readonly burst: number;
  readonly coordination: ExactCoordinationDefinition;
}

export interface RateLimitConstraintOptions {
  readonly id: string;
  readonly unit: string;
  readonly limit: number;
  readonly per: ThrottlingDuration;
  readonly burst?: number;
  readonly scope?: "application";
  readonly coordination?: CoordinationOptions;
}

export interface RateLimitConstraint {
  readonly kind: "rate-limit-constraint";
  readonly id: string;
  readonly unit: string;
  readonly limit: number;
  readonly periodMs: number;
  readonly burst: number;
  readonly scope: "application";
  readonly coordination: CoordinationDefinition;
}

export interface ConcurrencyLimitOptions {
  readonly id: string;
  readonly limit: number;
  readonly scope?: "process";
}

export interface ConcurrencyLimitConstraint {
  readonly kind: "concurrency-limit";
  readonly id: string;
  readonly limit: number;
  readonly scope: "process";
}

export type ResourcePressureUnavailableBehavior = "ignore" | "reject";

export interface LocalResourcePressureSignalOptions {
  readonly degradedAt: number;
  readonly limitedAt: number;
  /** Fraction of an exceeded threshold below which its state can recover. */
  readonly recoveryRatio?: number;
}

export interface LocalResourcePressureSignalDefinition
  extends Required<LocalResourcePressureSignalOptions> {
  readonly id: string;
}

export interface LocalResourcePressureOptions {
  readonly id: string;
  readonly signals: Readonly<Record<string, LocalResourcePressureSignalOptions>>;
  readonly onUnavailable?: ResourcePressureUnavailableBehavior;
  readonly scope?: "process";
}

export interface LocalResourcePressureConstraint {
  readonly kind: "local-resource-pressure";
  readonly id: string;
  readonly signals: readonly LocalResourcePressureSignalDefinition[];
  readonly onUnavailable: ResourcePressureUnavailableBehavior;
  readonly scope: "process";
}

export interface CircuitBreakerHalfOpenOptions {
  readonly maxConcurrentProbes?: number;
  readonly successThreshold?: number;
}

export interface CircuitBreakerHalfOpenDefinition {
  readonly maxConcurrentProbes: number;
  readonly successThreshold: number;
}

export interface CircuitBreakerOptions {
  readonly id: string;
  readonly failureThreshold: number;
  readonly cooldown: ThrottlingDuration;
  readonly halfOpen?: CircuitBreakerHalfOpenOptions;
  readonly scope?: "process";
}

export interface CircuitBreakerConstraint {
  readonly kind: "circuit-breaker";
  readonly id: string;
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpen: CircuitBreakerHalfOpenDefinition;
  readonly scope: "process";
}

export type AdmissionConstraint =
  | CircuitBreakerConstraint
  | ConcurrencyLimitConstraint
  | LocalResourcePressureConstraint
  | RateLimitConstraint;

export interface DefineAdmissionPolicyOptions {
  readonly id: string;
  readonly limits: readonly AdmissionConstraint[];
  readonly costAccounting?: CostAccountingOptions;
}

export interface AdmissionPolicyDefinition {
  readonly kind: "admission-policy";
  readonly id: string;
  readonly limits: readonly AdmissionConstraint[];
  readonly costAccounting: CostAccountingDefinition;
}

export type ThrottlingDefinition =
  | AdmissionPolicyDefinition
  | RateLimitDefinition;

/** Defines a continuous token bucket costing one request per execution. */
export function defineRateLimit(
  options: DefineRateLimitOptions,
): RateLimitDefinition {
  const constraint = createRateLimitConstraint({
    id: options.id,
    unit: "requests",
    limit: options.requests,
    per: options.per,
    ...(options.burst === undefined ? {} : { burst: options.burst }),
  });

  if (constraint.burst < 1) {
    throw new TypeError(
      "burst must allow the default cost of one request.",
    );
  }

  return Object.freeze({
    kind: "rate-limit",
    id: constraint.id,
    unit: "requests",
    limit: constraint.limit,
    periodMs: constraint.periodMs,
    burst: constraint.burst,
    coordination: Object.freeze({ strategy: "exact" as const }),
  });
}

/** Defines one application-wide rate constraint for an advanced policy. */
export function rateLimit(
  options: RateLimitConstraintOptions,
): RateLimitConstraint {
  return createRateLimitConstraint(options);
}

/** Defines one process-local capacity held until permit completion. */
export function concurrencyLimit(
  options: ConcurrencyLimitOptions,
): ConcurrencyLimitConstraint {
  const id = normalizeIdentifier("Concurrency limit", options.id);
  validatePositiveInteger("limit", options.limit);

  return Object.freeze({
    kind: "concurrency-limit",
    id,
    limit: options.limit,
    scope: "process",
  });
}

/** Defines deterministic process-local admission from cached pressure signals. */
export function localResourcePressure(
  options: LocalResourcePressureOptions,
): LocalResourcePressureConstraint {
  const id = normalizeIdentifier("Local resource pressure", options.id);
  const onUnavailable = options.onUnavailable ?? "reject";

  if (onUnavailable !== "ignore" && onUnavailable !== "reject") {
    throw new TypeError("Unsupported unavailable pressure behavior.");
  }

  const signals = Object.entries(options.signals).map(
    ([signalId, signal]) => {
      const normalizedSignalId = normalizeIdentifier(
        "Local resource pressure signal",
        signalId,
      );
      validateNonNegativeFinite("degradedAt", signal.degradedAt);
      validatePositiveFinite("limitedAt", signal.limitedAt);

      if (signal.degradedAt >= signal.limitedAt) {
        throw new TypeError("degradedAt must be smaller than limitedAt.");
      }

      const recoveryRatio = signal.recoveryRatio ?? 0.9;
      if (
        !Number.isFinite(recoveryRatio)
        || recoveryRatio <= 0
        || recoveryRatio >= 1
      ) {
        throw new TypeError("recoveryRatio must be between zero and one.");
      }

      return Object.freeze({
        id: normalizedSignalId,
        degradedAt: signal.degradedAt,
        limitedAt: signal.limitedAt,
        recoveryRatio,
      });
    },
  ).sort((left, right) => left.id.localeCompare(right.id));

  if (signals.length === 0) {
    throw new TypeError(
      "A local resource pressure constraint must contain at least one signal.",
    );
  }

  return Object.freeze({
    kind: "local-resource-pressure",
    id,
    signals: Object.freeze(signals),
    onUnavailable,
    scope: "process",
  });
}

/** Defines process-local dependency health with bounded half-open probes. */
export function circuitBreaker(
  options: CircuitBreakerOptions,
): CircuitBreakerConstraint {
  const id = normalizeIdentifier("Circuit breaker", options.id);
  validatePositiveInteger("failureThreshold", options.failureThreshold);
  const cooldownMs = throttlingDurationToMs(options.cooldown);
  const maxConcurrentProbes = options.halfOpen?.maxConcurrentProbes ?? 1;
  const successThreshold = options.halfOpen?.successThreshold ?? 1;
  validatePositiveInteger("maxConcurrentProbes", maxConcurrentProbes);
  validatePositiveInteger("successThreshold", successThreshold);

  return Object.freeze({
    kind: "circuit-breaker",
    id,
    failureThreshold: options.failureThreshold,
    cooldownMs,
    halfOpen: Object.freeze({ maxConcurrentProbes, successThreshold }),
    scope: "process",
  });
}

/** Defines an immutable AND composition of rate and concurrency constraints. */
export function defineAdmissionPolicy(
  options: DefineAdmissionPolicyOptions,
): AdmissionPolicyDefinition {
  const id = normalizeIdentifier("Admission policy", options.id);
  const costAccounting = createCostAccounting(options.costAccounting);

  if (options.limits.length === 0) {
    throw new TypeError("An admission policy must contain at least one limit.");
  }

  const ids = new Set<string>();

  for (const constraint of options.limits) {
    validateAdmissionConstraint(constraint);

    if (ids.has(constraint.id)) {
      throw new TypeError(
        `Admission policy constraint id "${constraint.id}" is duplicated.`,
      );
    }

    ids.add(constraint.id);
  }

  const rateStrategies = new Set(options.limits.flatMap((constraint) =>
    constraint.kind === "rate-limit-constraint"
      ? [constraint.coordination.strategy]
      : []));

  if (rateStrategies.size > 1) {
    throw new TypeError(
      "Every rate constraint in one admission policy must use the same coordination strategy.",
    );
  }

  return Object.freeze({
    kind: "admission-policy",
    id,
    limits: Object.freeze([...options.limits]),
    costAccounting,
  });
}

/** Revalidates any definition received through the public facade. */
export function validateThrottlingDefinition(
  definition: ThrottlingDefinition,
): void {
  if (definition.kind === "rate-limit") {
    validateRateLimitDefinition(definition);
    return;
  }

  if (definition.kind !== "admission-policy") {
    throw new TypeError("Unsupported throttling definition kind.");
  }

  defineAdmissionPolicy({
    id: definition.id,
    limits: definition.limits,
    costAccounting: definition.costAccounting,
  });
}

function createCostAccounting(
  options: CostAccountingOptions | undefined,
): CostAccountingDefinition {
  const reconciliation = options?.reconciliation ?? "disabled";

  if (
    reconciliation !== "disabled"
    && reconciliation !== "synchronous"
    && reconciliation !== "asynchronous"
  ) {
    throw new TypeError("Unsupported actual-cost reconciliation mode.");
  }

  return Object.freeze({ reconciliation });
}

/** Revalidates the backwards-compatible simple definition. */
export function validateRateLimitDefinition(
  definition: RateLimitDefinition,
): void {
  if (definition.kind !== "rate-limit") {
    throw new TypeError("Unsupported throttling definition kind.");
  }

  normalizeIdentifier("Rate limit", definition.id);

  if (definition.unit !== "requests") {
    throw new TypeError("Simple rate limits only support request units.");
  }

  validatePositiveFinite("limit", definition.limit);
  validatePositiveFinite("periodMs", definition.periodMs);
  validatePositiveFinite("burst", definition.burst);

  if (definition.coordination.strategy !== "exact") {
    throw new TypeError("Simple rate limits require exact coordination.");
  }

  if (definition.burst < 1) {
    throw new TypeError("burst must allow the default request cost.");
  }
}

function createRateLimitConstraint(
  options: RateLimitConstraintOptions,
): RateLimitConstraint {
  const id = normalizeIdentifier("Rate limit", options.id);
  const unit = normalizeIdentifier("Rate limit unit", options.unit);
  validatePositiveFinite("limit", options.limit);
  const periodMs = throttlingDurationToMs(options.per);
  const burst = options.burst ?? options.limit;
  validatePositiveFinite("burst", burst);
  const coordination = createCoordination(options.coordination, burst);

  return Object.freeze({
    kind: "rate-limit-constraint",
    id,
    unit,
    limit: options.limit,
    periodMs,
    burst,
    scope: "application",
    coordination,
  });
}

function createCoordination(
  options: CoordinationOptions | undefined,
  burst: number,
): CoordinationDefinition {
  if (options === undefined || options.strategy === "exact") {
    return Object.freeze({ strategy: "exact" });
  }

  if (options.strategy !== "leased") {
    throw new TypeError("Unsupported throttling coordination strategy.");
  }

  validatePositiveFinite("maxLeaseUnits", options.maxLeaseUnits);
  validatePositiveFinite("leaseMs", options.leaseMs);
  validatePositiveFinite("maxOutstandingUnits", options.maxOutstandingUnits);
  validateNonNegativeFinite("guardBandUnits", options.guardBandUnits);

  if (options.maxLeaseUnits > burst) {
    throw new TypeError("maxLeaseUnits cannot exceed burst.");
  }

  if (options.maxOutstandingUnits < options.maxLeaseUnits) {
    throw new TypeError(
      "maxOutstandingUnits cannot be smaller than maxLeaseUnits.",
    );
  }

  return Object.freeze({ ...options });
}

function validateAdmissionConstraint(constraint: AdmissionConstraint): void {
  if (constraint.kind === "rate-limit-constraint") {
    createRateLimitConstraint({
      id: constraint.id,
      unit: constraint.unit,
      limit: constraint.limit,
      per: { milliseconds: constraint.periodMs },
      burst: constraint.burst,
      scope: constraint.scope,
      coordination: constraint.coordination,
    });
    return;
  }

  if (constraint.kind === "concurrency-limit") {
    concurrencyLimit({
      id: constraint.id,
      limit: constraint.limit,
      scope: constraint.scope,
    });
    return;
  }

  if (constraint.kind === "local-resource-pressure") {
    localResourcePressure({
      id: constraint.id,
      signals: Object.fromEntries(constraint.signals.map((signal) => [
        signal.id,
        {
          degradedAt: signal.degradedAt,
          limitedAt: signal.limitedAt,
          recoveryRatio: signal.recoveryRatio,
        },
      ])),
      onUnavailable: constraint.onUnavailable,
      scope: constraint.scope,
    });
    return;
  }

  if (constraint.kind === "circuit-breaker") {
    circuitBreaker({
      id: constraint.id,
      failureThreshold: constraint.failureThreshold,
      cooldown: { milliseconds: constraint.cooldownMs },
      halfOpen: constraint.halfOpen,
      scope: constraint.scope,
    });
    return;
  }

  throw new TypeError("Unsupported admission constraint kind.");
}

function normalizeIdentifier(label: string, value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new TypeError(`${label} identifiers cannot be empty.`);
  }

  if (normalized.includes(":")) {
    throw new TypeError(`${label} identifiers cannot contain colons.`);
  }

  return normalized;
}

function validatePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number.`);
  }
}

function validateNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number.`);
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}
