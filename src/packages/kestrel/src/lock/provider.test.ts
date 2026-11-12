import { getTableConfig } from "drizzle-orm/pg-core";
import { defineLockAdapter, lockConfigBase } from "./index.js";
import { memoryLocks } from "./index.js";
import { postgresLocks } from "./index.js";
import { describe, expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import { getFrameworkDatabaseTableKeys } from "../db/framework_table.js";
import { getDatabaseSchemaContributions } from "../db/schema_contributions/index.js";
import { dep } from "../di/index.js";
import { loggerDependency } from "../log/index.js";
import { AsyncLocalObserverContext, type Observer } from "../observability/index.js";
import { MemoryLockAdapter, type PostgresLockDatabase } from "./adapters/index.js";
import type { LockConfig } from "./configuration.js";
import { locksDependency } from "./dependencies.js";
import { LockProvider, type LockResource } from "./provider.js";
import { lockLeases } from "./postgres_schema.js";

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
          description: "Remove expired distributed lock leases.",
          groups: ["maintenance"],
          schedule: { kind: "every", intervalMs: 60_000 },
          overlap: "skip",
          executionLog: false,
          observe: false,
          runtime: { state: "persistent", coordination: "distributed" },
          dependencies: { lockResource: dep("lockResource"), logger: loggerDependency },
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

  it("rejects an adapter that declares pruning but provides a non-callable property", async () => {
    const storage = {
      tryAcquire: async () => undefined, extend: async () => undefined,
      release: async () => false, prune: undefined,
    };
    const app = new App({}).register(new LockProvider(lockConfig, defineLockAdapter({
      dependencies: {}, capabilities: { prune: true }, create: () => storage,
    })));
    try {
      await expect(app.start()).rejects.toThrow("Lock adapter pruning capability does not match its implementation");
    } finally {
      await app.dispose();
    }
  });

  it("warms the standard facade using the configured borrowed PostgreSQL database", async () => {
    const app = new App({});
    const context = vi.fn(() => new AsyncLocalObserverContext());
    const failure = new Error("Database unavailable");
    const insert = vi.fn(() => { throw failure; });
    const descriptor = dep<PostgresLockDatabase>("dedicatedLocksDatabase");
    app.container.registerValue(descriptor.id, { insert } as unknown as PostgresLockDatabase);
    app.container.registerFactory("observerContext", context, { lifetime: "singleton" });
    app.register(new LockProvider(lockConfig, postgresLocks(descriptor)));

    try {
      expect(context).not.toHaveBeenCalled();
      await app.start();
      expect(context).toHaveBeenCalledOnce();
      // The runtime uses the injected database and the same table exported for migrations.
      await expect(app.container.resolve(locksDependency).tryAcquire("job")).rejects.toBe(failure);
      expect(insert).toHaveBeenCalledExactlyOnceWith(lockLeases);
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

it("coerces configured timing and maintenance bounds without losing fractional TTLs", () => {
  const schema = lockConfigBase.schema;
  expect(schema.parse({ namespace: "test" })).toEqual({
    namespace: "test", defaultTtlMs: 30_000, maxTtlMs: 300_000,
    defaultWaitTimeoutMs: 5_000, retryIntervalMs: 50, retryJitterRatio: 0.2,
    pruneBatchSize: 1_000, pruneIntervalSeconds: 60,
  });
  expect(schema.parse({
    namespace: "test", defaultTtlMs: "10.5", maxTtlMs: "25",
    defaultWaitTimeoutMs: "0", retryIntervalMs: "1.5", retryJitterRatio: "1",
    pruneBatchSize: "3", pruneIntervalSeconds: "0",
  })).toEqual({
    namespace: "test", defaultTtlMs: 10.5, maxTtlMs: 25, defaultWaitTimeoutMs: 0,
    retryIntervalMs: 1.5, retryJitterRatio: 1, pruneBatchSize: 3, pruneIntervalSeconds: 0,
  });
  for (const invalid of [
    { namespace: "" }, { defaultTtlMs: false }, { maxTtlMs: Infinity },
    { defaultWaitTimeoutMs: -1 }, { retryIntervalMs: 0 }, { retryJitterRatio: -0.1 },
    { retryJitterRatio: 1.1 }, { pruneBatchSize: 0 }, { pruneIntervalSeconds: 0.5 },
  ]) {
    expect(schema.safeParse({ namespace: "test", ...invalid }).success).toBe(false);
  }
});

it("exports the physical PostgreSQL lease schema and its migration metadata", () => {
  const table = getTableConfig(lockLeases);
  expect(table).toMatchObject({ schema: "utils", name: "lock_lease" });
  expect(table.columns.map((column) => ({
    name: column.name, sqlType: column.getSQLType(), dataType: column.dataType,
    primary: column.primary, notNull: column.notNull, hasDefault: column.hasDefault,
  }))).toEqual([
    { name: "key", sqlType: "text", dataType: "string", primary: true, notNull: true, hasDefault: false },
    { name: "owner_id", sqlType: "text", dataType: "string", primary: false, notNull: true, hasDefault: false },
    { name: "fencing_token", sqlType: "bigserial", dataType: "bigint", primary: false, notNull: true, hasDefault: true },
    { name: "expires_at", sqlType: "timestamp with time zone", dataType: "date", primary: false, notNull: true, hasDefault: false },
  ]);
  expect(table.indexes.map(({ config }) => ({
    name: config.name, columns: config.columns.map((column) => "name" in column ? column.name : undefined),
  }))).toEqual([{ name: "lock_lease_expires_at_idx", columns: ["expires_at"] }]);
  expect(getFrameworkDatabaseTableKeys({ lockLeases })).toEqual(new Set([JSON.stringify(["utils", "lock_lease"])]));
  const [descriptions] = getDatabaseSchemaContributions({ lockLeases });
  expect(descriptions?.id).toBe("postgres.table:utils.lock_lease:descriptions");
  for (const column of ["key", "owner_id", "fencing_token", "expires_at"]) {
    expect(descriptions?.installSql).toContain(`COMMENT ON COLUMN "utils"."lock_lease"."${column}" IS `);
  }
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
