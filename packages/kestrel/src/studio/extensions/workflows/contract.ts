import type {
  WorkflowExecutionStatus,
  WorkflowPayload,
} from "../../../workflows/index.js";

export const WORKFLOWS_STUDIO_EXTENSION_ID = "workflows";
export const WORKFLOWS_STUDIO_CATALOG_PAGE_KIND = "workflows.catalog";
export const WORKFLOWS_STUDIO_EXECUTION_PAGE_KIND = "workflows.execution";
export const WORKFLOWS_STUDIO_DATA_PATH = "/api/extensions/workflows" as const;

export interface StudioWorkflowDefinition {
  name: string;
  description?: string;
  path: readonly string[];
  source: { kind: "application" } | { kind: "provider"; provider: string };
  currentVersion: number;
  supportedFrom: number;
  signals: readonly string[];
  executions: readonly {
    workflowVersion: number;
    status: WorkflowExecutionStatus;
    count: number;
  }[];
}

export interface StudioWorkflowExecution {
  executionId: string;
  workflowName: string;
  workflowVersion: number;
  historyGeneration: number;
  status: WorkflowExecutionStatus;
  input: WorkflowPayload;
  output?: WorkflowPayload;
  error?: { name: string; message: string; stack?: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  pausedAt?: string;
  cancellationRequested: boolean;
  parentExecutionId?: string;
  parentCommandSequence?: number;
  rootExecutionId: string;
  retryOfExecutionId?: string;
  concurrencyKey?: string;
}

export interface StudioWorkflowCatalog {
  definitions: readonly StudioWorkflowDefinition[];
  unsupportedActiveVersions: readonly {
    workflowName: string;
    workflowVersion: number;
    count: number;
    reason: "definition-missing" | "version-unsupported";
  }[];
}

export interface StudioWorkflowExecutionPage {
  items: readonly StudioWorkflowExecution[];
  nextCursor?: string;
}

export interface StudioWorkflowHistoryEvent {
  eventIndex: number;
  type: "cancellation-requested" | "command-completed" | "command-scheduled" | "signal-received";
  occurredAt: string;
  sequence?: number;
  completionOrder?: number;
  kind?: string;
  target?: string;
  signalId?: string;
  name?: string;
  payload?: WorkflowPayload;
  result?: WorkflowPayload;
  error?: { name: string; message: string; stack?: string };
  sourceId?: string;
}

export interface StudioWorkflowGraphNode {
  id: string;
  kind: "command" | "execution" | "signal";
  label: string;
  status: "completed" | "failed" | "pending" | WorkflowExecutionStatus;
  occurredAt?: string;
  completedAt?: string;
  executionId?: string;
  sequence?: number;
}

export interface StudioWorkflowExecutionDetails {
  execution: StudioWorkflowExecution;
  declaredSignals: readonly string[];
  history: readonly StudioWorkflowHistoryEvent[];
  archives: readonly {
    historyGeneration: number;
    workflowVersion: number;
    eventCount: number;
    continuedAt: string;
  }[];
  children: readonly StudioWorkflowExecution[];
  retries: readonly StudioWorkflowExecution[];
  waits: readonly {
    sequence: number;
    kind: string;
    target: string;
    scheduledAt: string;
    deadline?: string;
  }[];
  graph: {
    nodes: readonly StudioWorkflowGraphNode[];
    edges: readonly { from: string; to: string; kind: "child" | "command" | "signal" }[];
  };
  observationPath: string;
}

export type StudioWorkflowControlAction =
  | "cancel"
  | "pause"
  | "recover"
  | "resume"
  | "retry"
  | "terminate";
