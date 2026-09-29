import { isDeepStrictEqual } from "node:util";

import {
  WorkflowActivityInfrastructureError,
  WorkflowActivityTimeoutError,
  WorkflowCancellationError,
  WorkflowInvalidSuspensionError,
  WorkflowNondeterminismError,
  WorkflowSignalTimeoutError,
} from "./errors.js";
import type {
  WorkflowActivationSnapshot,
  WorkflowCommand,
  WorkflowCommandCompletedEvent,
  WorkflowCommandScheduledEvent,
} from "./history.js";
import type { WorkflowPayload } from "./serialization.js";

/** Durable-only context supplied to production replay activations. */
export interface WorkflowReplayContext {
  readonly executionId: string;
  readonly version: number;
  readonly generation: number;
  /** True when cancellation can be injected without skipping durable history. */
  readonly canDeliverCancellation: boolean;
  command<Result extends WorkflowPayload>(
    kind: string,
    target: string,
    payload: WorkflowPayload,
    cancellation?: Error,
  ): Promise<Result>;
  capture<Result extends WorkflowPayload>(
    target: string,
    capture: () => Promise<WorkflowPayload> | WorkflowPayload,
    cancellation?: Error,
  ): Promise<Result>;
}

export type WorkflowReplayHandler<Output = unknown> = (
  input: WorkflowPayload,
  context: WorkflowReplayContext,
) => Promise<Output> | Output;

export type WorkflowReplayResult<Output> =
  | {
      status: "blocked";
      error: WorkflowInvalidSuspensionError | WorkflowNondeterminismError;
      commands: readonly WorkflowCommand[];
    }
  | {
      status: "completed";
      output: Output;
      commands: readonly WorkflowCommand[];
    }
  | {
      status: "failed";
      error: unknown;
      commands: readonly WorkflowCommand[];
    }
  | {
      status: "waiting";
      commands: readonly WorkflowCommand[];
    };

export interface WorkflowReplayerOptions {
  /** Test seam used to drain promise reactions without retaining a process. */
  yieldExecution?: () => Promise<void>;
}

/** Rebuilds workflow state from immutable history during one short activation. */
export class WorkflowReplayer {
  private readonly yieldExecution: () => Promise<void>;

  public constructor(options: WorkflowReplayerOptions = {}) {
    this.yieldExecution = options.yieldExecution ?? yieldNodeExecution;
  }

