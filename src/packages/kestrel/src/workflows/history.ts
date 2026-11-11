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
  /** Used by the adapter to complete a capture with its durable failure. */
  captureError?: WorkflowExecutionError;
}

export interface WorkflowCommandScheduledEvent
  extends WorkflowHistoryEventBase, Omit<WorkflowCommand, "captureError"> {
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

/** Identifies one logical command across retries and history rotations. */
export function workflowCommandIdentity({ executionId, sequence, historyGeneration = 1 }: {
  executionId: string;
  sequence: number;
  historyGeneration?: number;
}): string {
  const key = `${executionId}:${sequence}`;
  // The suffix cannot collide with a generation-one identity ending in a sequence number.
  return historyGeneration === 1 ? key : `${key}:generation-${historyGeneration}`;
}
