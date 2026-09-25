import type {
  ObservationData,
} from "../../../observability/definitions.js";
import type {
  ExecutionTransport,
} from "../../../app/observations.js";
import type {
  ObservationOutcome,
} from "../../../observability/observer.js";
import type { StudioLog } from "../logs/contract.js";

export const DEV_OBSERVATIONS_EXTENSION_ID = "development-observations";
export const DEV_OBSERVATIONS_PAGE_KIND = "development-observations";
export const DEV_OBSERVATION_LIST_PAGE_KIND = "development-observation-list";
export const DEV_OBSERVATION_EXECUTION_PAGE_KIND =
  "development-observation-execution";
export const DEV_OBSERVATION_CORRELATION_PAGE_KIND =
  "development-observation-correlation";
export const DEV_OBSERVATIONS_DATA_PATH =
  "/api/extensions/development-observations" as const;

/** Returns the canonical Studio-relative path for one execution. */
export function getStudioObservationExecutionPath(
  executionId: string,
): `/executions/${string}` {
  return `/executions/${encodeURIComponent(executionId)}`;
}

/** Returns the canonical Studio path for a diagnostic correlation timeline. */
export function getStudioObservationCorrelationPath(
  contextKey: string,
  contextValue: string,
): `/correlations/${string}/${string}` {
  return `/correlations/${encodeURIComponent(contextKey)}/${encodeURIComponent(contextValue)}`;
}

/** Execution summary serialized for the Studio list. */
export interface StudioObservationExecution {
  executionId: string;
  operation: string;
  transport: ExecutionTransport;
  startedAt: string;
  completedAt: string | null;
  outcome: ObservationOutcome | null;
  durationMs: number | null;
}

export interface StudioObservationExecutionPage {
  items: readonly StudioObservationExecution[];
  nextBefore: number | null;
}

/** Generic observation representation used by the initial timeline. */
export interface StudioObservation {
  sequence: number;
  id: string;
  executionId: string;
  occurredAt: string;
  name: string;
  category: string;
  schemaVersion: number;
  outcome: ObservationOutcome | null;
  durationMs: number | null;
  data: ObservationData;
}

export interface StudioObservationTimeline {
  executionId: string;
  items: readonly StudioObservation[];
}

export interface StudioObservationPage {
  items: readonly StudioObservation[];
  nextBefore: number | null;
}

/** Chronological structured logs correlated with one execution. */
export interface StudioExecutionLogs {
  executionId: string;
  items: readonly StudioLog[];
}
