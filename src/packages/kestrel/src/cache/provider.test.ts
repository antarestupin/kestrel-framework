import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { createUuid } from "../utils/uuid.js";
import { defineAction } from "../actions/index.js";
import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { LockProvider } from "../lock/index.js";
import { LoggerProvider } from "../log/index.js";
import {
  AsyncLocalObserverContext,
  ScopedObserver,
  type ObservationEvent,
  type ObservationRecorder,
} from "../observability/index.js";
import { MemoryCacheAdapter, RedisCacheAdapter, type PostgresCacheDatabase } from "./adapters/index.js";
import type { CacheConfig } from "./configuration.js";
import { cacheDependency, tagAwareCacheDependency } from "./dependencies.js";
import { CacheProvider, type CacheResource } from "./provider.js";
import { MemoryLockAdapter, type PostgresLockDatabase } from "../lock/adapters/index.js";
import type { LockConfig } from "../lock/configuration.js";

const cacheConfig: CacheConfig = {
  namespace: "test",
  lockKeyPrefix: "cache-fill",
  defaultTtlSeconds: 60,
  maxTtlSeconds: 3_600,
  maxEntrySizeBytes: 1_024,
  maxEntries: 100,
  pruneBatchSize: 10,
  pruneIntervalSeconds: 0,
};

const lockConfig: LockConfig = {
  namespace: "test",
  defaultTtlMs: 30_000,
  maxTtlMs: 300_000,
  defaultWaitTimeoutMs: 5_000,
  retryIntervalMs: 10,
  retryJitterRatio: 0,
  pruneBatchSize: 10,
  pruneIntervalSeconds: 0,
};

class MemoryCacheProvider<Config> extends CacheProvider<Config> {
  protected override createAdapter(_database: PostgresCacheDatabase) {
    return new MemoryCacheAdapter({
      maxEntries: this.config.maxEntries,
      maxSizeBytes: 10_000,
      maxEntrySizeBytes: this.config.maxEntrySizeBytes,
    });
  }
}

class MemoryLockProvider<Config> extends LockProvider<Config> {
  protected override createAdapter(_database: PostgresLockDatabase) {
    return new MemoryLockAdapter();
  }
}

