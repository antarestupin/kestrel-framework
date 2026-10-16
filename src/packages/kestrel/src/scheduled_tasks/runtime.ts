import type { Logger } from "pino";

import type { RuntimeApp } from "../app/index.js";
import { runSupervisedRuntime } from "../app/process.js";
import type { Locks } from "../lock/index.js";
import type { ScheduledTasksConfig } from "./configuration.js";
import { ScheduledTaskScheduler } from "./scheduler.js";
import type { AnyScheduledTask } from "./task.js";
import type { ScheduledTaskAdapter } from "./types.js";

export interface ScheduledTaskSelection {
  readonly groups: readonly string[];
  readonly taskIds: readonly string[];
}

/** Selects an explicit union of ids and groups, or every task without filters. */
export function selectScheduledTasks(
  tasks: readonly AnyScheduledTask[],
  selection: ScheduledTaskSelection,
): readonly AnyScheduledTask[] {
  if (selection.taskIds.length === 0 && selection.groups.length === 0) {
    return tasks;
  }

  const knownIds = new Set(tasks.map((task) => task.id));
  const knownGroups = new Set(tasks.flatMap((task) => task.groups));
  const unknownId = selection.taskIds.find((id) => !knownIds.has(id));
  const unknownGroup = selection.groups.find((group) => !knownGroups.has(group));

  if (unknownId !== undefined) {
    throw new TypeError(`Unknown scheduled task id: "${unknownId}".`);
  }
  if (unknownGroup !== undefined) {
    throw new TypeError(`Unknown scheduled task group: "${unknownGroup}".`);
  }

  const selectedIds = new Set(selection.taskIds);
  const selectedGroups = new Set(selection.groups);

  return tasks.filter((task) =>
    selectedIds.has(task.id)
    || task.groups.some((group) => selectedGroups.has(group))
  );
}

/** Owns recurring-task polling and graceful draining for one application. */
export class ScheduledTaskRuntime<Config> {
  private scheduler: ScheduledTaskScheduler<Config> | undefined;

  private startPromise: Promise<void> | undefined;

  private stopPromise: Promise<void> | undefined;

  public constructor(
    private readonly app: RuntimeApp<Config>,
    private readonly adapter: ScheduledTaskAdapter,
    private readonly locks: Locks,
    private readonly config: ScheduledTasksConfig,
    private readonly logger: Logger,
  ) {
    app.shutdown.registerDrain(() => this.stop());
  }

  /** Builds a scheduler for a command-selected subset without starting it. */
  public buildScheduler(
    selection: ScheduledTaskSelection = { groups: [], taskIds: [] },
  ): ScheduledTaskScheduler<Config> {
    const tasks = selectScheduledTasks(
      this.app.catalog.scheduledTasks.tasks,
      selection,
    );

    return new ScheduledTaskScheduler(
      this.app,
      { persistent: this.adapter },
      this.locks,
      tasks,
      {
        slots: this.config.slots,
        leaseMs: this.config.leaseMs,
        pollIntervalMs: this.config.pollIntervalMs,
        defaultRuntime: {
          state: this.config.defaultState,
          coordination: this.config.defaultCoordination,
        },
        reportError: (error) => {
          this.logger.error({ err: error }, "Scheduled task execution failed");
        },
      },
    );
  }

  /** Retains polling termination independently of successful startup. */
  public get completion(): Promise<void> | undefined { return this.scheduler?.completion; }

  public async run(selection?: ScheduledTaskSelection): Promise<void> {
    const owner = this;
    await runSupervisedRuntime(this.app, {
      start: () => this.start(selection),
      stop: () => this.stop(),
      get completion() { return owner.completion; },
    });
  }

  /** Starts polling without owning process-signal coordination. */
  public async start(selection?: ScheduledTaskSelection): Promise<void> {
    if (this.stopPromise !== undefined) throw new Error("Scheduled task runtime has stopped.");
    this.scheduler ??= this.buildScheduler(selection);
    this.startPromise ??= this.scheduler.start();
    await this.startPromise;
  }

  /** Stops the scheduler; a composite runtime owns application stop. */
  public stop(): Promise<void> {
    this.stopPromise ??= this.app.shutdown.wait("scheduled task drain", async () => {
      const stopping = this.scheduler?.stop();
      await this.startPromise?.catch(() => undefined);
      await stopping;
    });

    return this.stopPromise;
  }
}
