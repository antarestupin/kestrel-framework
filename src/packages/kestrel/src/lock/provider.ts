import type { Provider, ProviderBootApp, ProviderCompositionApp } from "../app/index.js";
import { dep } from "../di/index.js";
import { applicationLoggerDependency, loggerDependency } from "../log/index.js";
import { observerContextDependency } from "../observability/index.js";
import { defineScheduledTask, every } from "../scheduled_tasks/index.js";
import { registerProviderAdapter } from "../app/adapter.js";
import type { LockAdapterDefinition } from "./adapter_definition.js";
import type { LockAdapter } from "./types.js";
import type { AdapterRegistration } from "../di/index.js";
import type { LockConfig } from "./configuration.js";
import { LockManager } from "./lock_manager.js";
import { recordLockInstrumentation } from "./observations.js";
import type { Locks, PrunableLockAdapter } from "./types.js";

export interface LockResource {
  readonly locks: Locks;
  prune?(): Promise<number>;
}

/** Declares distributed lock infrastructure owned by the lock library. */
export class LockProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly config: LockConfig,
    private readonly adapter: LockAdapterDefinition,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    const adapter = registerProviderAdapter(app, "lockAdapter", this.adapter, this.config, {
      validate: (value) => {
        if (
          this.adapter.capabilities.prune !==
          ("prune" in value && typeof value.prune === "function")
        ) {
          throw new TypeError("Lock adapter pruning capability does not match its implementation.");
        }
      },
    });
    app.container.registerFactory("lockResource", () => this.createResource(app, adapter.get()), {
      lifetime: "singleton",
    });
    app.container.registerFactory<Locks, { lockResource: LockResource }>(
      "locks",
      ({ lockResource }) => lockResource.locks,
      { lifetime: "singleton" },
    );

    if (this.config.pruneIntervalSeconds > 0 && this.adapter.capabilities.prune) {
      app.catalog.contribute(
        {
          lock: { scheduledTasks: { prune: this.createPruneTask() } },
        },
        { kind: "provider", provider: this.constructor.name },
      );
    }
  }

  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    if (app.bootPlan.runningMode !== "minimal") {
      await app.container
        .resolve(dep<AdapterRegistration<LockAdapter>>("lockAdapterRegistration"))
        .boot();
      app.container.resolve(dep<LockResource>("lockResource"));
    }
  }

  /** Creates the lock facade and its one-shot maintenance operation. */
  protected createResource(
    app: ProviderCompositionApp<Config>,
    adapter: LockAdapter,
  ): LockResource {
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
      ...(this.adapter.capabilities.prune
        ? {
            prune: () =>
              (adapter as PrunableLockAdapter).prune({ limit: this.config.pruneBatchSize }),
          }
        : {}),
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
        const removed = await lockResource.prune!();

        if (removed > 0) {
          logger.debug({ removed }, "Pruned expired lock leases");
        }
      },
    });
  }
}
