import { drizzle } from "drizzle-orm/node-postgres";
import {
  bigserial,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createPostgresTestPool } from "../../../testing/postgres.js";
import {
  PostgresLockAdapter,
  type PostgresLockDatabase,
} from "./adapter.js";
import { lockLeases } from "../../postgres_schema.js";

// This equivalent unqualified table keeps tests isolated on one connection.
const testLockLeases = pgTable("lock_lease", {
  key: text("key").primaryKey(),
  ownerId: text("owner_id").notNull(),
  fencingToken: bigserial("fencing_token", {
    mode: "bigint",
  }).notNull(),
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});

let pool: Pool;
let client: PoolClient;
let database: PostgresLockDatabase;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();

  await client.query(`
    CREATE TEMPORARY TABLE lock_lease (
      key text PRIMARY KEY,
      owner_id text NOT NULL,
      fencing_token bigserial NOT NULL,
      expires_at timestamp with time zone NOT NULL
    ) ON COMMIT PRESERVE ROWS
  `);
  database = drizzle(client) as PostgresLockDatabase;
});

beforeEach(async () => {
  await client.query("TRUNCATE lock_lease RESTART IDENTITY");
});

afterAll(async () => {
  client?.release();
  await pool?.end();
});

describe("PostgresLockAdapter", () => {
  it("treats empty batches as no-ops and preserves ownership in single-item batches", async () => {
    const adapter = createAdapter();
    const request = { key: "test:single", ownerId: "owner", ttlMs: 60_000 };

    await expect(adapter.tryAcquireMany([])).resolves.toEqual([]);
    await expect(adapter.extendMany([])).resolves.toEqual([]);
    const [lease] = (await adapter.tryAcquireMany([request]))!;
    await expect(adapter.tryAcquireMany([{ ...request, ownerId: "other" }]))
      .resolves.toBeUndefined();
    await expect(adapter.extendMany([{ ...request, ownerId: "other" }]))
      .resolves.toBeUndefined();

    await expect(adapter.extendMany([{ ...request, ttlMs: 120_000 }])).resolves.toEqual([{
      key: request.key, ownerId: request.ownerId,
      fencingToken: lease!.fencingToken, expiresAt: expect.any(Date),
    }]);
    await expect(adapter.release(request)).resolves.toBe(true);
  });

  it("propagates database failures and rolls back writes for every batch member", async () => {
    const adapter = createAdapter();
    const first = { key: "test:first", ownerId: "first", ttlMs: 60_000 };
    const second = { key: "test:second", ownerId: "second", ttlMs: 60_000 };
    await client.query(`
      ALTER TABLE lock_lease
        ADD CONSTRAINT test_owner_guard CHECK (owner_id <> 'invalid'),
        ADD CONSTRAINT test_expiry_guard CHECK (expires_at < '2100-01-01T00:00:00Z')
    `);
    try {
      // A schema failure is distinct from contention and leaves no lease behind.
      await expect(adapter.tryAcquireMany([first, { ...second, ownerId: "invalid" }]))
        .rejects.toMatchObject({ cause: { code: "23514", constraint: "test_owner_guard" } });
      expect((await client.query("SELECT key FROM lock_lease")).rows).toEqual([]);

      const before = await adapter.tryAcquireMany([first, second]);
      await expect(adapter.extendMany([
        { ...first, ttlMs: 120_000 }, { ...second, ttlMs: 10_000_000_000_000 },
      ])).rejects.toMatchObject({ cause: { code: "23514", constraint: "test_expiry_guard" } });
      const after = await client.query("SELECT expires_at FROM lock_lease ORDER BY key");
      expect(after.rows.map((row) => row.expires_at)).toEqual(before!.map((lease) => lease.expiresAt));
    } finally {
      await client.query("ALTER TABLE lock_lease DROP CONSTRAINT test_owner_guard, DROP CONSTRAINT test_expiry_guard");
    }
  });

  it("atomically rejects contention for a live lease", async () => {
    const adapter = createAdapter();
    const first = await adapter.tryAcquire({
      key: "test:key",
      ownerId: "first",
      ttlMs: 60_000,
    });
    const second = await adapter.tryAcquire({
      key: "test:key",
      ownerId: "second",
      ttlMs: 60_000,
    });

    expect(first).toMatchObject({
      ownerId: "first",
      fencingToken: 1n,
    });
    expect(second).toBeUndefined();
  });

  it("takes over an expired lease with a newer fencing token", async () => {
    const adapter = createAdapter();
    await client.query(`
      INSERT INTO lock_lease (key, owner_id, expires_at)
      VALUES ('test:key', 'expired', statement_timestamp() - interval '1 second')
    `);

    const lease = await adapter.tryAcquire({
      key: "test:key",
      ownerId: "new-owner",
      ttlMs: 60_000,
    });

    expect(lease).toMatchObject({
      ownerId: "new-owner",
      fencingToken: 2n,
    });
  });

  it("acquires a batch atomically and preserves request order", async () => {
    const adapter = createAdapter();
    await adapter.tryAcquire({
      key: "test:busy",
      ownerId: "existing",
      ttlMs: 60_000,
    });

    await expect(adapter.tryAcquireMany([
      { key: "test:first", ownerId: "first", ttlMs: 60_000 },
      { key: "test:busy", ownerId: "busy", ttlMs: 60_000 },
    ])).resolves.toBeUndefined();

    const rolledBack = await client.query(
      "SELECT key FROM lock_lease WHERE key = 'test:first'",
    );
    expect(rolledBack.rows).toHaveLength(0);

    const leases = await adapter.tryAcquireMany([
      { key: "test:second", ownerId: "second", ttlMs: 60_000 },
      { key: "test:first", ownerId: "first", ttlMs: 60_000 },
    ]);
    expect(leases?.map((lease) => lease.key)).toEqual([
      "test:second",
      "test:first",
    ]);
  });

  it("rejects duplicate keys in a batch", async () => {
    const adapter = createAdapter();
    const duplicate = [
      { key: "test:key", ownerId: "first", ttlMs: 60_000 },
      { key: "test:key", ownerId: "second", ttlMs: 60_000 },
    ];
    await expect(adapter.tryAcquireMany(duplicate)).rejects.toThrow("unique keys");
    await expect(adapter.extendMany(duplicate)).rejects.toThrow("unique keys");
  });

  it("submits both set-based writes in a canonical order across caller permutations", async () => {
    const batches: string[][] = [];
    const keys = ["test:B", "test:a", "test:b"];
    const observedDatabase = drizzle(client, {
      logger: {
        logQuery(query, parameters) {
          if (query.includes("insert into") || query.includes("WITH requested")) {
            batches.push(parameters.filter((parameter): parameter is string =>
              typeof parameter === "string" && keys.includes(parameter)));
          }
        },
      },
    }) as PostgresLockDatabase;
    const adapter = new PostgresLockAdapter(observedDatabase, testLockLeases as unknown as typeof lockLeases);
    const request = (key: string) => ({ key, ownerId: "owner", ttlMs: 60_000 });
    const reversed = [...keys].reverse();
    const rotated = [keys[1]!, keys[2]!, keys[0]!];

    // SQL binds keys in code-unit order even though both result lists follow input order.
    expect((await adapter.tryAcquireMany(reversed.map(request)))?.map(({ key }) => key)).toEqual(reversed);
    expect((await adapter.extendMany(rotated.map(request)))?.map(({ key }) => key)).toEqual(rotated);
    expect(batches).toEqual([keys, keys]);
  });

  it("extends only a live lease owned by the caller", async () => {
    const adapter = createAdapter();
    const acquired = await adapter.tryAcquire({
      key: "test:key",
      ownerId: "owner",
      ttlMs: 60_000,
    });

    await expect(adapter.extend({
      key: "test:key",
      ownerId: "other",
      ttlMs: 120_000,
    })).resolves.toBeUndefined();

    const extended = await adapter.extend({
      key: "test:key",
      ownerId: "owner",
      ttlMs: 120_000,
    });

    expect(extended?.fencingToken).toBe(acquired?.fencingToken);
    expect(extended!.expiresAt.getTime())
      .toBeGreaterThan(acquired!.expiresAt.getTime());
  });

  it("extends a batch atomically and preserves request order", async () => {
    const adapter = createAdapter();
    const acquired = await adapter.tryAcquireMany([
      { key: "test:first", ownerId: "first", ttlMs: 60_000 },
      { key: "test:second", ownerId: "second", ttlMs: 60_000 },
    ]);

    await expect(adapter.extendMany([
      { key: "test:first", ownerId: "first", ttlMs: 120_000 },
      { key: "test:second", ownerId: "wrong", ttlMs: 120_000 },
    ])).resolves.toBeUndefined();

    const afterRollback = await client.query<{
      key: string;
      expires_at: Date;
    }>("SELECT key, expires_at FROM lock_lease ORDER BY key");
    expect(afterRollback.rows.map((row) => row.expires_at)).toEqual(
      acquired?.map((lease) => lease.expiresAt),
    );

    const extended = await adapter.extendMany([
      { key: "test:second", ownerId: "second", ttlMs: 120_000 },
      { key: "test:first", ownerId: "first", ttlMs: 120_000 },
    ]);
    expect(extended?.map((lease) => lease.key)).toEqual([
      "test:second",
      "test:first",
    ]);
    expect(extended![0]!.expiresAt.getTime())
      .toBeGreaterThan(acquired![1]!.expiresAt.getTime());
  });

  it("does not extend an expired lease", async () => {
    const adapter = createAdapter();
    await client.query(`
      INSERT INTO lock_lease (key, owner_id, expires_at)
      VALUES ('test:key', 'owner', statement_timestamp() - interval '1 second')
    `);

    await expect(adapter.extend({
      key: "test:key",
      ownerId: "owner",
      ttlMs: 60_000,
    })).resolves.toBeUndefined();
  });

  it("releases only the current owner's lease", async () => {
    const adapter = createAdapter();
    await adapter.tryAcquire({
      key: "test:key",
      ownerId: "owner",
      ttlMs: 60_000,
    });

    await expect(adapter.release({
      key: "test:key",
      ownerId: "other",
    })).resolves.toBe(false);
    await expect(adapter.release({
      key: "test:key",
      ownerId: "owner",
    })).resolves.toBe(true);
    await expect(adapter.release({
      key: "test:key",
      ownerId: "owner",
    })).resolves.toBe(false);
  });

  it("prunes expired leases in bounded batches", async () => {
    const adapter = createAdapter();
    await client.query(`
      INSERT INTO lock_lease (key, owner_id, expires_at)
      VALUES
        ('test:first', 'first', statement_timestamp() - interval '1 second'),
        ('test:second', 'second', statement_timestamp() - interval '1 second'),
        ('test:fresh', 'fresh', statement_timestamp() + interval '1 minute')
    `);

    await expect(adapter.prune({ limit: 1 })).resolves.toBe(1);
    await expect(adapter.prune({ limit: 1 })).resolves.toBe(1);
    await expect(adapter.prune({})).resolves.toBe(0);
    await expect(adapter.prune({ limit: 0 })).rejects.toThrow("Lock prune limit must be a positive integer");

    const remaining = await client.query<{ key: string }>(
      "SELECT key FROM lock_lease",
    );
    expect(remaining.rows).toEqual([{ key: "test:fresh" }]);
  });
});

function createAdapter(): PostgresLockAdapter {
  return new PostgresLockAdapter(
    database,
    testLockLeases as unknown as typeof lockLeases,
  );
}
