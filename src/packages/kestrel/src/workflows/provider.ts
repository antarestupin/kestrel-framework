import type { Logger } from "pino";

import type { Provider, ProviderCompositionApp } from "../app/index.js";
import { defineCliController } from "../cli/index.js";
import {
  PostgresWorkflowAdapter,
  type PostgresWorkflowDatabase,
} from "./adapters/index.js";
import { WorkflowClient } from "./client.js";
import { WorkflowOperations } from "./operations.js";
import {
  workflowAdapterDependency,
  workflowRuntimeDependency,
} from "./dependencies.js";
import { WorkflowRuntime } from "./runtime.js";
import type { WorkflowSchedulerOptions } from "./scheduler.js";
import {
  workerClientDependency,
  workerCorrelatedCompletionSinkDependency,
  type AnyWorker,
  type WorkerClient,
  WorkerCorrelatedCompletionRouter,
} from "../workers/index.js";
import type { WorkflowAdapter } from "./adapter.js";
import {
  createWorkflowActivityWorker,
  WorkflowWorkerCompletionSink,
  type WorkflowActivityOutboxDispatcherOptions,
} from "./worker_activity_transport.js";
import { observerContextDependency } from "../observability/index.js";
import {
  recordWorkflowInstrumentation,
  type WorkflowInstrumentation,
} from "./observations.js";

interface WorkflowAdapterDependencies {
  database: PostgresWorkflowDatabase;
}

interface WorkflowClientDependencies {
  workflowAdapter: WorkflowAdapter;
}

interface WorkflowRuntimeDependencies {
  applicationLogger: Logger;
  workflowAdapter: WorkflowAdapter;
}

export interface WorkflowProviderOptions extends WorkflowSchedulerOptions {
  activityTransport?: "embedded" | "worker";
  outbox?: WorkflowActivityOutboxDispatcherOptions;
}

/** Adds durable workflow storage, clients, scheduling, and CLI composition. */
export class WorkflowProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly options: WorkflowProviderOptions = {},
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    const workerBacked = this.options.activityTransport === "worker";
    const activityWorker: AnyWorker | undefined = workerBacked
      ? createWorkflowActivityWorker(app.runtime)
      : undefined;
    const instrumentation = this.createInstrumentation(app);
    app.container.registerFactory(
      "workflowAdapter",
      ({ database }: WorkflowAdapterDependencies) =>
        new PostgresWorkflowAdapter(database, {
          activityDispatchMode: workerBacked ? "outbox" : "embedded",
        }),
      { lifetime: "singleton" },
    );
    app.container.registerFactory(
      "workflowClient",
      ({ workflowAdapter }: WorkflowClientDependencies) =>
        new WorkflowClient(workflowAdapter, {
          ...(this.options.payloadCodec === undefined
            ? {}
            : { payloadCodec: this.options.payloadCodec }),
          ...(instrumentation === undefined ? {} : { instrumentation }),
        }),
      { lifetime: "singleton" },
    );
    app.container.registerFactory(
      "workflowOperations",
      ({ workflowAdapter }: WorkflowClientDependencies) =>
        new WorkflowOperations(
          app.catalog.workflows.definitions,
          workflowAdapter,
          {
            ...(this.options.payloadCodec === undefined
              ? {}
              : { payloadCodec: this.options.payloadCodec }),
            ...(instrumentation === undefined ? {} : { instrumentation }),
          },
        ),
      { lifetime: "singleton" },
    );
    app.container.registerFactory<
      WorkflowRuntime<Config>,
      WorkflowRuntimeDependencies
    >(
      "workflowRuntime",
      ({ applicationLogger, workflowAdapter }) =>
        new WorkflowRuntime(
          app.runtime,
          workflowAdapter,
          applicationLogger.child({ workload: "workflows" }),
          {
            ...this.options,
            ...(instrumentation === undefined ? {} : { instrumentation }),
          },
          activityWorker,
          this.resolveWorkerClient(app, workerBacked),
        ),
      { lifetime: "singleton" },
    );
    app.catalog.contribute({
      workflowRuntime: {
        ...(activityWorker === undefined
          ? {}
          : { workers: { workflowActivity: activityWorker } }),
        controllers: {
          cli: {
            runWorkflows: defineCliController({
              command: "run workflows",
              description: "Run durable workflows and configured activity dispatch.",
              dependencies: { runtime: workflowRuntimeDependency },
              runtime: "workflow",
              workloads: ["workflows"],
              observe: false,
              handler: async ({ deps }) => deps.runtime.run(),
            }),
          },
        },
      },
    }, { kind: "provider", provider: this.constructor.name });

    if (workerBacked) {
      if (!app.container.hasRegistration("workerCorrelatedCompletionSink")) {
        throw new Error(
          "Worker-backed workflow activities require WorkerProvider.",
        );
      }
      const router = app.container.resolve(
        workerCorrelatedCompletionSinkDependency,
      );
      if (!(router instanceof WorkerCorrelatedCompletionRouter)) {
        throw new TypeError(
          "Worker-backed workflow activities require the Worker completion router.",
        );
      }
      router.register(
        "workflow.activity",
        new WorkflowWorkerCompletionSink(
          app.container.resolve(workflowAdapterDependency),
        ),
      );
    }
  }

  private createInstrumentation(
    app: ProviderCompositionApp<Config>,
  ): WorkflowInstrumentation | undefined {
    const configured = this.options.instrumentation;
    const observerContext = app.container.hasRegistration("observerContext")
      ? app.container.resolve(observerContextDependency)
      : undefined;
    if (configured === undefined && observerContext === undefined) return undefined;

    return {
      record: (event) => {
        configured?.record(event);
        const observer = observerContext?.get();
        if (observer !== undefined) recordWorkflowInstrumentation(observer, event);
      },
    };
  }

  private resolveWorkerClient(
    app: ProviderCompositionApp<Config>,
    required: boolean,
  ): WorkerClient | undefined {
    if (!required) return undefined;
    if (!app.container.hasRegistration("workerClient")) {
      throw new Error(
        "Worker-backed workflow activities require WorkerProvider.",
      );
    }
    return app.container.resolve(workerClientDependency);
  }
}
