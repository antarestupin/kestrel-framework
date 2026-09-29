import type { Logger } from "pino";
import { z } from "zod";

import type { Provider, ProviderCompositionApp } from "../app/index.js";
import {
  defineCliController,
  repeatableOption,
} from "../cli/index.js";
import { loggerDependency } from "../log/index.js";
import type { Locks } from "../lock/index.js";
import type { ScheduledTasksConfig } from "./configuration.js";
import {
  scheduledTaskAdapterDependency,
  scheduledTaskRuntimeDependency,
} from "./dependencies.js";
import { every } from "./schedule.js";
import { defineScheduledTask } from "./task.js";
import {
  PostgresScheduledTaskAdapter,
  type PostgresScheduledTaskDatabase,
} from "./adapters/index.js";
import { ScheduledTaskRuntime } from "./runtime.js";

interface ScheduledTaskAdapterDependencies {
  database: PostgresScheduledTaskDatabase;
}

interface ScheduledTaskRuntimeDependencies {
  applicationLogger: Logger;
  locks: Locks;
  scheduledTaskAdapter: PostgresScheduledTaskAdapter;
}

const runScheduledTasksInput = z.object({
  groups: z.array(z.string().min(1)).default([])
    .describe("Run tasks from this group; repeatable."),
  taskIds: z.array(z.string().min(1)).default([])
    .describe("Run this task id; repeatable."),
});

/** Adds durable scheduled-task occurrence state to an application. */
export class ScheduledTaskProvider<Config> implements Provider<Config> {
  public constructor(protected readonly config: ScheduledTasksConfig) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "scheduledTaskAdapter",
      ({ database }: ScheduledTaskAdapterDependencies) =>
        this.createAdapter(database),
      { lifetime: "singleton" },
    );
    app.container.registerFactory<
      ScheduledTaskRuntime<Config>,
      ScheduledTaskRuntimeDependencies
    >(
      "scheduledTaskRuntime",
      ({ applicationLogger, locks, scheduledTaskAdapter }) =>
        new ScheduledTaskRuntime(
          app.runtime,
          scheduledTaskAdapter,
          locks,
          this.config,
          applicationLogger.child({ workload: "scheduled-tasks" }),
        ),
      { lifetime: "singleton" },
    );
    app.catalog.contribute({
      scheduledTaskRuntime: {
        controllers: {
          cli: {
            runScheduledTasks: defineCliController({
              command: "run scheduled-tasks",
              description: "Run recurring scheduled tasks.",
              input: runScheduledTasksInput,
              bindings: {
                groups: repeatableOption("group"),
                taskIds: repeatableOption("task"),
              },
              dependencies: { runtime: scheduledTaskRuntimeDependency },
              runtime: "scheduled-tasks",
              workloads: ["scheduled-tasks"],
              observe: false,
              handler: async ({ input, deps }) => {
                await deps.runtime.run(input);
              },
            }),
          },
        },
      },
    }, { kind: "provider", provider: this.constructor.name });

    if (this.config.expiredRunPruneIntervalSeconds > 0) {
      app.catalog.contribute({
        maintenance: {
          scheduledTasks: {
            pruneExpiredRuns: this.createExpiredRunPruneTask(),
          },
        },
      }, { kind: "provider", provider: this.constructor.name });
    }
  }

  /** Creates the persistent occurrence-state adapter. */
  protected createAdapter(
    database: PostgresScheduledTaskDatabase,
  ): PostgresScheduledTaskAdapter {
    return new PostgresScheduledTaskAdapter(database);
  }

  /** Defines expired-run maintenance owned by the scheduled-task library. */
  protected createExpiredRunPruneTask() {
    return defineScheduledTask({
      id: "maintenance.scheduled-task-runs-prune",
      description: "Restore and remove expired scheduled task runs.",
      groups: ["maintenance"],
      schedule: every({ seconds: this.config.expiredRunPruneIntervalSeconds }),
      overlap: "skip",
      executionLog: false,
      observe: false,
      runtime: { state: "persistent", coordination: "distributed" },
      dependencies: {
        adapter: scheduledTaskAdapterDependency,
        logger: loggerDependency,
      },
      handler: async ({ adapter, logger }) => {
        const removed = await adapter.pruneExpiredRuns({
          limit: this.config.expiredRunPruneBatchSize,
        });

        if (removed > 0) {
          logger.debug({ removed }, "Pruned expired scheduled task runs");
        }
      },
    });
  }
}
