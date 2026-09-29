import type { WorkflowExecutionError } from "./errors.js";
import type { WorkflowPayload } from "./serialization.js";

interface WorkflowHistoryEventBase {
  /** Monotonic position across every event in one execution. */
  eventIndex: number;
  occurredAt: Date;
}

/** Durable command identity emitted by deterministic workflow code. */
export interface WorkflowCommand {
  sequence: number;
  kind: string;
  target: string;
  payload: WorkflowPayload;
}

export interface WorkflowCommandScheduledEvent
  extends WorkflowHistoryEventBase, WorkflowCommand {
  type: "command-scheduled";
}

export interface WorkflowCommandCompletedEvent
  extends WorkflowHistoryEventBase {
  type: "command-completed";
  sequence: number;
  completionOrder: number;
  result?: WorkflowPayload;
  error?: WorkflowExecutionError;
  sourceId?: string;
}

export interface WorkflowSignalReceivedEvent extends WorkflowHistoryEventBase {
  type: "signal-received";
  signalId: string;
  name: string;
  payload: WorkflowPayload;
}

export interface WorkflowCancellationRequestedEvent
  extends WorkflowHistoryEventBase {
  type: "cancellation-requested";
}

export type WorkflowHistoryEvent =
  | WorkflowCommandCompletedEvent
  | WorkflowCommandScheduledEvent
  | WorkflowSignalReceivedEvent
  | WorkflowCancellationRequestedEvent;

/** Immutable state used by one deterministic replay activation. */
export interface WorkflowActivationSnapshot {
  executionId: string;
  workflowName: string;
  workflowVersion: number;
  historyGeneration: number;
  input: WorkflowPayload;
  revision: number;
  history: readonly WorkflowHistoryEvent[];
  cancellationRequested: boolean;
}
