import {
  defineObservation,
  type ObservationData,
} from "../observability/definitions.js";
import type {
  ObservationOutcome,
  Observer,
} from "../observability/observer.js";
import type {
  WorkflowExecutionStatus,
  WorkflowTaskKind,
} from "./adapter.js";

export interface WorkflowLifecycleObservationData extends ObservationData {
  executionId: string;
  workflowName: string;
  workflowVersion: number;
  operation: "blocked" | "completed" | "failed" | "retry" | "start" | "wait";
  status: WorkflowExecutionStatus;
  historyGeneration?: number;
  sourceExecutionId?: string;
}

export interface WorkflowTaskObservationData extends ObservationData {
  executionId: string;
  workflowName: string;
  workflowVersion: number;
  historyGeneration: number;
  taskKind: WorkflowTaskKind;
  result: "committed" | "failed" | "retried" | "stale";
  attempt: number;
  commandSequence?: number;
  target?: string;
  queueAgeMs: number;
  timerLagMs?: number;
  retryDelayMs?: number;
}

/** Counts durable execution lifecycle transitions without recording payloads. */
export const workflowLifecycleObservation =
  defineObservation<WorkflowLifecycleObservationData>({
    name: "workflow.lifecycle",
    category: "workflow",
  });

/** Measures workflow activation, activity and timer scheduling behavior. */
export const workflowTaskObservation =
  defineObservation<WorkflowTaskObservationData>({
    name: "workflow.task",
    category: "workflow",
  });

export type WorkflowInstrumentationEvent =
  | {
      type: "lifecycle";
      data: WorkflowLifecycleObservationData;
      outcome: ObservationOutcome;
      durationMs?: number;
    }
  | {
      type: "task";
      data: WorkflowTaskObservationData;
      outcome: ObservationOutcome;
      durationMs: number;
    };

/** Storage-neutral sink that can feed observations or a metrics backend. */
export interface WorkflowInstrumentation {
  record(event: WorkflowInstrumentationEvent): void;
}

export function recordWorkflowInstrumentation(
  observer: Observer,
  event: WorkflowInstrumentationEvent,
): void {
  observer.record(
    event.type === "lifecycle"
      ? workflowLifecycleObservation
      : workflowTaskObservation,
    event.data,
    {
      outcome: event.outcome,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    },
  );
}
