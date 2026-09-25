import type {
  PendingWorkflowCommand,
  WorkflowActivationResult,
  WorkflowCommand,
  WorkflowCommandCompletedEvent,
  WorkflowCommandScheduledEvent,
  WorkflowExecutionSnapshot,
  WorkflowReplayContext,
  WorkflowReplayHandler,
  WorkflowReplayJournal,
} from "./types.js";
import {
  WorkflowInvalidSuspensionError,
  WorkflowNondeterminismError,
} from "./types.js";

interface ReplayedCommand extends WorkflowCommand {
  completion?: WorkflowCommandCompletedEvent;
}

interface ReplayResolution {
  completionOrder: number;
  result: unknown;
  resolve: (value: unknown) => void;
}

type HandlerOutcome<Output> =
  | { status: "completed"; output: Output }
  | { status: "failed"; error: unknown }
  | { status: "running" };

type SettledHandlerOutcome<Output> = Exclude<
  HandlerOutcome<Output>,
  { status: "running" }
>;

export interface WorkflowReplayRunnerOptions {
  /** Yields until JavaScript microtasks scheduled by workflow promises drain. */
  yieldExecution?: () => Promise<void>;
}

/**
 * Phase-zero deterministic workflow replayer.
 *
 * It intentionally owns no activity execution or persistence policy beyond
 * appending commands through the supplied journal.
 */
export class WorkflowReplayRunner {
  private readonly yieldExecution: () => Promise<void>;

  public constructor(
    private readonly journal: WorkflowReplayJournal,
    options: WorkflowReplayRunnerOptions = {},
  ) {
    this.yieldExecution = options.yieldExecution ?? yieldNodeExecution;
  }

  public async activate<Input, Output>(
    executionId: string,
    handler: WorkflowReplayHandler<Input, Output>,
  ): Promise<WorkflowActivationResult<Output>> {
    const snapshot = await this.journal.getExecution(executionId);
    const replay = new ReplayContext(snapshot);
    let outcome: HandlerOutcome<Output> = { status: "running" };

    try {
      const handlerResult = handler(snapshot.input as Input, replay);

      void Promise.resolve(handlerResult).then(
        (output) => {
          outcome = { status: "completed", output };
        },
        (error: unknown) => {
          outcome = { status: "failed", error };
        },
      );
    } catch (error) {
      outcome = { status: "failed", error };
    }

    while (outcome.status === "running") {
      replay.flushRecordedCompletions();
      await this.yieldExecution();

      if (outcome.status !== "running") {
        break;
      }

      if (replay.hasRecordedCompletions) {
        continue;
      }

      replay.assertExistingHistoryConsumed();

      if (!replay.hasPendingCommands) {
        throw new WorkflowInvalidSuspensionError(executionId);
      }

      await this.commitStagedCommands(snapshot, replay.stagedCommands);
      return {
        status: "waiting",
        pendingCommands: await this.listPendingCommands(executionId),
      };
    }

    // The loop returns on suspension and only breaks after the handler settles.
    const settledOutcome = outcome as SettledHandlerOutcome<Output>;

    if (
      settledOutcome.status === "failed"
      && settledOutcome.error instanceof WorkflowNondeterminismError
    ) {
      throw settledOutcome.error;
    }

    replay.assertExistingHistoryConsumed();
    await this.commitStagedCommands(snapshot, replay.stagedCommands);
    const pendingCommands = await this.listPendingCommands(executionId);

    if (settledOutcome.status === "failed") {
      return {
        status: "failed",
        error: settledOutcome.error,
        pendingCommands,
      };
    }

    return {
      status: "completed",
      output: settledOutcome.output,
      pendingCommands,
    };
  }

  private async commitStagedCommands(
    snapshot: WorkflowExecutionSnapshot,
    commands: readonly WorkflowCommand[],
  ): Promise<void> {
    if (commands.length === 0) {
      return;
    }

    await this.journal.appendCommands(
      snapshot.id,
      snapshot.revision,
      commands,
    );
  }

