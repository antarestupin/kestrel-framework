import type { Logger } from "pino";

import type { Provider, ProviderCompositionApp } from "../app/index.js";
import { defineCliController } from "../cli/index.js";
import {
  PostgresWorkerAdapter,
  type PostgresWorkerDatabase,
} from "./adapters/index.js";
import type { WorkerAdapter } from "./types.js";
import { WorkerClient } from "./client.js";
import type { WorkersConfig } from "./configuration.js";
import {
  throttlingDependency,
  type AdmissionPolicyDefinition,
  type Throttling,
} from "../throttling/index.js";
import {
  workerCorrelatedCompletionSinkDependency,
  workerRuntimeDependency,
  WorkerCorrelatedCompletionRouter,
  type WorkerCorrelatedCompletionSink,
} from "./dependencies.js";
import { WorkerRuntime } from "./runtime.js";

interface WorkerAdapterDependencies {
  database: PostgresWorkerDatabase;
}

interface WorkerClientDependencies {
  workerAdapter: WorkerAdapter;
}

interface WorkerRuntimeDependencies {
  applicationLogger: Logger;
  workerAdapter: WorkerAdapter;
}

export interface WorkerProviderOptions {
  /** Job-independent local pressure inspected before queue reservation. */
  readonly reservationPressure?: AdmissionPolicyDefinition;
  /** Replaces PostgreSQL with an application-owned queue adapter such as SQS. */
  readonly adapter?: WorkerAdapter;
  /** Result owners keyed by their adapter-neutral correlation namespace. */
  readonly completionSinks?: Readonly<
    Record<string, WorkerCorrelatedCompletionSink>
  >;
}

/** Adds the shared queue API and its PostgreSQL storage adapter. */
export class WorkerProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly config: WorkersConfig,
    protected readonly options: WorkerProviderOptions = {},
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    if (this.options.adapter === undefined) {
      app.container.registerFactory(
        "workerAdapter",
        ({ database }: WorkerAdapterDependencies) =>
          this.createAdapter(database),
        { lifetime: "singleton" },
      );
    } else {
      app.container.registerValue("workerAdapter", this.options.adapter);
    }
    app.container.registerValue(
      "workerCorrelatedCompletionSink",
      new WorkerCorrelatedCompletionRouter(this.options.completionSinks),
    );
    app.container.registerFactory(
      "workerClient",
      ({ workerAdapter }: WorkerClientDependencies) =>
        this.createClient(workerAdapter),
      { lifetime: "singleton" },
    );
    app.container.registerFactory<
      WorkerRuntime<Config>,
      WorkerRuntimeDependencies
    >(
      "workerRuntime",
      ({ applicationLogger, workerAdapter }) =>
        new WorkerRuntime(
          app.runtime,
          workerAdapter,
          this.config,
          applicationLogger.child({ workload: "workers" }),
          this.resolveThrottling(app),
          this.options.reservationPressure,
          this.resolveCompletionSink(app),
        ),
      { lifetime: "singleton" },
    );
    app.catalog.contribute({
      workerRuntime: {
        controllers: {
          cli: {
            runWorkers: defineCliController({
              command: "run workers",
              description: "Run queue workers.",
              dependencies: { runtime: workerRuntimeDependency },
              runtime: "worker",
              workloads: ["workers"],
              observe: false,
              handler: async ({ deps }) => {
                await deps.runtime.run();
              },
            }),
          },
        },
      },
    }, { kind: "provider", provider: this.constructor.name });
  }

  /** Creates the persistent queue adapter. */
  protected createAdapter(database: PostgresWorkerDatabase): WorkerAdapter {
    return new PostgresWorkerAdapter(database);
  }

  /** Creates the public queue client from the configured adapter. */
  protected createClient(adapter: WorkerAdapter): WorkerClient {
    return new WorkerClient(adapter);
  }

  /** Keeps throttling optional for applications without protected workers. */
  protected resolveThrottling(
    app: ProviderCompositionApp<Config>,
  ): Throttling | undefined {
    return app.container.hasRegistration("throttling")
      ? app.container.resolve(throttlingDependency)
      : undefined;
  }

  /** Keeps result ownership optional and independent from the queue backend. */
  protected resolveCompletionSink(
    app: ProviderCompositionApp<Config>,
  ): WorkerCorrelatedCompletionSink | undefined {
    return app.container.hasRegistration("workerCorrelatedCompletionSink")
      ? app.container.resolve(workerCorrelatedCompletionSinkDependency)
      : undefined;
  }
}
