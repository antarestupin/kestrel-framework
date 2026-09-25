import { drizzle } from "drizzle-orm/node-postgres";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  Pool,
  PoolClient,
} from "pg";

import { createPostgresTestPool } from "../../../testing/postgres.js";
import {
  PostgresCacheAdapter,
  type PostgresCacheDatabase,
} from "./adapter.js";
import { cacheEntries } from "../../postgres_schema.js";
import type {
  CacheEntry,
} from "../../types.js";

// The production table is schema-qualified. This equivalent unqualified table
// lets the adapter tests retain connection-local temporary table isolation.
const testCacheEntries = pgTable("cache_entry", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  tags: text("tags").array().notNull(),
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  createdAt: timestamp("created_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
});

function key(
  value: string,
  namespace = "test",
): string {
  return `${namespace}:${value}`;
}

function entry(
  value: unknown,
  options: {
    createdAt?: Date;
    expiresAt?: Date;
    sizeBytes?: number;
    tags?: readonly string[];
  } = {},
): CacheEntry {
  return {
    value,
    expiresAt: options.expiresAt
      ?? new Date("2026-01-01T01:00:00.000Z"),
    tags: options.tags ?? [],
    createdAt: options.createdAt
      ?? new Date("2026-01-01T00:00:00.000Z"),
    sizeBytes: options.sizeBytes ?? 1,
  };
}

let pool: Pool;
let client: PoolClient;
let database: PostgresCacheDatabase;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();

  // A connection-scoped table exercises the production adapter without
  // depending on the application migration state.
  await client.query(`
    CREATE TEMPORARY TABLE cache_entry (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
      expires_at timestamp with time zone NOT NULL,
      created_at timestamp with time zone NOT NULL,
      size_bytes integer NOT NULL
    ) ON COMMIT PRESERVE ROWS
  `);
  database = drizzle(client) as PostgresCacheDatabase;
});

beforeEach(async () => {
  await client.query("TRUNCATE cache_entry");
});

afterAll(async () => {
  client.release();
  await pool.end();
});

function createAdapter(
  overrides: Partial<ConstructorParameters<typeof PostgresCacheAdapter>[1]> = {},
): PostgresCacheAdapter {
  return new PostgresCacheAdapter(database, {
    maxEntries: 10,
    maxEntrySizeBytes: 100,
    now: () => new Date("2026-01-01T00:30:00.000Z"),
    ...overrides,
  }, testCacheEntries as unknown as typeof cacheEntries);
}

describe("PostgresCacheAdapter", () => {
  it("stores, reads and updates a JSON value", async () => {
    const adapter = createAdapter();
    await adapter.set(key("key"), entry({ version: 1 }, {
      tags: ["first"],
    }));
    await adapter.set(key("key"), entry({ version: 2 }, {
      tags: ["second"],
      sizeBytes: 2,
    }));

    await expect(adapter.get(key("key"))).resolves.toMatchObject({
      value: { version: 2 },
      tags: ["second"],
      sizeBytes: 2,
    });
  });

  it("does not return an expired row", async () => {
    const adapter = createAdapter();
    await adapter.set(key("expired"), entry("value", {
      expiresAt: new Date("2026-01-01T00:29:59.000Z"),
    }));

    await expect(adapter.get(key("expired"))).resolves.toBeUndefined();
  });

  it("does not persist an oversized entry", async () => {
    const adapter = createAdapter({ maxEntrySizeBytes: 2 });

    await adapter.set(key("large"), entry("value", { sizeBytes: 3 }));

    await expect(adapter.get(key("large"))).resolves.toBeUndefined();
  });

  it("deletes one key and reports whether it existed", async () => {
    const adapter = createAdapter();
    await adapter.set(key("key"), entry("value"));

    await expect(adapter.delete(key("key"))).resolves.toBe(true);
    await expect(adapter.delete(key("key"))).resolves.toBe(false);
  });

  it("invalidates entries containing every requested stored tag", async () => {
    const adapter = createAdapter();
    await adapter.set(key("all"), entry("all", { tags: ["a", "b"] }));
    await adapter.set(key("partial"), entry("partial", { tags: ["a"] }));
    await adapter.set(
      key("other", "other"),
      entry("other", { tags: ["other:a", "other:b"] }),
    );

    await expect(adapter.invalidateAllTags(["a", "b"]))
      .resolves.toBe(1);
    await expect(adapter.get(key("all"))).resolves.toBeUndefined();
    await expect(adapter.get(key("partial"))).resolves.toBeDefined();
    await expect(adapter.get(key("other", "other")))
      .resolves.toBeDefined();
  });

  it("resets the complete adapter", async () => {
    const adapter = createAdapter();
    await adapter.set(key("first"), entry("first"));
    await adapter.set(key("second", "other"), entry("second"));

    await expect(adapter.reset()).resolves.toBe(2);
    await expect(adapter.get(key("second", "other")))
      .resolves.toBeUndefined();
  });

  it("prunes expired entries in bounded batches", async () => {
    const adapter = createAdapter();
    const expired = new Date("2026-01-01T00:00:00.000Z");
    await adapter.set(key("first"), entry("first", { expiresAt: expired }));
    await adapter.set(key("second"), entry("second", { expiresAt: expired }));
    await adapter.set(key("fresh"), entry("fresh"));

    await expect(adapter.prune({ limit: 1 }))
      .resolves.toBe(1);
    await expect(adapter.prune({ limit: 1 }))
      .resolves.toBe(1);
    await expect(adapter.prune({ limit: 1 }))
      .resolves.toBe(0);
    await expect(adapter.get(key("fresh"))).resolves.toBeDefined();
  });

  it("evicts the earliest-expiring entries over the adapter limit", async () => {
    const adapter = createAdapter({ maxEntries: 2 });
    await adapter.set(key("first"), entry("first", {
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    }));
    await adapter.set(key("second"), entry("second", {
      expiresAt: new Date("2026-01-01T02:00:00.000Z"),
    }));
    await adapter.set(key("third"), entry("third", {
      expiresAt: new Date("2026-01-01T03:00:00.000Z"),
    }));

    await expect(adapter.prune({ limit: 10 }))
      .resolves.toBe(1);
    await expect(adapter.get(key("first"))).resolves.toBeUndefined();
    await expect(adapter.get(key("second"))).resolves.toBeDefined();
    await expect(adapter.get(key("third"))).resolves.toBeDefined();
  });
});
