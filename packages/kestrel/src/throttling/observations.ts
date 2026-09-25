import {
  defineObservation,
  type ObservationData,
} from "../observability/definitions.js";
import type {
  ObservationOutcome,
  Observer,
} from "../observability/observer.js";
import type {
  RateLimitReservationSource,
  ThrottlingCost,
} from "./types.js";
import type { LocalResourcePressureState } from "./resource_pressure/index.js";

export type ThrottlingClassifiedFeedback =
  | "permanent"
  | "success"
  | "throttled"
  | "timeout"
  | "transient";

export type ThrottlingCircuitState = "closed" | "half-open" | "open";

export type ThrottlingAcquisitionMode = "immediate" | "wait";

export type ThrottlingAcquisitionResult =
  | "aborted"
  | "acquired"
  | "closed"
  | "error"
  | "queue-full"
  | "rejected"
  | "timeout";

export interface ThrottlingAcquisitionObservationData extends ObservationData {
  key: string;
  mode: ThrottlingAcquisitionMode;
  result: ThrottlingAcquisitionResult;
  cost: number;
  estimatedCost: ThrottlingCost;
  constraints: number;
  attempts: number;
  remaining?: number;
  source?: RateLimitReservationSource;
  waitTimeoutMs?: number;
  retryAt?: string;
}

export interface ThrottlingCompletionObservationData extends ObservationData {
  key: string;
  result: "failure" | "success";
  cost: number;
  estimatedCost: ThrottlingCost;
  actualCost: ThrottlingCost;
  reconciliation:
    | "disabled"
    | "failed"
    | "not-needed"
    | "reconciled"
    | "scheduled";
  heldDurationMs: number;
  feedback?: ThrottlingClassifiedFeedback;
}

export interface ThrottlingReconciliationObservationData
  extends ObservationData {
  key: string;
  result: "failed" | "reconciled";
  estimatedCost: ThrottlingCost;
  actualCost: ThrottlingCost;
  constraints: number;
}

export interface ThrottlingLeaseObservationData extends ObservationData {
  key: string;
  operation:
    | "consume"
    | "exact-fallback"
    | "expire"
    | "issue"
    | "reject"
    | "return";
  units: number;
  remaining?: number;
}

export interface ThrottlingCircuitObservationData extends ObservationData {
  key: string;
  operation: "feedback" | "probe" | "transition";
  state: ThrottlingCircuitState;
  previousState?: ThrottlingCircuitState;
  feedback?: ThrottlingClassifiedFeedback;
  consecutiveFailures: number;
  activeProbes: number;
  retryAt?: string;
}

export interface ThrottlingPressureObservationData extends ObservationData {
  key: string;
  operation: "rejection" | "transition";
  signal: string;
  state: LocalResourcePressureState;
  previousState?: LocalResourcePressureState;
  value?: number;
}

/** Describes one terminal public admission attempt. */
export const throttlingAcquisitionObservation =
  defineObservation<ThrottlingAcquisitionObservationData>({
    name: "throttling.acquisition",
    category: "throttling",
  });

/** Describes one terminal permit completion. */
export const throttlingCompletionObservation =
  defineObservation<ThrottlingCompletionObservationData>({
    name: "throttling.completion",
    category: "throttling",
  });

/** Describes terminal asynchronous actual-cost reconciliation. */
export const throttlingReconciliationObservation =
  defineObservation<ThrottlingReconciliationObservationData>({
    name: "throttling.reconciliation",
    category: "throttling",
  });

/** Describes local and authoritative leased-capacity transitions. */
export const throttlingLeaseObservation =
  defineObservation<ThrottlingLeaseObservationData>({
    name: "throttling.lease",
    category: "throttling",
  });

/** Describes process-local circuit feedback, probes, and transitions. */
export const throttlingCircuitObservation =
  defineObservation<ThrottlingCircuitObservationData>({
    name: "throttling.circuit",
    category: "throttling",
  });

/** Describes process-local resource pressure state transitions. */
export const throttlingPressureObservation =
  defineObservation<ThrottlingPressureObservationData>({
    name: "throttling.pressure",
    category: "throttling",
  });

interface ThrottlingInstrumentationEventBase {
  durationMs: number;
  outcome: ObservationOutcome;
}

export type ThrottlingInstrumentationEvent =
  | ThrottlingInstrumentationEventBase & {
      type: "acquisition";
      data: ThrottlingAcquisitionObservationData;
    }
  | ThrottlingInstrumentationEventBase & {
      type: "completion";
      data: ThrottlingCompletionObservationData;
    }
  | ThrottlingInstrumentationEventBase & {
      type: "reconciliation";
      data: ThrottlingReconciliationObservationData;
    }
  | ThrottlingInstrumentationEventBase & {
      type: "lease";
      data: ThrottlingLeaseObservationData;
    }
  | ThrottlingInstrumentationEventBase & {
      type: "circuit";
      data: ThrottlingCircuitObservationData;
    }
  | ThrottlingInstrumentationEventBase & {
      type: "pressure";
      data: ThrottlingPressureObservationData;
    };

/** Storage-neutral synchronous sink implemented by observations or metrics. */
export interface ThrottlingInstrumentation {
  record(event: ThrottlingInstrumentationEvent): void;
}

/** Forwards throttling instrumentation into the active scoped observer. */
export function recordThrottlingInstrumentation(
  observer: Observer,
  event: ThrottlingInstrumentationEvent,
): void {
  const options = {
    durationMs: event.durationMs,
    outcome: event.outcome,
  };

  if (event.type === "acquisition") {
    observer.record(throttlingAcquisitionObservation, event.data, options);
  } else if (event.type === "completion") {
    observer.record(throttlingCompletionObservation, event.data, options);
  } else if (event.type === "reconciliation") {
    observer.record(throttlingReconciliationObservation, event.data, options);
  } else if (event.type === "lease") {
    observer.record(throttlingLeaseObservation, event.data, options);
  } else if (event.type === "circuit") {
    observer.record(throttlingCircuitObservation, event.data, options);
  } else {
    observer.record(throttlingPressureObservation, event.data, options);
  }
}
