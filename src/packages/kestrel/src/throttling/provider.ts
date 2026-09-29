import type {
  Provider,
  ProviderBootApp,
  ProviderCompositionApp,
} from "../app/index.js";
import { dep } from "../di/index.js";
import {
  applicationLoggerDependency,
  loggerDependency,
} from "../log/index.js";
import { observerContextDependency } from "../observability/index.js";
import { defineScheduledTask, every } from "../scheduled_tasks/index.js";
import {
  BackendFailureRateLimitAdapter,
  DenialCachingRateLimitAdapter,
  LeasedRateLimitAdapter,
  PostgresRateLimitAdapter,
  type PostgresRateLimitDatabase,
} from "./adapters/index.js";
import type { ThrottlingConfig } from "./configuration.js";
import { ThrottlingManager } from "./manager.js";
import {
  recordThrottlingInstrumentation,
  type ThrottlingInstrumentation,
} from "./observations.js";
import type {
  PrunableRateLimitAdapter,
  Throttling,
} from "./types.js";
import {
  LocalResourcePressureMonitor,
  type LocalResourcePressureSource,
  NodeLocalResourcePressureSource,
} from "./resource_pressure/index.js";

export interface ThrottlingResource {
  readonly throttling: Throttling;
  prune(): Promise<number>;
}

interface ThrottlingResourceDependencies {
  database: PostgresRateLimitDatabase;
}

export interface ThrottlingProviderOptions {
  /** Additional process-local signal readers, checked before Node defaults. */
  readonly resourcePressureSources?: readonly LocalResourcePressureSource[];
}

/** Adds exact and leased PostgreSQL throttling with bounded maintenance. */
export class ThrottlingProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly config: ThrottlingConfig,
    protected readonly options: ThrottlingProviderOptions = {},
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "throttlingResource",
      ({ database }: ThrottlingResourceDependencies) =>
        this.createResource(app, database),
      {
        lifetime: "singleton",
        dispose: (resource) => resource.throttling.close(),
      },
    );
    app.container.registerFactory<
      Throttling,
      { throttlingResource: ThrottlingResource }
    >(
      "throttling",
      ({ throttlingResource }) => throttlingResource.throttling,
      { lifetime: "singleton" },
    );

    if (this.config.pruneIntervalSeconds > 0) {
      app.catalog.contribute({
        throttling: { scheduledTasks: { prune: this.createPruneTask() } },
      }, { kind: "provider", provider: this.constructor.name });
    }
  }

  public boot(app: ProviderBootApp<Config>): void {
    if (app.bootPlan.runningMode !== "minimal") {
      app.container.resolve(dep<ThrottlingResource>("throttlingResource"));
    }
  }

  /** Composes local leasing around the authoritative failure boundary. */
  protected createAdapter(
    database: PostgresRateLimitDatabase,
    instrumentation?: ThrottlingInstrumentation,
  ): PrunableRateLimitAdapter {
    const authoritative = new DenialCachingRateLimitAdapter(
      new PostgresRateLimitAdapter(database, {
        maxConcurrentReservations: this.config.maxConcurrentReservations,
        maxPendingReservations: this.config.maxPendingAcquisitions,
        storageWaitTimeoutMs: this.config.storageWaitTimeoutMs,
      }),
    );

    return new LeasedRateLimitAdapter(
      new BackendFailureRateLimitAdapter(
        authoritative,
        this.config.backendFailurePolicy,
      ),
      instrumentation === undefined ? {} : { instrumentation },
    );
  }

  /** Creates the public facade and a one-shot safe prune operation. */
  protected createResource(
    app: ProviderCompositionApp<Config>,
    database: PostgresRateLimitDatabase,
  ): ThrottlingResource {
    const observerContext = app.container.hasRegistration("observerContext")
      ? app.container.resolve(observerContextDependency)
      : undefined;
    const instrumentation: ThrottlingInstrumentation | undefined =
      observerContext === undefined
        ? undefined
        : {
            record: (event) => {
              const observer = observerContext.get();

              if (observer !== undefined) {
                recordThrottlingInstrumentation(observer, event);
              }
            },
          };
    const adapter = this.createAdapter(database, instrumentation);
    const resourcePressureMonitor = this.createResourcePressureMonitor();
    const throttling = new ThrottlingManager(adapter, {
      namespace: this.config.namespace,
      maxPendingAcquisitions: this.config.maxPendingAcquisitions,
      resourcePressureMonitor,
      ...(observerContext === undefined
        ? {}
        : {
            instrumentation: instrumentation!,
          }),
    });

    return {
      throttling,
      prune: () => adapter.prune({ limit: this.config.pruneBatchSize }),
    };
  }

  /** Creates one lazily sampled monitor shared by all local policies. */
  protected createResourcePressureMonitor(): LocalResourcePressureMonitor {
    return new LocalResourcePressureMonitor(
      [
        ...(this.options.resourcePressureSources ?? []),
        new NodeLocalResourcePressureSource(),
      ],
      this.config.resourcePressureSampling,
    );
  }

  /** Keeps pruning outside request paths and internal timers. */
  protected createPruneTask() {
    return defineScheduledTask({
      id: "maintenance.throttling-prune",
      description: "Remove fully refilled throttling buckets.",
      groups: ["maintenance"],
      schedule: every({ seconds: this.config.pruneIntervalSeconds }),
      overlap: "skip",
      executionLog: false,
      observe: false,
      runtime: { state: "persistent", coordination: "distributed" },
      dependencies: {
        logger: loggerDependency,
        throttlingResource: dep<ThrottlingResource>("throttlingResource"),
      },
      handler: async ({ logger, throttlingResource }) => {
        const removed = await throttlingResource.prune();

        if (removed > 0) {
          logger.debug({ removed }, "Pruned fully refilled throttling buckets");
        }
      },
    });
  }
}
