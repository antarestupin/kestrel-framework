import { registerProviderAdapter } from "../app/adapter.js";
import type { Logger } from "pino";

import type { Provider, ProviderBootApp, ProviderCompositionApp } from "../app/index.js";
import { defineCliController } from "../cli/index.js";
import { dep, type AdapterRegistration } from "../di/index.js";
import type { WorkerAdapterDefinition } from "./adapter_definition.js";
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
  /** Result owners keyed by their adapter-neutral correlation namespace. */
  readonly completionSinks?: Readonly<
    Record<string, WorkerCorrelatedCompletionSink>
  >;
}

/** Adds the shared queue API and the selected storage adapter. */
export class WorkerProvider<Config> implements Provider<Config> {
  /** Keeps backend selection explicit and separate from provider tuning. */
  public constructor(
    protected readonly config: WorkersConfig,
    private readonly adapter: WorkerAdapterDefinition,
    protected readonly options: WorkerProviderOptions = {},
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    registerProviderAdapter(app, "workerAdapter", this.adapter, this.config);
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

  /** Initialize the selected backend after infrastructure providers have registered. */
  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    if (app.bootPlan.runningMode === "minimal") return;
    await app.container.resolve(dep<AdapterRegistration<WorkerAdapter>>("workerAdapterRegistration")).boot();
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
