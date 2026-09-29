import {
  defineObservation,
  type ObservationData,
} from "../observability/definitions.js";
import type {
  ObservationOutcome,
  Observer,
} from "../observability/observer.js";

export type CacheAccessOperation = "get" | "remember";

export type CacheAccessResult =
  | "error"
  | "hit"
  | "local-coalesced"
  | "miss";

export type CacheAccessPhase = "after-lock" | "initial";

export interface CacheAccessObservationData extends ObservationData {
  key: string;
  operation: CacheAccessOperation;
  result: CacheAccessResult;
  phase?: CacheAccessPhase;
}

export type CacheLoadResult = "error" | "loaded";

export type CacheLoadCoordination = "lock" | "none";

export interface CacheLoadObservationData extends ObservationData {
  key: string;
  result: CacheLoadResult;
  coordination: CacheLoadCoordination;
}

export type CacheWriteOperation = "remember" | "set";

export type CacheWriteResult = "error" | "oversized" | "stored";

export interface CacheWriteObservationData extends ObservationData {
  key: string;
  operation: CacheWriteOperation;
  result: CacheWriteResult;
  ttlSeconds?: number;
  sizeBytes?: number;
  tagCount?: number;
}

export type CacheInvalidationOperation =
  | "delete"
  | "invalidate-all-tags";

export type CacheInvalidationResult =
  | "completed"
  | "deleted"
  | "error"
  | "not-found";

export interface CacheInvalidationObservationData extends ObservationData {
  operation: CacheInvalidationOperation;
  result: CacheInvalidationResult;
  key?: string;
  tagCount?: number;
  affectedEntries?: number;
}

/** Describes one cache lookup or local in-flight reuse decision. */
export const cacheAccessObservation =
  defineObservation<CacheAccessObservationData>({
    name: "cache.access",
    category: "cache",
  });

/** Measures a source loader invocation without capturing its returned value. */
export const cacheLoadObservation =
  defineObservation<CacheLoadObservationData>({
    name: "cache.load",
    category: "cache",
  });

/** Describes one explicit or read-through cache write attempt. */
export const cacheWriteObservation =
  defineObservation<CacheWriteObservationData>({
    name: "cache.write",
    category: "cache",
  });

/** Describes an explicit key or tag invalidation operation. */
export const cacheInvalidationObservation =
  defineObservation<CacheInvalidationObservationData>({
    name: "cache.invalidation",
    category: "cache",
  });

interface CacheInstrumentationEventBase {
  durationMs: number;
  outcome: ObservationOutcome;
}

export type CacheInstrumentationEvent =
  | CacheInstrumentationEventBase & {
    type: "access";
    data: CacheAccessObservationData;
  }
  | CacheInstrumentationEventBase & {
    type: "invalidation";
    data: CacheInvalidationObservationData;
  }
  | CacheInstrumentationEventBase & {
    type: "load";
    data: CacheLoadObservationData;
  }
  | CacheInstrumentationEventBase & {
    type: "write";
    data: CacheWriteObservationData;
  };

/** Storage-neutral synchronous sink implemented by logs, metrics or observers. */
export interface CacheInstrumentation {
  record(event: CacheInstrumentationEvent): void;
}

/** Forwards a cache instrumentation event to a scoped observer. */
export function recordCacheInstrumentation(
  observer: Observer,
  event: CacheInstrumentationEvent,
): void {
  const options = {
    durationMs: event.durationMs,
    outcome: event.outcome,
  };

  switch (event.type) {
    case "access":
      observer.record(cacheAccessObservation, event.data, options);
      break;
    case "invalidation":
      observer.record(cacheInvalidationObservation, event.data, options);
      break;
    case "load":
      observer.record(cacheLoadObservation, event.data, options);
      break;
    case "write":
      observer.record(cacheWriteObservation, event.data, options);
      break;
  }
}
