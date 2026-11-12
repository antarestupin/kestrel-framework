import { pinoLogger } from "./../log/index.js";
import { memoryLocks } from "./../lock/index.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { uuidV7 } from "../utils/uuid.js";
import { defineAction } from "../actions/index.js";
import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { LockProvider } from "../lock/index.js";
import { applicationLoggerDependency, LoggerProvider } from "../log/index.js";
import {
  AsyncLocalObserverContext,
  ScopedObserver,
  type ObservationEvent,
  type ObservationRecorder,
} from "../observability/index.js";
import {
  memoryCache,
  redisCache,
  postgresCache,
  type PostgresCacheDatabase,
} from "./adapters/index.js";
import { defineCacheAdapter } from "./adapter_definition.js";
import type { CacheConfig } from "./configuration.js";
import { cacheDependency, tagAwareCacheDependency } from "./dependencies.js";
import { CacheProvider, type CacheResource } from "./provider.js";
import type { PrunableCacheAdapter } from "./types.js";
import { MemoryLockAdapter, type PostgresLockDatabase } from "../lock/adapters/index.js";
import type { LockConfig } from "../lock/configuration.js";

const cacheConfig: CacheConfig = {
  namespace: "test",
  lockKeyPrefix: "cache-fill",
  defaultTtlSeconds: 60,
  maxTtlSeconds: 3_600,
  maxEntrySizeBytes: 1_024,
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

describe("CacheProvider", () => {
  it("composes Redis without database, locks or a pruning task", async () => {
    const client = { sendCommand: vi.fn(async (_arguments: string[]) => "OK"), close: vi.fn() };
    const connection = dep<typeof client>("redis");
    const adapter = redisCache(connection);
    const app = new App({ name: "test" })
      .register(
        new LoggerProvider(
          {
            level: "silent",
            developmentStorage: false,
            executionLog: { enabled: true, contextMode: "completion" },
          },
          pinoLogger(),
        ),
      )
      .register(new CacheProvider({ ...cacheConfig, pruneIntervalSeconds: 60 }, adapter));
    app.container.registerValue(connection.id, client);

    try {
      // Even a positive maintenance interval must not manufacture Redis pruning.
      expect(app.catalog.scheduledTasks.registrations).toEqual([]);
      expect(client.sendCommand).not.toHaveBeenCalled();
      const cache = app.container.resolve(cacheDependency);
      const resource = app.container.resolve(dep<CacheResource>("cacheResource"));
      expect(resource.prune).toBeUndefined();
      expect("invalidateAllTags" in cache).toBe(false);
      expect(() => app.container.resolve(tagAwareCacheDependency)).toThrow(
        "does not support tag invalidation",
      );
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
    const adapter = memoryCache();
    const app = new App({ name: "test" }).register(
      new CacheProvider(
        {
          ...cacheConfig,
          pruneIntervalSeconds: 60,
        },
        adapter,
      ),
    );
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
    const app = new App({ name: "test" }).register(
      new CacheProvider(
        {
          ...cacheConfig,
          pruneIntervalSeconds: 60,
        },
        postgresCache(dep<PostgresCacheDatabase>("database")),
      ),
    );

    expect(app.catalog.scheduledTasks.registrations).toMatchObject([
      {
        task: {
          id: "maintenance.cache-prune",
          groups: ["maintenance"],
          executionLog: false,
          observe: false,
        },
        source: { kind: "provider", provider: "CacheProvider" },
      },
    ]);

    await app.dispose();
  });

  it("runs the configured pruning batch and logs only actual removals", async () => {
    const prune = vi.fn<PrunableCacheAdapter["prune"]>()
      .mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const debug = vi.fn();
    const app = createTestApp(
      { ...cacheConfig, pruneBatchSize: 2, pruneIntervalSeconds: 60 },
      defineCacheAdapter({
        dependencies: {},
        capabilities: { prune: true, tags: false },
        create: () => ({
          get: async () => undefined,
          set: async () => {},
          delete: async () => false,
          prune,
        }),
      }),
    );

    try {
      const task = app.catalog.scheduledTasks.registrations[0]!.task;
      const cacheResource = app.container.resolve(dep<CacheResource>("cacheResource"));
      const execution = {
        signal: new AbortController().signal,
        scheduledAt: new Date(0),
        trigger: "scheduled" as const,
        deferNextRun: () => undefined,
      };

      await task.handler({ cacheResource, logger: { debug } }, execution);
      await task.handler({ cacheResource, logger: { debug } }, execution);
      expect(prune.mock.calls).toEqual([[{ limit: 2 }], [{ limit: 2 }]]);
      expect(debug).toHaveBeenCalledExactlyOnceWith({ removed: 2 }, "Pruned cache entries");
    } finally {
      await app.dispose();
    }
  });

  it("logs a storage error while returning a cache miss", async () => {
    const failure = new Error("cache offline");
    const app = new App({}).register(new CacheProvider(cacheConfig, defineCacheAdapter({
      dependencies: {},
      capabilities: { prune: false, tags: false },
      create: () => ({
        get: async () => { throw failure; },
        set: async () => {},
        delete: async () => false,
      }),
    })));
    const warn = vi.fn();
    app.container.registerValue(applicationLoggerDependency.id, { warn });

    try {
      const cache = app.container.resolve(cacheDependency);
      await expect(cache.get("key")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledExactlyOnceWith({
        err: failure, cacheKey: "test:key", cacheOperation: "get",
      }, "Cache storage operation failed");
    } finally {
      await app.dispose();
    }
  });

  it("does not resolve cache infrastructure in minimal mode", async () => {
    const app = new App({ name: "test" }).register(new CacheProvider(cacheConfig, memoryCache()));

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
    const app = new App({ name: "test" }).register(
      new LoggerProvider(
        {
          level: "silent",
          developmentStorage: false,
          executionLog: { enabled: true, contextMode: "completion" },
        },
        pinoLogger(),
      ),
    );

    app.container.registerValue("database", {} as PostgresCacheDatabase);
    app.container.registerValue("observerContext", new AsyncLocalObserverContext());
    app.container.registerValue("observationRecorder", recorder);
    app.container.registerFactory(
      "observer",
      ({
        executionId,
        observationRecorder,
      }: {
        executionId: string;
        observationRecorder: ObservationRecorder;
      }) => new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );
    app.register(new LockProvider(lockConfig, memoryLocks()));
    app.register(new CacheProvider(cacheConfig, memoryCache()));

    const action = defineAction({
      name: "cache-provider.read",
      output: z.string(),
      dependencies: { cache: cacheDependency },
      handler: async (_input, { cache }) => {
        const key = uuidV7();
        const value = await cache.remember(key, async () => "loaded", { lock: true });
        await cache.delete(key);
        return value;
      },
    });

    try {
      // Outside an execution, cache operations have no observer to record to.
      await expect(app.container.resolve(cacheDependency).get("missing")).resolves.toBeUndefined();
      expect(events).toHaveLength(0);
      await expect(app.get(action).run(null)).resolves.toBe("loaded");
      expect(events.map((event) => event.name)).toEqual([
        "execution.started",
        "cache.access",
        "lock.acquisition",
        "cache.access",
        "cache.load",
        "cache.write",
        "lock.release",
        "cache.invalidation",
        "execution.completed",
      ]);
    } finally {
      await app.dispose();
    }
  });
});

function createTestApp(
  config = cacheConfig,
  adapter: ConstructorParameters<typeof CacheProvider>[1] = memoryCache(),
): App<{ name: string }> {
  const app = new App({ name: "test" }).register(
    new LoggerProvider(
      {
        level: "silent",
        developmentStorage: false,
        executionLog: { enabled: true, contextMode: "completion" },
      },
      pinoLogger(),
    ),
  );

  app.container.registerValue("database", {} as PostgresCacheDatabase);
  return app
    .register(new LockProvider(lockConfig, memoryLocks()))
    .register(new CacheProvider(config, adapter));
}

it("rejects false capability declarations and releases the constructed adapter", async () => {
  const dispose = vi.fn();
  const app = new App({}).register(
    new CacheProvider(
      cacheConfig,
      defineCacheAdapter({
        dependencies: {},
        capabilities: { prune: true, tags: false },
        create: () => ({
          get: async () => undefined,
          set: async () => {},
          delete: async () => false,
        }),
        dispose,
      }),
    ),
  );
  try {
    await expect(app.start()).rejects.toThrow("capabilities");
  } finally {
    await app.dispose();
  }
  expect(dispose).toHaveBeenCalledOnce();
});