  public async replay<Output>(
    snapshot: WorkflowActivationSnapshot,
    handler: WorkflowReplayHandler<Output>,
  ): Promise<WorkflowReplayResult<Output>> {
    const context = new ReplayContext(snapshot);
    let outcome: HandlerOutcome<Output> = { status: "running" };

    try {
      const result = handler(snapshot.input, context);
      void Promise.resolve(result).then(
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

    try {
      while (outcome.status === "running") {
        context.flushRecordedCompletions();
        await this.yieldExecution();

        if (outcome.status !== "running") {
          break;
        }

        if (context.hasRecordedCompletions) {
          continue;
        }

        context.assertExistingCommandsConsumed();

        if (!context.hasPendingCommands) {
          throw new WorkflowInvalidSuspensionError(snapshot.executionId);
        }

        return { status: "waiting", commands: context.stagedCommands };
      }

      const settled = outcome as SettledHandlerOutcome<Output>;
      context.assertExistingCommandsConsumed();

      if (
        settled.status === "failed"
        && (
          settled.error instanceof WorkflowInvalidSuspensionError
          || settled.error instanceof WorkflowNondeterminismError
        )
      ) {
        return {
          status: "blocked",
          error: settled.error,
          commands: [],
        };
      }

      return settled.status === "completed"
        ? {
            status: "completed",
            output: settled.output,
            commands: context.stagedCommands,
          }
        : {
            status: "failed",
            error: settled.error,
            commands: context.stagedCommands,
          };
    } catch (error) {
      if (
        error instanceof WorkflowInvalidSuspensionError
        || error instanceof WorkflowNondeterminismError
      ) {
        return { status: "blocked", error, commands: [] };
      }

      throw error;
    }
  }
}

interface ReplayedCommand extends WorkflowCommand {
  completion?: WorkflowCommandCompletedEvent;
}

interface ReplayResolution {
  completionOrder: number;
  error?: unknown;
  result?: WorkflowPayload;
  reject: (error: unknown) => void;
  resolve: (value: WorkflowPayload | undefined) => void;
}

type HandlerOutcome<Output> =
  | { status: "completed"; output: Output }
  | { status: "failed"; error: unknown }
  | { status: "running" };

type SettledHandlerOutcome<Output> = Exclude<
  HandlerOutcome<Output>,
  { status: "running" }
>;

class ReplayContext implements WorkflowReplayContext {
  public readonly executionId: string;

  public readonly version: number;

  public readonly generation: number;

  private readonly existingCommands: readonly ReplayedCommand[];

  private readonly cancellationDeliverySequence: number;

  private readonly newCommands: WorkflowCommand[] = [];

  private readonly recordedCompletions: ReplayResolution[] = [];

  private consumedCommandCount = 0;

  public constructor(snapshot: WorkflowActivationSnapshot) {
    this.executionId = snapshot.executionId;
    this.version = snapshot.workflowVersion;
    this.generation = snapshot.historyGeneration;
    this.existingCommands = materializeCommands(snapshot);
    this.cancellationDeliverySequence = findCancellationDeliverySequence(
      snapshot,
    );
  }

  public get stagedCommands(): readonly WorkflowCommand[] {
    return this.newCommands;
  }

  public get hasRecordedCompletions(): boolean {
    return this.recordedCompletions.length > 0;
  }

  public get hasPendingCommands(): boolean {
    return this.existingCommands
      .slice(0, this.consumedCommandCount)
      .some((command) => command.completion === undefined)
      || this.newCommands.length > 0;
  }

  public get canDeliverCancellation(): boolean {
    return this.consumedCommandCount >= this.cancellationDeliverySequence;
  }

  public command<Result extends WorkflowPayload>(
    kind: string,
    target: string,
    payload: WorkflowPayload,
    cancellation?: Error,
  ): Promise<Result> {
    validateCommandIdentity(kind, target);
    const sequence = this.consumedCommandCount;
    const actual: WorkflowCommand = { sequence, kind, target, payload };
    const existing = this.existingCommands[sequence];
    this.consumedCommandCount += 1;

    if (existing === undefined) {
      if (cancellation !== undefined) {
        throw cancellation;
      }
      this.newCommands.push(actual);
      return new Promise<Result>(() => undefined);
    }

    if (
      existing.kind !== kind
      || existing.target !== target
      || (
        kind !== "capture"
        && !isDeepStrictEqual(existing.payload, payload)
      )
    ) {
      throw new WorkflowNondeterminismError(
        this.executionId,
        sequence,
        existing.kind,
        existing.target,
        kind,
        target,
      );
    }

    if (cancellation !== undefined) {
      throw cancellation;
    }

    if (existing.completion === undefined) {
      return new Promise<Result>(() => undefined);
    }

    const completion = existing.completion;
    return new Promise<Result>((resolve, reject) => {
      this.recordedCompletions.push({
        completionOrder: completion.completionOrder,
        ...(completion.error === undefined
          ? completion.result === undefined
            ? {}
            : { result: completion.result }
          : { error: restoreWorkflowError(completion.error) }),
        resolve: (value) => resolve(value as Result),
        reject,
      });
    });
  }

  public capture<Result extends WorkflowPayload>(
    target: string,
    capture: () => Promise<WorkflowPayload> | WorkflowPayload,
    cancellation?: Error,
  ): Promise<Result> {
    validateCommandIdentity("capture", target);
    const sequence = this.consumedCommandCount;
    const existing = this.existingCommands[sequence];
    this.consumedCommandCount += 1;

    if (existing !== undefined) {
      if (existing.kind !== "capture" || existing.target !== target) {
        throw new WorkflowNondeterminismError(
          this.executionId,
          sequence,
          existing.kind,
          existing.target,
          "capture",
          target,
        );
      }

      if (cancellation !== undefined) throw cancellation;
      return this.promiseForExistingCompletion<Result>(existing);
    }

    if (cancellation !== undefined) throw cancellation;
    const command: WorkflowCommand = {
      sequence,
      kind: "capture",
      target,
      payload: null,
    };
    this.newCommands.push(command);
    return new Promise<Result>((_resolve, reject) => {
      void Promise.resolve().then(capture).then(
        (payload) => {
          command.payload = payload;
        },
        reject,
      );
    });
  }

  private promiseForExistingCompletion<Result extends WorkflowPayload>(
    existing: ReplayedCommand,
  ): Promise<Result> {
    if (existing.completion === undefined) {
      return new Promise<Result>(() => undefined);
    }

    const completion = existing.completion;
    return new Promise<Result>((resolve, reject) => {
      this.recordedCompletions.push({
        completionOrder: completion.completionOrder,
        ...(completion.error === undefined
          ? completion.result === undefined
            ? {}
            : { result: completion.result }
          : { error: restoreWorkflowError(completion.error) }),
        resolve: (value) => resolve(value as Result),
        reject,
      });
    });
  }

  public flushRecordedCompletions(): void {
    const completions = this.recordedCompletions.splice(0)
      .sort((left, right) => left.completionOrder - right.completionOrder);

    for (const completion of completions) {
      if (completion.error === undefined) {
        completion.resolve(completion.result);
      } else {
        completion.reject(completion.error);
      }
    }
  }

  public assertExistingCommandsConsumed(): void {
    const expected = this.existingCommands[this.consumedCommandCount];

    if (expected !== undefined) {
      throw new WorkflowNondeterminismError(
        this.executionId,
        this.consumedCommandCount,
        expected.kind,
        expected.target,
      );
    }
  }
}

function materializeCommands(
  snapshot: WorkflowActivationSnapshot,
): readonly ReplayedCommand[] {
  const completions = new Map<number, WorkflowCommandCompletedEvent>();

  for (const event of snapshot.history) {
    if (event.type === "command-completed") {
      completions.set(event.sequence, event);
    }
  }

  return snapshot.history
    .filter((event): event is WorkflowCommandScheduledEvent =>
      event.type === "command-scheduled")
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      target: event.target,
      payload: event.payload,
      ...(completions.has(event.sequence)
        ? { completion: completions.get(event.sequence)! }
        : {}),
    }));
}

