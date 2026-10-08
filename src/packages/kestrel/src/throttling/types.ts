import type {
  LeasedCoordinationDefinition,
  ThrottlingDefinition,
} from "./definitions.js";
import type {
  ThrottlingInstrumentation,
} from "./observations.js";

export type Awaitable<Value> = Value | Promise<Value>;

export type ThrottlingCost = Readonly<Record<string, number>>;

export interface RateLimitReservationRequest {
  readonly key: string;
  readonly limit: number;
  readonly periodMs: number;
  readonly burst: number;
  readonly cost: number;
  readonly coordination?:
    | { readonly strategy: "exact" }
    | LeasedCoordinationDefinition;
}

export type RateLimitReservationResult =
  | {
      readonly admitted: true;
      readonly remaining: number;
      readonly source?: RateLimitReservationSource;
    }
  | {
      readonly admitted: false;
      readonly remaining: number;
      readonly retryAt: Date;
      readonly source?: RateLimitReservationSource;
    };

export type RateLimitReservationSource =
  | "authoritative"
  | "denial-cache"
  | "emergency-local"
  | "leased"
  | "local";

export type RateLimitBatchReservationResult =
  | {
      readonly admitted: true;
      readonly remaining: Readonly<Record<string, number>>;
      readonly source?: RateLimitReservationSource;
    }
  | {
      readonly admitted: false;
      readonly remaining: Readonly<Record<string, number>>;
      readonly retryAt: Date;
      readonly source?: RateLimitReservationSource;
    };

export interface RateLimitReconciliationRequest
  extends RateLimitReservationRequest {
  readonly actualCost: number;
  readonly estimatedCost: number;
  readonly reservationSource?: RateLimitReservationSource;
}

export interface RateLimitInspectionResult {
  readonly available: boolean;
  readonly remaining: number;
  readonly retryAt?: Date;
  readonly source?: RateLimitReservationSource;
}

/** Storage-neutral atomic token reservation contract. */
export interface RateLimitAdapter {
  reserve(
    request: RateLimitReservationRequest,
  ): Promise<RateLimitReservationResult>;
  reserveMany?(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<RateLimitBatchReservationResult>;
  reconcile?(
    requests: readonly RateLimitReconciliationRequest[],
  ): Promise<Readonly<Record<string, number>>>;
  inspectMany?(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<readonly RateLimitInspectionResult[]>;
  close?(): Promise<void>;
}

export interface RateLimitLeaseRequest extends RateLimitReservationRequest {
  readonly coordination: LeasedCoordinationDefinition;
}

export type RateLimitLeaseAllocation =
  | {
      readonly mode: "exact";
      readonly remaining: number;
    }
  | {
      readonly mode: "lease";
      readonly leaseId: string;
      readonly units: number;
      readonly expiresAt: Date;
      readonly remaining: number;
    };

export type RateLimitLeaseBatchResult =
  | {
      readonly admitted: true;
      readonly allocations: Readonly<Record<string, RateLimitLeaseAllocation>>;
      readonly source?: RateLimitReservationSource;
    }
  | {
      readonly admitted: false;
      readonly remaining: Readonly<Record<string, number>>;
      readonly retryAt: Date;
      readonly source?: RateLimitReservationSource;
    };

export interface RateLimitLeaseReturn {
  readonly key: string;
  readonly leaseId: string;
  readonly remaining: number;
}

/** Authoritative capability used by the process-local leased coordinator. */
export interface LeasableRateLimitAdapter extends RateLimitAdapter {
  allocateLeases(
    ownerId: string,
    requests: readonly RateLimitLeaseRequest[],
    completedLeases?: readonly RateLimitLeaseReturn[],
  ): Promise<RateLimitLeaseBatchResult>;
  returnLeases(leases: readonly RateLimitLeaseReturn[]): Promise<number>;
}

export interface RateLimitPruneOptions {
  readonly limit?: number;
}

/** Optional maintenance capability implemented by persistent adapters. */
export interface PrunableRateLimitAdapter extends RateLimitAdapter {
  prune(options: RateLimitPruneOptions): Promise<number>;
}

export type ThrottlingBackendFailurePolicy =
  | { readonly strategy: "reject" }
  | {
      readonly strategy: "emergency-local";
      readonly capacity: number;
      readonly periodMs: number;
    };

export interface ThrottlingAcquireOptions {
  readonly estimatedCost?: ThrottlingCost;
  /** Partitions persistent rate state without creating another definition. */
  readonly rateKey?: string;
  readonly maxWaitMs?: number;
  readonly signal?: AbortSignal;
}

export type ThrottlingRunOptions = ThrottlingAcquireOptions;

export type ThrottlingPermitOutcome = "failure" | "success";

export type ThrottlingFeedback =
  | { readonly kind: "permanent" }
  | { readonly kind: "throttled"; readonly retryAt?: Date }
  | { readonly kind: "timeout" }
  | { readonly kind: "transient" };

export interface ThrottlingPermitCompletion {
  readonly actualCost?: ThrottlingCost;
  readonly feedback?: ThrottlingFeedback;
  readonly outcome: ThrottlingPermitOutcome;
}

export interface ThrottlingPermit {
  readonly definitionId: string;
  complete(completion: ThrottlingPermitCompletion): Promise<void>;
}

export interface ThrottlingRunContext {
  reportActualCost(cost: ThrottlingCost): void;
  reportFeedback(feedback: ThrottlingFeedback): void;
}

export interface AdmissionReason {
  readonly constraintId: string;
  readonly kind: "circuit" | "concurrency" | "pressure" | "rate";
  readonly remaining?: number;
  readonly retryAt?: Date;
  readonly signalId?: string;
  readonly value?: number;
}

export interface AdmissionAvailability {
  readonly state: "available" | "degraded" | "limited" | "unknown";
  readonly retryAt?: Date;
  readonly reasons: readonly AdmissionReason[];
}

export interface ThrottlingInspectOptions {
  readonly estimatedCost?: ThrottlingCost;
  /** Uses the same persistent rate partition as acquisition. */
  readonly rateKey?: string;
}

/** Public facade shared by simple and composed admission policies. */
export interface Throttling {
  acquire(
    definition: ThrottlingDefinition,
    options?: ThrottlingAcquireOptions,
  ): Promise<ThrottlingPermit>;

  run<Value>(
    definition: ThrottlingDefinition,
    handler: (context: ThrottlingRunContext) => Awaitable<Value>,
  ): Promise<Value>;

  run<Value>(
    definition: ThrottlingDefinition,
    options: ThrottlingRunOptions,
    handler: (context: ThrottlingRunContext) => Awaitable<Value>,
  ): Promise<Value>;

  inspect(
    definition: ThrottlingDefinition,
    options?: ThrottlingInspectOptions,
  ): Promise<AdmissionAvailability>;

  close(): Promise<void>;
}

export interface ThrottlingManagerOptions {
  /** Set false when a provider owns backend disposal after the manager drains. */
  readonly closeAdapter?: boolean;
  readonly namespace: string;
  readonly maxPendingAcquisitions?: number;
  readonly instrumentation?: ThrottlingInstrumentation;
  readonly formatObservationKey?: (key: string) => string;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly sleep?: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly resourcePressureMonitor?: import(
    "./resource_pressure/index.js"
  ).LocalResourcePressureMonitor;
}
