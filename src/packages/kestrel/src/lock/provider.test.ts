import { defineLockAdapter, lockConfigBase } from "./index.js";
import { memoryLocks } from "./index.js";
import { postgresLocks } from "./index.js";
import { describe, expect, it } from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
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

  it("does not resolve lock infrastructure in minimal mode", async () => {
    const app = new App({ name: "test" }).register(new LockProvider(lockConfig, memoryLocks()));

    app.prepareBootPlan([], "minimal");

    await expect(app.start()).resolves.toBeUndefined();
    expect(app.container.hasRegistration("lockResource")).toBe(true);
    await app.dispose();
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
