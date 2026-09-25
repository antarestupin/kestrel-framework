import {
  defineObservation,
  type ObservationData,
  type ObservationValue,
} from "../observability/definitions.js";
import type {
  ObservationOutcome,
  Observer,
} from "../observability/observer.js";

export interface DatabaseQueryOrigin extends Readonly<Record<string, ObservationValue>> {
  function?: string;
  file: string;
  line: number;
  column: number;
  stack?: readonly string[];
}

export interface DatabaseQueryObservationData extends ObservationData {
  sql: string;
  parameters?: readonly ObservationValue[];
  statementName?: string;
  command?: string;
  rowCount?: number;
  errorCode?: string;
  origin?: DatabaseQueryOrigin;
}

/** Describes one PostgreSQL query after it succeeds or fails. */
export const databaseQueryObservation =
  defineObservation<DatabaseQueryObservationData>({
    name: "database.query",
    category: "database",
  });

export interface DatabaseQueryInstrumentationEvent {
  data: DatabaseQueryObservationData;
  durationMs: number;
  outcome: ObservationOutcome;
}

/** Storage-neutral synchronous sink implemented by the scoped observer. */
export interface DatabaseQueryInstrumentation {
  record(event: DatabaseQueryInstrumentationEvent): void;
}

/** Forwards a completed database query to the current execution observer. */
export function recordDatabaseQueryInstrumentation(
  observer: Observer,
  event: DatabaseQueryInstrumentationEvent,
): void {
  observer.record(databaseQueryObservation, event.data, {
    durationMs: event.durationMs,
    outcome: event.outcome,
  });
}
