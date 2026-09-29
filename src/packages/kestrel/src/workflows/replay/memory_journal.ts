import type {
  CreateWorkflowExecutionRequest,
  WorkflowCommand,
  WorkflowCommandCompletedEvent,
  WorkflowCommandScheduledEvent,
  WorkflowExecutionSnapshot,
  WorkflowHistoryEvent,
  WorkflowReplayJournal,
} from "./types.js";
import { WorkflowJournalConflictError } from "./types.js";

interface StoredWorkflowExecution {
  readonly id: string;
  readonly input: unknown;
  readonly version: number;
  readonly history: WorkflowHistoryEvent[];
  revision: number;
  nextCompletionOrder: number;
}

/** Deterministic in-memory journal used to validate the replay model. */
export class MemoryWorkflowReplayJournal implements WorkflowReplayJournal {
  private readonly executions = new Map<string, StoredWorkflowExecution>();

  public createExecution(request: CreateWorkflowExecutionRequest): void {
    if (this.executions.has(request.id)) {
      throw new Error(`Workflow execution "${request.id}" already exists.`);
    }

    if (!Number.isSafeInteger(request.version) || request.version < 1) {
      throw new TypeError("Workflow execution version must be a positive integer.");
    }

    this.executions.set(request.id, {
      id: request.id,
      input: request.input,
      version: request.version,
      history: [],
      revision: 0,
      nextCompletionOrder: 0,
    });
  }

  public async getExecution(
    executionId: string,
  ): Promise<WorkflowExecutionSnapshot> {
    return toSnapshot(this.getStoredExecution(executionId));
  }

  /** Atomically appends the decisions emitted by one replay activation. */
  public async appendCommands(
    executionId: string,
    expectedRevision: number,
    commands: readonly WorkflowCommand[],
  ): Promise<WorkflowExecutionSnapshot> {
    const execution = this.getStoredExecution(executionId);

    if (execution.revision !== expectedRevision) {
      throw new WorkflowJournalConflictError(
        executionId,
        expectedRevision,
        execution.revision,
      );
    }

    const scheduledCount = execution.history.filter(
      (event) => event.type === "command-scheduled",
    ).length;

    for (const [offset, command] of commands.entries()) {
      const expectedSequence = scheduledCount + offset;

      if (command.sequence !== expectedSequence) {
        throw new TypeError(
          `Expected command sequence ${expectedSequence}, received ${command.sequence}.`,
        );
      }
    }

    const events: WorkflowCommandScheduledEvent[] = commands.map(
      (command) => ({
        type: "command-scheduled",
        ...command,
      }),
    );

    execution.history.push(...events);
    execution.revision += events.length;

    return toSnapshot(execution);
  }

  /**
   * Records a command result once.
   *
   * Returning false models duplicate completion delivery without changing the
   * original result or its historical completion order.
   */
  public async completeCommand(
    executionId: string,
    sequence: number,
    result: unknown,
  ): Promise<boolean> {
    const execution = this.getStoredExecution(executionId);
    const scheduled = execution.history.find(
      (event): event is WorkflowCommandScheduledEvent =>
        event.type === "command-scheduled" && event.sequence === sequence,
    );

    if (scheduled === undefined) {
      throw new Error(
        `Workflow "${executionId}" has no scheduled command ${sequence}.`,
      );
    }

    const completed = execution.history.some(
      (event) => event.type === "command-completed"
        && event.sequence === sequence,
    );

    if (completed) {
      return false;
    }

    const event: WorkflowCommandCompletedEvent = {
      type: "command-completed",
      sequence,
      completionOrder: execution.nextCompletionOrder,
      result,
    };

    execution.nextCompletionOrder += 1;
    execution.history.push(event);
    execution.revision += 1;
    return true;
  }

  private getStoredExecution(executionId: string): StoredWorkflowExecution {
    const execution = this.executions.get(executionId);

    if (execution === undefined) {
      throw new Error(`Unknown workflow execution "${executionId}".`);
    }

    return execution;
  }
}

function toSnapshot(
  execution: StoredWorkflowExecution,
): WorkflowExecutionSnapshot {
  return {
    id: execution.id,
    input: execution.input,
    version: execution.version,
    revision: execution.revision,
    history: execution.history.map((event) => ({ ...event })),
  };
}
