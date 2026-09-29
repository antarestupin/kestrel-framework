/** Stable identifiers shared by the scheduled-tasks Studio extension and client. */
export const SCHEDULED_TASKS_STUDIO_EXTENSION_ID = "scheduled-tasks";
export const SCHEDULED_TASKS_STUDIO_PAGE_KIND = "scheduled-tasks.catalog";

export type StudioScheduledTaskSource =
  | { kind: "application" }
  | { kind: "provider"; provider: string };

export type StudioScheduledTaskSchedule =
  | { kind: "every"; intervalMs: number; start: string }
  | { kind: "loop"; delayMs: number; start: string }
  | { kind: "cron"; expression: string; timeZone?: string };

export interface StudioScheduledTaskState {
  paused: boolean;
  nextScheduledAt?: string;
  manualRunRequestedAt?: string;
  activeRuns: number;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastOutcome?: "failure" | "success";
  lastError?: { name: string; message: string };
}

/** Serializable task definition and its latest operational state. */
export interface StudioScheduledTask {
  kind: "task";
  id: string;
  description?: string;
  groups: readonly string[];
  overlap: "parallel" | "skip" | "wait";
  executionLog: boolean;
  observe: boolean;
  source: StudioScheduledTaskSource;
  stateKind: "memory" | "persistent";
  schedule: StudioScheduledTaskSchedule;
  controllable: boolean;
  unavailableReason?: string;
  state?: StudioScheduledTaskState;
}

export interface StudioScheduledTaskGroup {
  kind: "group";
  id: string;
  name: string;
  children: readonly StudioScheduledTaskCatalogNode[];
}

export type StudioScheduledTaskCatalogNode =
  | StudioScheduledTaskGroup
  | StudioScheduledTask;

export interface StudioScheduledTaskCatalog {
  nodes: readonly StudioScheduledTaskCatalogNode[];
}

export type StudioScheduledTaskControlAction = "pause" | "resume" | "run";
