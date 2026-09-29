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
import { PostgresLockAdapter, type PostgresLockDatabase } from "./adapters/index.js";
import type { LockConfig } from "./configuration.js";
import { LockManager } from "./lock_manager.js";
import { recordLockInstrumentation } from "./observations.js";
import type {
  Locks,
  PrunableLockAdapter,
} from "./types.js";

export interface LockResource {
  readonly locks: Locks;
  prune(): Promise<number>;
}

interface LockResourceDependencies {
  database: PostgresLockDatabase;
}

/** Declares distributed lock infrastructure owned by the lock library. */
export class LockProvider<Config> implements Provider<Config> {
  public constructor(protected readonly config: LockConfig) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "lockResource",
      ({ database }: LockResourceDependencies) =>
        this.createResource(app, database),
      { lifetime: "singleton" },
    );
    app.container.registerFactory<Locks, { lockResource: LockResource }>(
      "locks",
      ({ lockResource }) => lockResource.locks,
      { lifetime: "singleton" },
    );

    if (this.config.pruneIntervalSeconds > 0) {
      app.catalog.contribute({
        lock: { scheduledTasks: { prune: this.createPruneTask() } },
      }, { kind: "provider", provider: this.constructor.name });
    }
  }

  public boot(app: ProviderBootApp<Config>): void {
    if (app.bootPlan.runningMode !== "minimal") {
      app.container.resolve(dep<LockResource>("lockResource"));
    }
  }

  /** Creates the PostgreSQL storage adapter used by the standard provider. */
  protected createAdapter(database: PostgresLockDatabase): PrunableLockAdapter {
    return new PostgresLockAdapter(database);
  }

  /** Creates the lock facade and its one-shot maintenance operation. */
  protected createResource(
    app: ProviderCompositionApp<Config>,
    database: PostgresLockDatabase,
  ): LockResource {
    const adapter = this.createAdapter(database);
    const observerContext = app.container.hasRegistration("observerContext")
      ? app.container.resolve(observerContextDependency)
      : undefined;
    const locks = new LockManager(adapter, {
      namespace: this.config.namespace,
      defaultTtlMs: this.config.defaultTtlMs,
      maxTtlMs: this.config.maxTtlMs,
      defaultWaitTimeoutMs: this.config.defaultWaitTimeoutMs,
      retryIntervalMs: this.config.retryIntervalMs,
      retryJitterRatio: this.config.retryJitterRatio,
      ...(observerContext === undefined
        ? {}
        : {
            instrumentation: {
              record: (event) => {
                const observer = observerContext.get();

                if (observer !== undefined) {
                  recordLockInstrumentation(observer, event);
                }
              },
            },
          }),
    });

    return {
      locks,
      prune: () => adapter.prune({ limit: this.config.pruneBatchSize }),
    };
  }

  /** Defines lock maintenance next to the resource that owns it. */
  protected createPruneTask() {
    return defineScheduledTask({
      id: "maintenance.lock-prune",
      description: "Remove expired distributed lock leases.",
      groups: ["maintenance"],
      schedule: every({ seconds: this.config.pruneIntervalSeconds }),
      overlap: "skip",
      executionLog: false,
      observe: false,
      runtime: { state: "persistent", coordination: "distributed" },
      dependencies: {
        lockResource: dep<LockResource>("lockResource"),
        logger: loggerDependency,
      },
      handler: async ({ lockResource, logger }) => {
        const removed = await lockResource.prune();

        if (removed > 0) {
          logger.debug({ removed }, "Pruned expired lock leases");
        }
      },
    });
  }
}
