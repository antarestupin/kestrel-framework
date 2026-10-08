import type { ExecutionTransport } from "../app/observations.js";
import type { ObservationOutcome } from "./observer.js";
import type { ObservationData } from "./definitions.js";

/** Backend-neutral query record; PostgreSQL rows structurally implement this contract. */
export interface ObservationRecord {
  sequence: number;
  id: string;
  executionId: string;
  occurredAt: Date;
  name: string;
  category: string;
  schemaVersion: number;
  outcome: ObservationOutcome | null;
  durationMs: number | null;
  data: ObservationData;
  createdAt: Date;
}

export interface ObservationExecutionSummary {
  executionId: string;
  operation: string;
  transport: ExecutionTransport;
  startedAt: Date;
  completedAt: Date | null;
  outcome: ObservationOutcome | null;
  durationMs: number | null;
}

export interface ObservationExecutionPageOptions {
  before?: number;
  limit?: number;
}

export interface ObservationExecutionPage {
  items: readonly ObservationExecutionSummary[];
  nextBefore: number | null;
}

export interface ObservationPageOptions {
  before?: number;
  category?: string;
  executionId?: string;
  limit?: number;
  name?: string;
  outcome?: ObservationOutcome;
}

export interface ObservationPage {
  items: readonly ObservationRecord[];
  nextBefore: number | null;
}

export interface DevObservationSource {
  clear(): Promise<void>;
  getObservation(id: string): Promise<ObservationRecord | undefined>;
  listEvents(executionId: string): Promise<readonly ObservationRecord[]>;
  listEventsByContext(
    contextKey: string,
    contextValue: string,
  ): Promise<readonly ObservationRecord[]>;
  listObservations(options?: ObservationPageOptions): Promise<ObservationPage>;
  listExecutions(options?: ObservationExecutionPageOptions): Promise<ObservationExecutionPage>;
}
