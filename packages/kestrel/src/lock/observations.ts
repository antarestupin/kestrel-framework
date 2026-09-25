import {
  defineObservation,
  type ObservationData,
} from "../observability/definitions.js";
import type {
  ObservationOutcome,
  Observer,
} from "../observability/observer.js";

export type LockAcquisitionMode = "immediate" | "wait";

export type LockAcquisitionResult =
  | "aborted"
  | "acquired"
  | "contended"
  | "error"
  | "timeout";

export interface LockAcquisitionObservationData extends ObservationData {
  key: string;
  mode: LockAcquisitionMode;
  result: LockAcquisitionResult;
  attempts: number;
  ttlMs: number;
  waitTimeoutMs?: number;
  fencingToken?: string;
}

export type LockBatchAcquisitionResult = Exclude<
  LockAcquisitionResult,
  "contended"
>;

export interface LockBatchAcquisitionObservationData extends ObservationData {
  keys: readonly string[];
  result: LockBatchAcquisitionResult;
  attempts: number;
  ttlMs: number;
  waitTimeoutMs: number;
  fencingTokens?: readonly string[];
}

export type LockExtensionResult =
  | "already-released"
  | "error"
  | "extended"
  | "lost";

export interface LockExtensionObservationData extends ObservationData {
  key: string;
  result: LockExtensionResult;
  ttlMs: number;
  fencingToken: string;
}

export type LockReleaseResult =
  | "already-released"
  | "error"
  | "not-owned"
  | "released";

export interface LockReleaseObservationData extends ObservationData {
  key: string;
  result: LockReleaseResult;
  fencingToken: string;
  heldDurationMs: number;
}

/** Records the terminal result and total duration of one acquisition call. */
export const lockAcquisitionObservation =
  defineObservation<LockAcquisitionObservationData>({
    name: "lock.acquisition",
    category: "lock",
  });

/** Records the terminal result of one all-or-nothing batch acquisition. */
export const lockBatchAcquisitionObservation =
  defineObservation<LockBatchAcquisitionObservationData>({
    name: "lock.batch-acquisition",
    category: "lock",
  });

/** Records one explicit attempt to extend an acquired lease. */
export const lockExtensionObservation =
  defineObservation<LockExtensionObservationData>({
    name: "lock.extension",
    category: "lock",
  });

/** Records one release call and the lease's total held duration. */
export const lockReleaseObservation =
  defineObservation<LockReleaseObservationData>({
    name: "lock.release",
    category: "lock",
  });

interface LockInstrumentationEventBase {
  durationMs: number;
  outcome: ObservationOutcome;
}

export type LockInstrumentationEvent =
  | LockInstrumentationEventBase & {
    type: "batch-acquisition";
    data: LockBatchAcquisitionObservationData;
  }
  | LockInstrumentationEventBase & {
    type: "acquisition";
    data: LockAcquisitionObservationData;
  }
  | LockInstrumentationEventBase & {
    type: "extension";
    data: LockExtensionObservationData;
  }
  | LockInstrumentationEventBase & {
    type: "release";
    data: LockReleaseObservationData;
  };

/** Storage-neutral synchronous sink implemented by logs, metrics or observers. */
export interface LockInstrumentation {
  record(event: LockInstrumentationEvent): void;
}

/** Forwards a lock instrumentation event to a scoped observer. */
export function recordLockInstrumentation(
  observer: Observer,
  event: LockInstrumentationEvent,
): void {
  const options = {
    durationMs: event.durationMs,
    outcome: event.outcome,
  };

  switch (event.type) {
    case "acquisition":
      observer.record(lockAcquisitionObservation, event.data, options);
      break;
    case "batch-acquisition":
      observer.record(lockBatchAcquisitionObservation, event.data, options);
      break;
    case "extension":
      observer.record(lockExtensionObservation, event.data, options);
      break;
    case "release":
      observer.record(lockReleaseObservation, event.data, options);
      break;
  }
}
