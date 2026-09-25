import {
  defineObservation,
  type ObservationData,
} from "../observability/definitions.js";
import {
  type AppWorkload,
} from "./workloads.js";
import {
  type ExecutionContext,
  type ExecutionContextValue,
} from "./execution_context.js";

export type ExecutionTransport =
  | "cli"
  | "direct"
  | "http"
  | "scheduled-task"
  | "worker"
  | "workflow";

export interface ExecutionObservationData extends ObservationData {
  operation: string;
  transport: ExecutionTransport;
  statusCode?: number;
  exitCode?: number;
  context?: Readonly<Record<string, ExecutionContextValue>>;
  error?: ExecutionErrorObservationData;
}

/** JSON-safe diagnostic retained on a failed execution observation. */
export interface ExecutionErrorObservationData extends ObservationData {
  name: string;
  message: string;
  stack?: string;
  causes?: readonly ExecutionErrorObservationData[];
}

/** Destination for data attached to the final execution observation. */
export const executionContextObservationDestination = "observation";

/** Adds a non-empty tagged context projection without changing empty payloads. */
export function getExecutionObservationContext(
  context: ExecutionContext,
): Pick<ExecutionObservationData, "context"> {
  const {
    executionId: _executionId,
    operation: _operation,
    transport: _transport,
    ...values
  } = context.toRecord(executionContextObservationDestination);

  return Object.keys(values).length === 0 ? {} : { context: values };
}

/** Adds stable operation metadata to execution-context log projections. */
export function setExecutionLogContext(
  context: ExecutionContext,
  data: Pick<ExecutionObservationData, "operation" | "transport"> & {
    workload?: AppWorkload;
  },
): void {
  context.setDiagnostic("operation", data.operation, {
    destinations: ["log"],
  });
  context.setDiagnostic("transport", data.transport, {
    destinations: ["log"],
  });
  if (data.workload !== undefined) {
    context.setDiagnostic("workload", data.workload, {
      destinations: ["log"],
    });
  }
}

/** Serializes one error and its acyclic cause chain for execution diagnostics. */
export function getExecutionObservationError(
  error: unknown,
): Pick<ExecutionObservationData, "error"> {
  const root = createErrorDiagnostic(error);
  const causes: ExecutionErrorObservationData[] = [];
  const visited = new Set<unknown>([error]);
  let current = error instanceof Error ? error.cause : undefined;

  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    causes.push(createErrorDiagnostic(current));
    current = current instanceof Error ? current.cause : undefined;
  }

  return {
    error: causes.length === 0 ? root : { ...root, causes },
  };
}

function createErrorDiagnostic(error: unknown): ExecutionErrorObservationData {
  if (!(error instanceof Error)) {
    return {
      name: "UnknownError",
      message: String(error),
    };
  }

  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

/** Marks the transport boundary that created an execution scope. */
export const executionStartedObservation =
  defineObservation<ExecutionObservationData>({
    name: "execution.started",
    category: "execution",
  });

/** Records the final result and duration before an execution is disposed. */
export const executionCompletedObservation =
  defineObservation<ExecutionObservationData>({
    name: "execution.completed",
    category: "execution",
    schemaVersion: 2,
  });
