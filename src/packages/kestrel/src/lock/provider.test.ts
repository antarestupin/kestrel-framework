import { defineLockAdapter, lockConfigBase } from "./index.js";
import { memoryLocks } from "./index.js";
import { postgresLocks } from "./index.js";
import { describe, expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { AsyncLocalObserverContext, type Observer } from "../observability/index.js";
import { MemoryLockAdapter, type PostgresLockDatabase } from "./adapters/index.js";
import type { LockConfig } from "./configuration.js";
import { locksDependency } from "./dependencies.js";
import { LockProvider, type LockResource } from "./provider.js";

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

describe("LockProvider", () => {
  it("registers one lazy lock resource from dedicated configuration", async () => {
    const app = createTestApp();
    const locks = app.container.resolve(locksDependency);
    const resource = app.container.resolve(dep<LockResource>("lockResource"));

    expect(app.container.resolve(locksDependency)).toBe(locks);
    expect(resource.locks).toBe(locks);
    expect(resource.prune).toEqual(expect.any(Function));

    await app.dispose();
  });

  it("contributes maintenance from its injected configuration", async () => {
    const app = new App({ name: "test" }).register(
      new LockProvider(
        {
          ...lockConfig,
          pruneIntervalSeconds: 60,
        },
        postgresLocks(dep("database")),
      ),
    );

    expect(app.catalog.scheduledTasks.registrations).toMatchObject([
      {
        task: {
          id: "maintenance.lock-prune",
          groups: ["maintenance"],
          executionLog: false,
          observe: false,
        },
        source: { kind: "provider", provider: "LockProvider" },
      },
    ]);

    await app.dispose();
  });

  it("runs configured pruning batches and records actual removals", async () => {
    let nowMs = 0;
    const storage = new MemoryLockAdapter({ now: () => new Date(nowMs) });
    const prune = vi.spyOn(storage, "prune");
    const debug = vi.fn();
    const app = new App({}).register(new LockProvider({
      ...lockConfig, pruneBatchSize: 1, pruneIntervalSeconds: 60,
    }, defineLockAdapter({ dependencies: {}, capabilities: { prune: true }, create: () => storage })));

    try {
      await storage.tryAcquire({ key: "expired", ownerId: "old", ttlMs: 10 });
      nowMs = 10;
      const task = app.catalog.scheduledTasks.registrations[0]!.task;
      const lockResource = app.container.resolve(dep<LockResource>("lockResource"));
      const execution = {
        signal: new AbortController().signal, scheduledAt: new Date(nowMs),
        trigger: "scheduled" as const, deferNextRun: () => undefined,
      };

      await task.handler({ lockResource, logger: { debug } }, execution);
      await task.handler({ lockResource, logger: { debug } }, execution);
      expect(prune.mock.calls).toEqual([[{ limit: 1 }], [{ limit: 1 }]]);
      expect(debug).toHaveBeenCalledExactlyOnceWith({ removed: 1 }, "Pruned expired lock leases");
    } finally {
      await app.dispose();
    }
  });

  it("does not resolve lock infrastructure in minimal mode", async () => {
    const app = new App({ name: "test" }).register(new LockProvider(lockConfig, memoryLocks()));

    app.prepareBootPlan([], "minimal");

    await expect(app.start()).resolves.toBeUndefined();
    expect(app.container.hasRegistration("lockResource")).toBe(true);
    await app.dispose();
  });

  it("rejects an adapter whose pruning capability does not match its implementation", async () => {
    const app = new App({}).register(new LockProvider(lockConfig, defineLockAdapter({
      dependencies: {},
      capabilities: { prune: false },
      create: () => new MemoryLockAdapter(),
    })));

    try {
      await expect(app.start()).rejects.toThrow("Lock adapter pruning capability does not match its implementation");
    } finally {
      await app.dispose();
    }
  });

  it("forwards batch ownership and renewal only to the observer for the active execution", async () => {
    const context = new AsyncLocalObserverContext();
    const record = vi.fn<Observer["record"]>();
    const app = new App({});
    app.container.registerValue("observerContext", context);
    app.register(new LockProvider(lockConfig, memoryLocks()));

    try {
      const locks = app.container.resolve(locksDependency);
      await locks.runExclusive("outside-observation", () => undefined);
      expect(record).not.toHaveBeenCalled();

      await context.run({ record }, () => locks.runExclusiveMany(["second", "first"], async ([second]) => {
        await second!.extend();
      }));
      expect(record).toHaveBeenNthCalledWith(1,
        expect.objectContaining({ name: "lock.batch-acquisition" }),
        expect.objectContaining({ keys: ["second", "first"], fencingTokens: ["3", "2"] }),
        expect.objectContaining({ outcome: "success" }),
      );
      expect(record).toHaveBeenNthCalledWith(2,
        expect.objectContaining({ name: "lock.extension" }),
        expect.objectContaining({ key: "second", fencingToken: "3", result: "extended" }),
        expect.objectContaining({ outcome: "success" }),
      );
      expect(record.mock.calls.slice(2).map(([, data]) => data)).toMatchObject([
        { key: "second", result: "released" }, { key: "first", result: "released" },
      ]);
      record.mockClear();
      await context.run({ record }, () => locks.runExclusive("single-observed", () => undefined));
      expect(record).toHaveBeenNthCalledWith(1,
        expect.objectContaining({ name: "lock.acquisition" }),
        expect.objectContaining({ key: "single-observed", result: "acquired" }),
        expect.objectContaining({ outcome: "success" }),
      );
    } finally {
      await app.dispose();
    }
  });
});

function createTestApp(): App<{ name: string }> {
  const app = new App({ name: "test" });

  app.container.registerValue("database", {} as PostgresLockDatabase);
  return app.register(new LockProvider(lockConfig, memoryLocks()));
}

it("accepts an external backend without pruning or a database dependency", async () => {
  const app = new App({}).register(
    new LockProvider(
      lockConfigBase.schema.parse({ namespace: "test", pruneIntervalSeconds: 60 }),
      defineLockAdapter({
        dependencies: {},
        capabilities: { prune: false },
        create: () => {
          const memory = new MemoryLockAdapter();
          return {
            tryAcquire: memory.tryAcquire.bind(memory),
            extend: memory.extend.bind(memory),
            release: memory.release.bind(memory),
          };
        },
      }),
    ),
  );
  try {
    expect(app.catalog.scheduledTasks.registrations).toHaveLength(0);
    await app.start();
    expect(app.container.resolve(dep<LockResource>("lockResource")).prune).toBeUndefined();
  } finally {
    await app.dispose();
  }
});
