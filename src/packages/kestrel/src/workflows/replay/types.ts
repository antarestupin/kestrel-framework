/** One durable command emitted by workflow orchestration code. */
export interface WorkflowCommand {
  sequence: number;
  kind: string;
  target: string;
}

/** Records the durable scheduling decision for one command. */
export interface WorkflowCommandScheduledEvent extends WorkflowCommand {
  type: "command-scheduled";
}

/** Records the terminal result of one scheduled command. */
export interface WorkflowCommandCompletedEvent {
  type: "command-completed";
  sequence: number;
  completionOrder: number;
  result: unknown;
}

export type WorkflowHistoryEvent =
  | WorkflowCommandCompletedEvent
  | WorkflowCommandScheduledEvent;

/** Immutable execution data loaded at the start of one replay activation. */
export interface WorkflowExecutionSnapshot {
  id: string;
  input: unknown;
  version: number;
  revision: number;
  history: readonly WorkflowHistoryEvent[];
}

export interface CreateWorkflowExecutionRequest {
  id: string;
  input: unknown;
  version: number;
}

/** Minimal journal boundary required by the phase-zero replay runner. */
export interface WorkflowReplayJournal {
  getExecution(executionId: string): Promise<WorkflowExecutionSnapshot>;
  appendCommands(
    executionId: string,
    expectedRevision: number,
    commands: readonly WorkflowCommand[],
  ): Promise<WorkflowExecutionSnapshot>;
}

/** Context deliberately limited to durable commands during the prototype. */
export interface WorkflowReplayContext {
  readonly executionId: string;
  readonly version: number;
  command<Result>(kind: string, target: string): Promise<Result>;
}

export type WorkflowReplayHandler<Input, Output> = (
  input: Input,
  context: WorkflowReplayContext,
) => Promise<Output> | Output;

export interface PendingWorkflowCommand extends WorkflowCommand {
  status: "pending";
}

export type WorkflowActivationResult<Output> =
  | {
      status: "completed";
      output: Output;
      pendingCommands: readonly PendingWorkflowCommand[];
    }
  | {
      status: "failed";
      error: unknown;
      pendingCommands: readonly PendingWorkflowCommand[];
    }
  | {
      status: "waiting";
      pendingCommands: readonly PendingWorkflowCommand[];
    };

/** Raised when replayed code emits a command different from durable history. */
export class WorkflowNondeterminismError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly sequence: number,
    public readonly expected: WorkflowCommand,
    public readonly actual?: WorkflowCommand,
  ) {
    const actualDescription = actual === undefined
      ? "no command"
      : `${actual.kind}:${actual.target}`;

    super(
      `Workflow "${executionId}" is non-deterministic at command ${sequence}: expected ${expected.kind}:${expected.target}, received ${actualDescription}.`,
    );
    this.name = "WorkflowNondeterminismError";
  }
}

/** Raised when a handler waits on work that the workflow runtime does not own. */
export class WorkflowInvalidSuspensionError extends Error {
  public constructor(public readonly executionId: string) {
    super(
      `Workflow "${executionId}" suspended without an unresolved durable command.`,
    );
    this.name = "WorkflowInvalidSuspensionError";
  }
}

/** Raised when concurrent activations try to append from the same revision. */
export class WorkflowJournalConflictError extends Error {
  public constructor(
    public readonly executionId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(
      `Workflow "${executionId}" journal revision changed from ${expectedRevision} to ${actualRevision}.`,
    );
    this.name = "WorkflowJournalConflictError";
  }
}
