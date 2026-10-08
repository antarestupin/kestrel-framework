import { registerProviderAdapter } from "../app/adapter.js";
import type {
  Provider,
  ProviderBootApp,
  ProviderCompositionApp,
} from "../app/index.js";
import { dep, type AdapterRegistration } from "../di/index.js";
import { loggerDependency } from "../log/index.js";
import { observerContextDependency } from "../observability/index.js";
import { defineScheduledTask, every } from "../scheduled_tasks/index.js";
import type { ThrottlingAdapterDefinition } from "./adapter_definition.js";
import type { ThrottlingConfig } from "./configuration.js";
import { ThrottlingManager } from "./manager.js";
import {
  recordThrottlingInstrumentation,
  type ThrottlingInstrumentation,
} from "./observations.js";
import type {
  PrunableRateLimitAdapter,
  RateLimitAdapter,
  Throttling,
} from "./types.js";
import {
  LocalResourcePressureMonitor,
  type LocalResourcePressureSource,
  NodeLocalResourcePressureSource,
} from "./resource_pressure/index.js";

export interface ThrottlingResource {
  readonly throttling: Throttling;
  prune?(): Promise<number>;
}

export interface ThrottlingProviderOptions {
  /** Additional process-local signal readers, checked before Node defaults. */
  readonly resourcePressureSources?: readonly LocalResourcePressureSource[];
}

/** Adds admission control with explicitly selected backend capabilities. */
export class ThrottlingProvider<Config> implements Provider<Config> {
  /** Keeps backend selection explicit and separate from provider tuning. */
  public constructor(
    protected readonly config: ThrottlingConfig,
    private readonly adapter: ThrottlingAdapterDefinition,
    protected readonly options: ThrottlingProviderOptions = {},
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    const instrumentation = this.createInstrumentation(app);
    let resource: ThrottlingResource | undefined;
    const adapter = registerProviderAdapter(app, "throttlingAdapter", this.adapter, {
      config: this.config,
      instrumentation,
    }, {
      validate: (value) => {
        if (this.adapter.capabilities.prune !== isPrunableAdapter(value)) {
          throw new TypeError("Throttling adapter pruning capability does not match its implementation.");
        }
      },
      // Drain permits before disposing the backend that they still depend on.
      beforeDispose: () => resource?.throttling.close(),
    });
    app.container.registerFactory("throttlingResource", () => {
      resource = this.createResource(app, adapter.get(), instrumentation);
      return resource;
    }, { lifetime: "singleton" });
    app.container.registerFactory<
      Throttling,
      { throttlingResource: ThrottlingResource }
    >(
      "throttling",
      ({ throttlingResource }) => throttlingResource.throttling,
      { lifetime: "singleton" },
    );

    if (this.config.pruneIntervalSeconds > 0 && this.adapter.capabilities.prune) {
      app.catalog.contribute({
        throttling: { scheduledTasks: { prune: this.createPruneTask() } },
      }, { kind: "provider", provider: this.constructor.name });
    }
  }

  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    if (app.bootPlan.runningMode !== "minimal") {
      await app.container.resolve(dep<AdapterRegistration<RateLimitAdapter>>("throttlingAdapterRegistration")).boot();
      app.container.resolve(dep<ThrottlingResource>("throttlingResource"));
    }
  }

  /** Resolves ambient observations only when the adapter is first requested. */
  protected createInstrumentation(app: ProviderCompositionApp<Config>): ThrottlingInstrumentation {
    return { record: (event) => {
      const observerContext = app.container.hasRegistration("observerContext")
        ? app.container.resolve(observerContextDependency) : undefined;
      const observer = observerContext?.get();
      if (observer !== undefined) recordThrottlingInstrumentation(observer, event);
    } };
  }

  /** Creates the facade without transferring backend ownership to the manager. */
  protected createResource(
    _app: ProviderCompositionApp<Config>,
    adapter: RateLimitAdapter,
    instrumentation: ThrottlingInstrumentation,
  ): ThrottlingResource {
    const resourcePressureMonitor = this.createResourcePressureMonitor();
    const throttling = new ThrottlingManager(adapter, {
      namespace: this.config.namespace,
      maxPendingAcquisitions: this.config.maxPendingAcquisitions,
      resourcePressureMonitor,
      instrumentation,
      closeAdapter: false,
    });

    return {
      throttling,
      ...(isPrunableAdapter(adapter)
        ? { prune: () => adapter.prune({ limit: this.config.pruneBatchSize }) } : {}),
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
        if (throttlingResource.prune === undefined) throw new TypeError("The throttling adapter does not support pruning.");
        const removed = await throttlingResource.prune();

        if (removed > 0) {
          logger.debug({ removed }, "Pruned fully refilled throttling buckets");
        }
      },
    });
  }
}

/** Storage-native expiration does not require a framework pruning task. */
function isPrunableAdapter(adapter: RateLimitAdapter): adapter is PrunableRateLimitAdapter {
  return "prune" in adapter && typeof adapter.prune === "function";
}
