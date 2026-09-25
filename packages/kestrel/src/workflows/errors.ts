export interface WorkflowExecutionError {
  name: string;
  message: string;
  stack?: string;
  details?: {
    executionId?: string;
    sequence?: number;
    signalName?: string;
    timeoutKind?: "schedule-to-close" | "start-to-close";
  };
}

/** Converts an arbitrary failure into bounded durable execution metadata. */
export function serializeWorkflowError(
  error: unknown,
  maxStackLength = 8_000,
): WorkflowExecutionError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...serializeKnownWorkflowErrorDetails(error),
      ...(error.stack === undefined
        ? {}
        : { stack: error.stack.slice(0, maxStackLength) }),
    };
  }

  return { name: "Error", message: String(error) };
}

function serializeKnownWorkflowErrorDetails(
  error: Error,
): Pick<WorkflowExecutionError, "details"> {
  if (error instanceof WorkflowActivityTimeoutError) {
    return {
      details: {
        executionId: error.executionId,
        sequence: error.sequence,
        timeoutKind: error.timeoutKind,
      },
    };
  }

  if (error instanceof WorkflowSignalTimeoutError) {
    return {
      details: {
        executionId: error.executionId,
        signalName: error.signalName,
      },
    };
  }

  if (error instanceof WorkflowCancellationError) {
    return { details: { executionId: error.executionId } };
  }

  return {};
}

export class WorkflowExecutionNotFoundError extends Error {
  public constructor(public readonly executionId: string) {
    super(`Unknown workflow execution "${executionId}".`);
    this.name = "WorkflowExecutionNotFoundError";
  }
}

export class WorkflowExecutionConflictError extends Error {
  public constructor(
    public readonly executionId: string,
    message = `Workflow execution "${executionId}" already exists with an incompatible definition or input.`,
  ) {
    super(message);
    this.name = "WorkflowExecutionConflictError";
  }
}

export class WorkflowConcurrencyConflictError extends Error {
  public constructor(
    public readonly workflowName: string,
    public readonly concurrencyKey: string,
  ) {
    super(
      `Workflow "${workflowName}" rejected a concurrent execution for key "${concurrencyKey}".`,
    );
    this.name = "WorkflowConcurrencyConflictError";
  }
}

export class WorkflowExecutionClosedError extends Error {
  public constructor(public readonly executionId: string) {
    super(`Workflow execution "${executionId}" no longer accepts signals.`);
    this.name = "WorkflowExecutionClosedError";
  }
}

export class WorkflowSignalConflictError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly idempotencyKey: string,
  ) {
    super(
      `Workflow signal idempotency key "${idempotencyKey}" was reused with different content for execution "${executionId}".`,
    );
    this.name = "WorkflowSignalConflictError";
  }
}

export class WorkflowExecutionFailedError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly executionError: WorkflowExecutionError,
  ) {
    super(
      `Workflow execution "${executionId}" failed: ${executionError.message}`,
    );
    this.name = "WorkflowExecutionFailedError";
  }
}

export class WorkflowExecutionCancelledError extends Error {
  public constructor(public readonly executionId: string) {
    super(`Workflow execution "${executionId}" was cancelled.`);
    this.name = "WorkflowExecutionCancelledError";
  }
}

export class WorkflowExecutionTerminatedError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly reason: string,
  ) {
    super(`Workflow execution "${executionId}" was terminated: ${reason}`);
    this.name = "WorkflowExecutionTerminatedError";
  }
}

export class WorkflowExecutionVersionUnsupportedError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly executionVersion: number,
    public readonly supportedFrom: number,
    public readonly currentVersion: number,
  ) {
    super(
      `Workflow execution "${executionId}" uses version ${executionVersion}, but the current definition supports versions ${supportedFrom} through ${currentVersion}.`,
    );
    this.name = "WorkflowExecutionVersionUnsupportedError";
  }
}

export class WorkflowDeploymentVersionError extends Error {
  public constructor(
    public readonly diagnostics: readonly {
      workflowName: string;
      workflowVersion: number;
      count: number;
      reason: "definition-missing" | "version-unsupported";
    }[],
  ) {
    const summary = diagnostics.map((diagnostic) =>
      `${diagnostic.workflowName}@${diagnostic.workflowVersion} (${diagnostic.count}: ${diagnostic.reason})`
    ).join(", ");
    super(`Workflow deployment cannot replay active executions: ${summary}.`);
    this.name = "WorkflowDeploymentVersionError";
  }
}

/** Raised when an activation commits against a journal that has advanced. */
export class WorkflowJournalConflictError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(
      `Workflow execution "${executionId}" journal revision changed from ${expectedRevision} to ${actualRevision}.`,
    );
    this.name = "WorkflowJournalConflictError";
  }
}

/** Durable replay diagnostic for a command incompatible with history. */
export class WorkflowNondeterminismError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly sequence: number,
    public readonly expectedKind: string,
    public readonly expectedTarget: string,
    public readonly actualKind?: string,
    public readonly actualTarget?: string,
  ) {
    const actual = actualKind === undefined
      ? "no command"
      : `${actualKind}:${actualTarget ?? ""}`;

    super(
      `Workflow execution "${executionId}" is non-deterministic at command ${sequence}: expected ${expectedKind}:${expectedTarget}, received ${actual}.`,
    );
    this.name = "WorkflowNondeterminismError";
  }
}

/** Raised when code suspends on work the durable runtime does not own. */
export class WorkflowInvalidSuspensionError extends Error {
  public constructor(public readonly executionId: string) {
    super(
      `Workflow execution "${executionId}" suspended without an unresolved durable command.`,
    );
    this.name = "WorkflowInvalidSuspensionError";
  }
}

export class WorkflowCancellationError extends Error {
  public constructor(public readonly executionId: string) {
    super(`Workflow execution "${executionId}" was cancelled.`);
    this.name = "WorkflowCancellationError";
  }
}

export class WorkflowSignalTimeoutError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly signalName: string,
  ) {
    super(
      `Workflow execution "${executionId}" timed out waiting for signal "${signalName}".`,
    );
    this.name = "WorkflowSignalTimeoutError";
  }
}

/** Infrastructure failures are eligible for the declared activity retry policy. */
export class WorkflowActivityInfrastructureError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowActivityInfrastructureError";
  }
}

export class WorkflowActivityTimeoutError
  extends WorkflowActivityInfrastructureError {
  public constructor(
    public readonly executionId: string,
    public readonly sequence: number,
    public readonly timeoutKind: "schedule-to-close" | "start-to-close",
  ) {
    super(
      `Workflow activity ${sequence} for execution "${executionId}" exceeded its ${timeoutKind} timeout.`,
    );
    this.name = "WorkflowActivityTimeoutError";
  }
}

export class WorkflowHistoryLimitExceededError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly eventCount: number,
    public readonly limit: number,
  ) {
    super(
      `Workflow execution "${executionId}" contains ${eventCount} history events, exceeding the configured limit of ${limit}.`,
    );
    this.name = "WorkflowHistoryLimitExceededError";
  }
}
