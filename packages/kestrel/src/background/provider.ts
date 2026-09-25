import { z } from "zod";

import type { Provider, ProviderCompositionApp } from "../app/index.js";
import { defineCliController, repeatableOption } from "../cli/index.js";
import { scheduledTaskRuntimeDependency } from "../scheduled_tasks/index.js";
import { workerRuntimeDependency } from "../workers/index.js";
import { workflowRuntimeDependency } from "../workflows/dependencies.js";
import { backgroundRuntimeDependency } from "./dependencies.js";
import {
  BackgroundRuntime,
  backgroundWorkloads,
  type BackgroundWorkload,
  type BackgroundWorkloadRuntime,
} from "./runtime.js";

const runBackgroundInput = z.object({
  workloads: z.array(z.enum(backgroundWorkloads)).default([])
    .describe("Background workload to run; repeatable."),
});

/** Composes independently registered background runtimes in one process. */
export class BackgroundProvider<Config> implements Provider<Config> {
  public register(app: ProviderCompositionApp<Config>): void {
    const available = this.availableWorkloads(app);
    app.container.registerFactory(
      "backgroundRuntime",
      () => new BackgroundRuntime(app.runtime, this.resolveRuntimes(app)),
      { lifetime: "singleton" },
    );
    app.catalog.contribute({
      backgroundRuntime: {
        controllers: {
          cli: {
            runBackground: defineCliController({
              command: "run background",
              description: "Run selected background workloads.",
              input: runBackgroundInput,
              bindings: { workloads: repeatableOption("workload") },
              dependencies: { runtime: backgroundRuntimeDependency },
              prepareWorkloads: (arguments_) =>
                readRequestedWorkloads(arguments_, available),
              observe: false,
              runtime: "background",
              handler: async ({ input, deps }) => {
                await deps.runtime.run(input.workloads);
              },
            }),
          },
        },
      },
    }, { kind: "provider", provider: this.constructor.name });
  }

  private availableWorkloads(
    app: ProviderCompositionApp<Config>,
  ): readonly BackgroundWorkload[] {
    return backgroundWorkloads.filter((workload) =>
      app.container.hasRegistration(runtimeRegistration[workload]));
  }

  private resolveRuntimes(
    app: ProviderCompositionApp<Config>,
  ): Partial<Record<BackgroundWorkload, BackgroundWorkloadRuntime>> {
    return {
      ...(app.container.hasRegistration("workerRuntime")
        ? { workers: app.container.resolve(workerRuntimeDependency) }
        : {}),
      ...(app.container.hasRegistration("scheduledTaskRuntime")
        ? {
            "scheduled-tasks": app.container.resolve(
              scheduledTaskRuntimeDependency,
            ),
          }
        : {}),
      ...(app.container.hasRegistration("workflowRuntime")
        ? {
            workflows: app.container.resolve(workflowRuntimeDependency),
          }
        : {}),
    };
  }
}

const runtimeRegistration: Record<BackgroundWorkload, string> = {
  workers: "workerRuntime",
  "scheduled-tasks": "scheduledTaskRuntime",
  workflows: "workflowRuntime",
};

export function readRequestedWorkloads(
  arguments_: readonly string[],
  available: readonly BackgroundWorkload[],
): readonly BackgroundWorkload[] {
  const requested: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;

    if (argument === "--workload") {
      const value = arguments_[index + 1];
      if (value !== undefined) requested.push(value);
      index += 1;
    } else if (argument.startsWith("--workload=")) {
      requested.push(argument.slice("--workload=".length));
    }
  }

  const selected = requested.length === 0 ? available : requested;

  for (const workload of selected) {
    if (!backgroundWorkloads.includes(workload as BackgroundWorkload)) {
      throw new TypeError(`Unknown background workload: "${workload}".`);
    }
    if (!available.includes(workload as BackgroundWorkload)) {
      throw new TypeError(`Unavailable background workload: "${workload}".`);
    }
  }

  return [...new Set(selected)] as BackgroundWorkload[];
}