/** Locates cancellation in history so later compensation commands do not move it. */
function findCancellationDeliverySequence(
  snapshot: WorkflowActivationSnapshot,
): number {
  const cancellation = snapshot.history.find(
    (event) => event.type === "cancellation-requested",
  );

  if (cancellation === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  const completedSequences = new Set(snapshot.history.flatMap((event) =>
    event.type === "command-completed"
      && event.eventIndex < cancellation.eventIndex
      ? [event.sequence]
      : []));
  const commandsBeforeCancellation = snapshot.history
    .filter((event): event is WorkflowCommandScheduledEvent =>
      event.type === "command-scheduled"
      && event.eventIndex < cancellation.eventIndex)
    .sort((left, right) => left.sequence - right.sequence);
  const pendingAtCancellation = commandsBeforeCancellation.filter(
    (command) => !completedSequences.has(command.sequence),
  );

  // Parallel commands are all reconstructed before cancellation reaches the
  // last pending boundary. Without pending work, delivery occurs at the next
  // command and a boundary-free handler return is cancelled by the scheduler.
  return pendingAtCancellation.at(-1)?.sequence
    ?? commandsBeforeCancellation.length;
}

function restoreWorkflowError(
  serialized: {
    name: string;
    message: string;
    stack?: string;
    details?: {
      executionId?: string;
      sequence?: number;
      signalName?: string;
      timeoutKind?: "schedule-to-close" | "start-to-close";
    };
  },
): Error {
  const details = serialized.details;
  const error = serialized.name === "WorkflowActivityTimeoutError"
    ? new WorkflowActivityTimeoutError(
        details?.executionId ?? "unknown",
        details?.sequence ?? -1,
        details?.timeoutKind ?? "start-to-close",
      )
    : serialized.name === "WorkflowActivityInfrastructureError"
      ? new WorkflowActivityInfrastructureError(serialized.message)
      : serialized.name === "WorkflowCancellationError"
        ? new WorkflowCancellationError(details?.executionId ?? "unknown")
        : serialized.name === "WorkflowSignalTimeoutError"
          ? new WorkflowSignalTimeoutError(
              details?.executionId ?? "unknown",
              details?.signalName ?? "unknown",
            )
          : new Error(serialized.message);
  // The durable message and stack remain authoritative even for known types.
  error.name = serialized.name;
  error.message = serialized.message;

  if (serialized.stack !== undefined) {
    error.stack = serialized.stack;
  }

  return error;
}

function validateCommandIdentity(kind: string, target: string): void {
  if (kind.length === 0 || target.length === 0) {
    throw new TypeError("Workflow command kind and target must not be empty.");
  }
}

function yieldNodeExecution(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
