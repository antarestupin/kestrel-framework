import {
  defineObservation,
  type ObservationData,
} from "../observability/definitions.js";
import type {
  ObservationOutcome,
  Observer,
} from "../observability/observer.js";

export type OutboundHttpResult =
  | "aborted"
  | "error"
  | "network-error"
  | "response"
  | "timeout";

export interface OutboundHttpRequestObservationData extends ObservationData {
  client: string;
  operation: string;
  method: string;
  route: string;
  result: OutboundHttpResult;
  attempts: number;
  status?: number;
}

export interface OutboundHttpAttemptObservationData extends ObservationData {
  client: string;
  operation: string;
  method: string;
  route: string;
  result: OutboundHttpResult;
  attempt: number;
  status?: number;
}

/** Describes one logical outbound request, including all retries. */
export const outboundHttpRequestObservation =
  defineObservation<OutboundHttpRequestObservationData>({
    name: "http.client.request",
    category: "http.client",
  });

/** Describes one concrete network attempt. */
export const outboundHttpAttemptObservation =
  defineObservation<OutboundHttpAttemptObservationData>({
    name: "http.client.attempt",
    category: "http.client",
  });

interface OutboundHttpInstrumentationEventBase {
  readonly durationMs: number;
  readonly outcome: ObservationOutcome;
}

export type OutboundHttpInstrumentationEvent =
  | OutboundHttpInstrumentationEventBase & {
      readonly type: "attempt";
      readonly data: OutboundHttpAttemptObservationData;
    }
  | OutboundHttpInstrumentationEventBase & {
      readonly type: "request";
      readonly data: OutboundHttpRequestObservationData;
    };

/** Synchronous storage-neutral sink implemented by observers or metrics. */
export interface OutboundHttpInstrumentation {
  record(event: OutboundHttpInstrumentationEvent): void;
}

/** Forwards outbound instrumentation to the current scoped observer. */
export function recordOutboundHttpInstrumentation(
  observer: Observer,
  event: OutboundHttpInstrumentationEvent,
): void {
  const options = {
    durationMs: event.durationMs,
    outcome: event.outcome,
  };

  if (event.type === "attempt") {
    observer.record(outboundHttpAttemptObservation, event.data, options);
  } else {
    observer.record(outboundHttpRequestObservation, event.data, options);
  }
}
