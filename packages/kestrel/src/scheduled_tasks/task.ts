import type {
  DependencyDeclarations,
  ResolvedDependencies,
} from "../di/index.js";
import {
  durationToMs,
  type ScheduleDuration,
  type ScheduledTaskSchedule,
} from "./schedule.js";

export type ScheduledTaskOverlap = "parallel" | "skip" | "wait";
export type ScheduledTaskStateKind = "memory" | "persistent";
export type ScheduledTaskCoordination = "distributed" | "local";

export interface ScheduledTaskRuntimeOptions {
  state?: ScheduledTaskStateKind;
  coordination?: ScheduledTaskCoordination;
}

export interface ScheduledTaskExecutionContext {
  readonly signal: AbortSignal;
  readonly scheduledAt: Date;
  readonly trigger: "manual" | "scheduled";
  /** Ensures the next occurrence is no earlier than this delay after completion. */
  deferNextRun(delay: ScheduleDuration): void;
}

export interface ScheduledTaskOptions<
  Dependencies extends DependencyDeclarations<never>,
> {
  id: string;
  description?: string;
  groups?: readonly string[];
  schedule: ScheduledTaskSchedule;
  dependencies?: Dependencies;
  overlap?: ScheduledTaskOverlap;
  /** Enables the execution-context log emitted for each task invocation. */
  executionLog?: boolean;
  /** Enables execution observations and ambient instrumentation for invocations. */
  observe?: boolean;
  runtime?: ScheduledTaskRuntimeOptions;
  handler: (
    dependencies: ResolvedDependencies<Dependencies>,
    context: ScheduledTaskExecutionContext,
  ) => Promise<void> | void;
}

/** Runtime scheduled-task contract retaining its dependency declarations. */
export interface ScheduledTask<
  Dependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> {
  readonly id: string;
  readonly description?: string;
  readonly groups: readonly string[];
  readonly schedule: ScheduledTaskSchedule;
  readonly dependencies: Dependencies;
  readonly overlap: ScheduledTaskOverlap;
  readonly executionLog: boolean;
  readonly observe: boolean;
  readonly runtime: Readonly<ScheduledTaskRuntimeOptions>;
  readonly handler: ScheduledTaskOptions<Dependencies>["handler"];
}

export type AnyScheduledTask = ScheduledTask<any>;

/** Defines one typed recurring application task. */
export function defineScheduledTask<
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  options: ScheduledTaskOptions<Dependencies>,
): ScheduledTask<Dependencies> {
  validateTaskOptions(options);

  return {
    id: options.id,
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    groups: [...new Set(options.groups ?? [])],
    schedule: options.schedule,
    dependencies: options.dependencies ?? ({} as Dependencies),
    overlap: options.overlap ?? "skip",
    executionLog: options.executionLog ?? true,
    observe: options.observe ?? true,
    runtime: { ...options.runtime },
    handler: options.handler,
  };
}

/** Creates the mutable deferral callback used for one handler invocation. */
export function createNextRunDeferral(): {
  deferNextRun(delay: ScheduleDuration): void;
  readonly delayMs: number | undefined;
} {
  let deferredDelayMs: number | undefined;

  return {
    deferNextRun: (delay) => {
      const delayMs = durationToMs(delay);
      deferredDelayMs = Math.max(deferredDelayMs ?? 0, delayMs);
    },
    get delayMs() {
      return deferredDelayMs;
    },
  };
}

function validateTaskOptions(
  options: Pick<ScheduledTaskOptions<any>, "groups" | "id">,
): void {
  if (options.id.length === 0) {
    throw new TypeError("Scheduled task ids cannot be empty.");
  }

  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(options.id)) {
    throw new TypeError(
      "Scheduled task ids must contain lowercase segments separated by '.', '_' or '-'.",
    );
  }

  for (const group of options.groups ?? []) {
    if (group.length === 0) {
      throw new TypeError("Scheduled task groups cannot be empty.");
    }
  }
}