  private async listPendingCommands(
    executionId: string,
  ): Promise<readonly PendingWorkflowCommand[]> {
    const snapshot = await this.journal.getExecution(executionId);
    const completedSequences = new Set(
      snapshot.history
        .filter((event) => event.type === "command-completed")
        .map((event) => event.sequence),
    );

    return snapshot.history
      .filter((event): event is WorkflowCommandScheduledEvent =>
        event.type === "command-scheduled"
        && !completedSequences.has(event.sequence),
      )
      .map((event) => ({
        sequence: event.sequence,
        kind: event.kind,
        target: event.target,
        status: "pending",
      }));
  }
}

class ReplayContext implements WorkflowReplayContext {
  public readonly executionId: string;

  public readonly version: number;

  private readonly existingCommands: readonly ReplayedCommand[];

  private readonly newCommands: WorkflowCommand[] = [];

  private readonly recordedCompletions: ReplayResolution[] = [];

  private consumedCommandCount = 0;

  public constructor(snapshot: WorkflowExecutionSnapshot) {
    this.executionId = snapshot.id;
    this.version = snapshot.version;
    this.existingCommands = materializeCommands(snapshot);
  }

  public get stagedCommands(): readonly WorkflowCommand[] {
    return this.newCommands;
  }

  public get hasRecordedCompletions(): boolean {
    return this.recordedCompletions.length > 0;
  }

  public get hasPendingCommands(): boolean {
    const consumedExisting = this.existingCommands.slice(
      0,
      this.consumedCommandCount,
    );

    return consumedExisting.some((command) => command.completion === undefined)
      || this.newCommands.length > 0;
  }

  public command<Result>(kind: string, target: string): Promise<Result> {
    validateCommandIdentity(kind, target);

    const sequence = this.consumedCommandCount;
    const actual: WorkflowCommand = { sequence, kind, target };
    const existing = this.existingCommands[sequence];
    this.consumedCommandCount += 1;

    if (existing !== undefined) {
      if (existing.kind !== kind || existing.target !== target) {
        throw new WorkflowNondeterminismError(
          this.executionId,
          sequence,
          existing,
          actual,
        );
      }

      if (existing.completion === undefined) {
        return new Promise<Result>(() => undefined);
      }

      const completion = existing.completion;
      return new Promise<Result>((resolve) => {
        this.recordedCompletions.push({
          completionOrder: completion.completionOrder,
          result: completion.result,
          resolve: (value) => resolve(value as Result),
        });
      });
    }

    this.newCommands.push(actual);
    return new Promise<Result>(() => undefined);
  }

  /** Resolves replayed results in their durable completion order. */
  public flushRecordedCompletions(): void {
    const resolutions = this.recordedCompletions.splice(0)
      .sort((left, right) => left.completionOrder - right.completionOrder);

    for (const resolution of resolutions) {
      resolution.resolve(resolution.result);
    }
  }

  public assertExistingHistoryConsumed(): void {
    const expected = this.existingCommands[this.consumedCommandCount];

    if (expected !== undefined) {
      throw new WorkflowNondeterminismError(
        this.executionId,
        this.consumedCommandCount,
        expected,
      );
    }
  }
}

function materializeCommands(
  snapshot: WorkflowExecutionSnapshot,
): readonly ReplayedCommand[] {
  const completions = new Map<number, WorkflowCommandCompletedEvent>();

  for (const event of snapshot.history) {
    if (event.type === "command-completed") {
      completions.set(event.sequence, event);
    }
  }

  return snapshot.history
    .filter((event): event is WorkflowCommandScheduledEvent =>
      event.type === "command-scheduled",
    )
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      target: event.target,
      ...(completions.has(event.sequence)
        ? { completion: completions.get(event.sequence)! }
        : {}),
    }));
}

function validateCommandIdentity(kind: string, target: string): void {
  if (kind.length === 0 || target.length === 0) {
    throw new TypeError("Workflow command kind and target must not be empty.");
  }
}

/** Lets all promise reactions queued by one replay pass settle. */
function yieldNodeExecution(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