describe("CacheProvider", () => {
  it("composes Redis without database, locks or a pruning task", async () => {
    const client = { sendCommand: vi.fn(async (_arguments: string[]) => "OK"), close: vi.fn() };
    const adapter = new RedisCacheAdapter(client, { maxEntrySizeBytes: 1_024 });
    const app = new App({ name: "test" }).register(new LoggerProvider({
      level: "silent", developmentStorage: false,
      executionLog: { enabled: true, contextMode: "completion" },
    })).register(new CacheProvider({ ...cacheConfig, pruneIntervalSeconds: 60 }, adapter));

    try {
      // Even a positive maintenance interval must not manufacture Redis pruning.
      expect(app.catalog.scheduledTasks.registrations).toEqual([]);
      expect(client.sendCommand).not.toHaveBeenCalled();
      const cache = app.container.resolve(cacheDependency);
      const resource = app.container.resolve(dep<CacheResource>("cacheResource"));
      expect(resource.prune).toBeUndefined();
      expect("invalidateAllTags" in cache).toBe(false);
      expect(() => app.container.resolve(tagAwareCacheDependency))
        .toThrow("does not support tag invalidation");
      await cache.set("key", "value");
      expect(client.sendCommand).toHaveBeenCalledOnce();
    } finally {
      await app.dispose();
    }
    expect(client.close).not.toHaveBeenCalled();
  });

  it("resolves the stronger capability to the same singleton for tag-aware adapters", async () => {
    const app = createTestApp();
    try {
      const cache = app.container.resolve(tagAwareCacheDependency);
      expect(cache).toBe(app.container.resolve(cacheDependency));
      await cache.set("key", "value", { tags: ["group"] });
      await expect(cache.invalidateAllTags(["group"])).resolves.toBe(1);
    } finally {
      await app.dispose();
    }
  });

  it("retains maintenance for an injected prunable adapter", async () => {
    const adapter = new MemoryCacheAdapter({
      maxEntries: 100, maxSizeBytes: 10_000, maxEntrySizeBytes: 1_024,
    });
    const app = new App({ name: "test" }).register(new CacheProvider({
      ...cacheConfig, pruneIntervalSeconds: 60,
    }, adapter));
    try {
      expect(app.catalog.scheduledTasks.registrations).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  });

  it("registers one lazy cache resource from dedicated configuration", async () => {
    const app = createTestApp();
    const cache = app.container.resolve(cacheDependency);
    const resource = app.container.resolve(dep<CacheResource>("cacheResource"));

    expect(app.container.resolve(cacheDependency)).toBe(cache);
    expect(resource.cache).toBe(cache);
    expect(resource.prune).toEqual(expect.any(Function));

    await app.dispose();
  });

  it("contributes maintenance from its injected configuration", async () => {
    const app = new App({ name: "test" }).register(new CacheProvider({
      ...cacheConfig,
      pruneIntervalSeconds: 60,
    }));

    expect(app.catalog.scheduledTasks.registrations).toMatchObject([{
      task: {
        id: "maintenance.cache-prune",
        groups: ["maintenance"],
        executionLog: false,
        observe: false,
      },
      source: { kind: "provider", provider: "CacheProvider" },
    }]);

    await app.dispose();
  });

  it("does not resolve cache infrastructure in minimal mode", async () => {
    const app = new App({ name: "test" }).register(
      new MemoryCacheProvider(cacheConfig),
    );

    app.prepareBootPlan([], "minimal");

    await expect(app.start()).resolves.toBeUndefined();
    expect(app.container.hasRegistration("cacheResource")).toBe(true);
    await app.dispose();
  });

  it("bridges cache and lock instrumentation to the active observer", async () => {
    const events: ObservationEvent[] = [];
    const recorder: ObservationRecorder = {
      enqueue: (event) => events.push(event),
      flush: async () => {},
      close: async () => {},
      getHealth: () => ({
        status: "healthy",
        pendingCount: 0,
        droppedCount: 0,
        droppedByOverflow: 0,
        droppedByStorageFailure: 0,
        consecutiveStorageFailures: 0,
      }),
    };
    const app = new App({ name: "test" })
      .register(new LoggerProvider({
        level: "silent",
        developmentStorage: false,
        executionLog: { enabled: true, contextMode: "completion" },
      }));

    app.container.registerValue("database", {} as PostgresCacheDatabase);
    app.container.registerValue("observerContext", new AsyncLocalObserverContext());
    app.container.registerValue("observationRecorder", recorder);
    app.container.registerFactory(
      "observer",
      ({ executionId, observationRecorder }: {
        executionId: string;
        observationRecorder: ObservationRecorder;
      }) => new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );
    app.register(new MemoryLockProvider(lockConfig));
    app.register(new MemoryCacheProvider(cacheConfig));

    const action = defineAction({
      name: "cache-provider.read",
      output: z.string(),
      dependencies: { cache: cacheDependency },
      handler: (_input, { cache }) => cache.remember(
        createUuid(),
        async () => "loaded",
        { lock: true },
      ),
    });

    await expect(app.get(action).run(null)).resolves.toBe("loaded");
    expect(events.map((event) => event.name)).toEqual([
      "execution.started",
      "cache.access",
      "lock.acquisition",
      "cache.access",
      "cache.load",
      "cache.write",
      "lock.release",
      "execution.completed",
    ]);

    await app.dispose();
  });
});

function createTestApp(): App<{ name: string }> {
  const app = new App({ name: "test" })
    .register(new LoggerProvider({
      level: "silent",
      developmentStorage: false,
      executionLog: { enabled: true, contextMode: "completion" },
    }));

  app.container.registerValue("database", {} as PostgresCacheDatabase);
  return app
    .register(new MemoryLockProvider(lockConfig))
    .register(new MemoryCacheProvider(cacheConfig));
}
