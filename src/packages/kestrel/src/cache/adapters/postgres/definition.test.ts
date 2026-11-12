import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect, it, vi } from "vitest";

import { createDependencyContainer, dep, registerAdapter } from "../../../di/index.js";
import { cacheConfigBase } from "../../configuration.js";
import { PostgresCacheAdapter, type PostgresCacheDatabase } from "./adapter.js";
import { postgresCache } from "./definition.js";

it("borrows the configured connection and passes both storage and pruning limits to it", async () => {
  const execute = vi.fn(async (_statement: SQL) => ({ rows: [] }));
  const insert = vi.fn(() => ({
    values: () => ({ onConflictDoUpdate: async () => undefined }),
  }));
  const connection = dep<PostgresCacheDatabase>("cacheDatabase");
  const definition = postgresCache(connection, { maxEntries: 7 });
  expect(definition.capabilities).toEqual({ prune: true, tags: true });
  const container = createDependencyContainer({});
  try {
    container.registerValue(connection.id, { execute, insert } as unknown as PostgresCacheDatabase);
    const registration = registerAdapter(container, "cacheAdapter", definition, cacheConfigBase.schema.parse({
      namespace: "test", maxEntrySizeBytes: 10, pruneBatchSize: 3,
    }));
    const adapter = registration.get();
    expect(adapter).toBeInstanceOf(PostgresCacheAdapter);
    const value = {
      value: "value", tags: [], sizeBytes: 11,
      createdAt: new Date(0), expiresAt: new Date(1_000),
    };
    await adapter.set("key", value);
    expect(insert).not.toHaveBeenCalled();
    await adapter.set("key", { ...value, sizeBytes: 10 });
    expect(insert).toHaveBeenCalledOnce();

    await expect((adapter as PostgresCacheAdapter).prune({})).resolves.toBe(0);
    // Inspect parameters at the borrowed connection rather than reaching into the adapter state.
    const statements = execute.mock.calls.map(([statement]) => new PgDialect().sqlToQuery(statement));
    expect(statements).toHaveLength(2);
    expect(statements[0]?.params.at(-1)).toBe(3);
    expect(statements[1]?.params).toEqual([3, 7]);
  } finally {
    await container.dispose();
  }
});
