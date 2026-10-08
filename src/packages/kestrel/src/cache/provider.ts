import { registerProviderAdapter } from "../app/adapter.js";
import type { Logger } from "pino";

import type {
  Provider,
  ProviderBootApp,
  ProviderCompositionApp,
} from "../app/index.js";
import { dep, type AdapterRegistration } from "../di/index.js";
import {
  applicationLoggerDependency,
  loggerDependency,
} from "../log/index.js";
import { locksDependency, type Locks } from "../lock/index.js";
import { observerContextDependency } from "../observability/index.js";
import { defineScheduledTask, every } from "../scheduled_tasks/index.js";
import type { CacheAdapterDefinition } from "./adapter_definition.js";
import { CachePool, TagAwareCachePool, isTagAwareAdapter, isTagAwareCache } from "./cache_pool.js";
import type { CacheConfig } from "./configuration.js";
import { recordCacheInstrumentation } from "./observations.js";
import type {
  Cache,
  CacheAdapter,
  CachePoolOptions,
  TagAwareCache,
  PrunableCacheAdapter,
} from "./types.js";

export interface CacheResource {
  readonly cache: Cache;
  prune?(): Promise<number>;
}

/** Declares the shared cache infrastructure owned by the cache library. */
export class CacheProvider<Config> implements Provider<Config> {
  /** Keeps backend selection explicit and separate from provider tuning. */
  public constructor(
    protected readonly config: CacheConfig,
    private readonly adapter: CacheAdapterDefinition,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    const adapter = registerProviderAdapter(app, "cacheAdapter", this.adapter, this.config, {
      validate: (value) => {
        const { prune, tags } = this.adapter.capabilities;
        if (prune !== isPrunableAdapter(value) || tags !== isTagAwareAdapter(value)) {
          throw new TypeError("Cache adapter capabilities do not match its implementation.");
        }
      },
    });
    app.container.registerFactory(
      "cacheResource",
      () => this.createResource(
        app,
        adapter.get(),
        app.container.hasRegistration("locks")
          ? app.container.resolve(locksDependency)
          : undefined,
        app.container.resolve(applicationLoggerDependency),
      ),
      { lifetime: "singleton" },
    );
    app.container.registerFactory<Cache, { cacheResource: CacheResource }>(
      "cache",
      ({ cacheResource }) => cacheResource.cache,
      { lifetime: "singleton" },
    );

    app.container.registerFactory<TagAwareCache, { cacheResource: CacheResource }>(
      "tagAwareCache",
      ({ cacheResource }) => {
        if (!isTagAwareCache(cacheResource.cache)) {
          throw new TypeError("The configured cache adapter does not support tag invalidation.");
        }
        return cacheResource.cache;
      },
      { lifetime: "singleton" },
    );

    // Capability metadata contributes maintenance without constructing the backend.
    if (this.config.pruneIntervalSeconds > 0
      && this.adapter.capabilities.prune) {
      app.catalog.contribute({
        cache: { scheduledTasks: { prune: this.createPruneTask() } },
      }, { kind: "provider", provider: this.constructor.name });
    }
  }

  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    if (app.bootPlan.runningMode !== "minimal") {
      await app.container.resolve(dep<AdapterRegistration<CacheAdapter>>("cacheAdapterRegistration")).boot();
      app.container.resolve(dep<CacheResource>("cacheResource"));
    }
  }

  /** Creates the cache facade and its one-shot maintenance operation. */
  protected createResource(
    app: ProviderCompositionApp<Config>,
    adapter: CacheAdapter,
    locks: Locks | undefined,
    logger: Logger,
  ): CacheResource {
    const observerContext = app.container.hasRegistration("observerContext")
      ? app.container.resolve(observerContextDependency)
      : undefined;
    const options: CachePoolOptions = {
      namespace: this.config.namespace,
      lockKeyPrefix: this.config.lockKeyPrefix,
      defaultTtlSeconds: this.config.defaultTtlSeconds,
      maxTtlSeconds: this.config.maxTtlSeconds,
      maxEntrySizeBytes: this.config.maxEntrySizeBytes,
      ...(observerContext === undefined
        ? {}
        : {
            instrumentation: {
              record: (event) => {
                const observer = observerContext.get();

                if (observer !== undefined) {
                  recordCacheInstrumentation(observer, event);
                }
              },
            },
          }),
      reportStorageError: ({ error, key, operation }) => {
        logger.warn({
          err: error,
          cacheKey: key,
          cacheOperation: operation,
        }, "Cache storage operation failed");
      },
    };
    const cache = isTagAwareAdapter(adapter)
      ? new TagAwareCachePool(adapter, options, locks)
      : new CachePool(adapter, options, locks);

    return {
      cache,
      ...(isPrunableAdapter(adapter)
        ? { prune: () => adapter.prune({ limit: this.config.pruneBatchSize }) }
        : {}),
    };
  }

  /** Defines cache maintenance next to the resource that owns it. */
  protected createPruneTask() {
    return defineScheduledTask({
      id: "maintenance.cache-prune",
      description: "Remove expired and excess cache entries.",
      groups: ["maintenance"],
      schedule: every({ seconds: this.config.pruneIntervalSeconds }),
      overlap: "skip",
      executionLog: false,
      observe: false,
      runtime: { state: "persistent", coordination: "distributed" },
      dependencies: {
        cacheResource: dep<CacheResource>("cacheResource"),
        logger: loggerDependency,
      },
      handler: async ({ cacheResource, logger }) => {
        if (cacheResource.prune === undefined) {
          throw new TypeError("The configured cache adapter does not support pruning.");
        }
        const removed = await cacheResource.prune();

        if (removed > 0) {
          logger.debug({ removed }, "Pruned cache entries");
        }
      },
    });
  }
}

/** Optional maintenance must never be manufactured for native TTL backends. */
function isPrunableAdapter(adapter: CacheAdapter): adapter is PrunableCacheAdapter {
  return "prune" in adapter && typeof adapter.prune === "function";
}
