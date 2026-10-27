import { setTimeout as pause } from "node:timers/promises";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, integer, pgSchema, text } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../app/index.js";
import { buildCli } from "../../cli/runner.js";
import { createPostgresTestConfig, createPostgresTestPool } from "../../testing/postgres.js";
import { PostgresDrizzleProvider } from "../provider.js";
import { applyDatabaseSchemaContributions } from "../schema_contributions/apply.js";
import { defineReferenceCounter, getReferenceCounterDefinitions } from "./definition.js";
import { ReferenceCounterMaintenance, type ReferenceCounterProgress } from "./maintenance.js";
import { tableIdentifier } from "./sql.js";

const namespace = pgSchema("kestrel_counter_test");
const topic = namespace.table("topic", {
  id: integer("id").primaryKey(), count: integer("published_count").notNull().default(0),
  total: bigint("total_count", { mode: "bigint" }).notNull().default(0n),
});
const owner = namespace.table("owner", { id: integer("id").primaryKey() });
const item = namespace.table("item", {
  id: integer("id").primaryKey(),
  topicId: integer("topic_id").references(() => topic.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id").references(() => owner.id, { onDelete: "cascade" }),
  status: text("status"), deletedAt: text("deleted_at"),
});
const filtered = defineReferenceCounter(item, {
  id: "topic.published", reference: item.topicId, target: topic.id, counter: topic.count,
  where: (row) => and(eq(row.status, "published"), isNull(row.deletedAt)),
});
defineReferenceCounter(item, { id: "topic.total", reference: item.topicId, target: topic.id, counter: topic.total });
const large = namespace.table("large", { id: bigint("id", { mode: "bigint" }).primaryKey(), count: integer("count").notNull().default(0) });
const largeItem = namespace.table("large_item", { id: integer("id").primaryKey(), parentId: bigint("parent_id", { mode: "bigint" }).references(() => large.id) });
defineReferenceCounter(largeItem, { id: "large.count", reference: largeItem.parentId, target: large.id, counter: large.count });
const schema = { topic, owner, item, large, largeItem };
let pool: Pool;
let database: ReturnType<typeof drizzle<typeof schema>>;
let maintenance: ReferenceCounterMaintenance;

beforeAll(async () => {
  pool = createPostgresTestPool();
  database = drizzle(pool, { schema });
  maintenance = new ReferenceCounterMaintenance(database, getReferenceCounterDefinitions(schema));
  await pool.query(`
    DROP SCHEMA IF EXISTS kestrel_counter_test CASCADE;
    CREATE SCHEMA kestrel_counter_test;
    CREATE TABLE kestrel_counter_test.topic (id integer PRIMARY KEY, published_count integer NOT NULL DEFAULT 0, total_count bigint NOT NULL DEFAULT 0);
    CREATE TABLE kestrel_counter_test.owner (id integer PRIMARY KEY);
    CREATE TABLE kestrel_counter_test.item (
      id integer PRIMARY KEY, topic_id integer REFERENCES kestrel_counter_test.topic ON DELETE CASCADE,
      owner_id integer REFERENCES kestrel_counter_test.owner ON DELETE CASCADE, status text, deleted_at text
    );
    CREATE INDEX ON kestrel_counter_test.item (topic_id);
    CREATE TABLE kestrel_counter_test.large (id bigint PRIMARY KEY, count integer NOT NULL DEFAULT 0);
    CREATE TABLE kestrel_counter_test.large_item (id integer PRIMARY KEY, parent_id bigint REFERENCES kestrel_counter_test.large);
  `);
  await applyDatabaseSchemaContributions(schema, async (statement) => { await pool.query(statement); });
  // Replaying the contribution must not scan data or install duplicate triggers.
  await applyDatabaseSchemaContributions(schema, async (statement) => { await pool.query(statement); });
});

beforeEach(async () => {
  await pool.query("TRUNCATE kestrel_counter_test.item, kestrel_counter_test.topic, kestrel_counter_test.owner, kestrel_counter_test.large_item, kestrel_counter_test.large;");
  await database.insert(topic).values([{ id: 1 }, { id: 2 }, { id: 3 }]);
});

afterAll(async () => {
  try { await pool?.query("DROP SCHEMA IF EXISTS kestrel_counter_test CASCADE;"); }
  finally { await pool?.end(); }
});

async function counts() {
  return database.select({ id: topic.id, count: topic.count, total: topic.total }).from(topic).orderBy(topic.id);
}

/** Observe actual server lock waits instead of relying on arbitrary scheduling delays. */
async function waitForLock(fragment: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND position($1 in query) > 0", [fragment]);
    if (result.rowCount) return;
    await pause(10);
  }
  throw new Error(`Expected a PostgreSQL lock wait for ${fragment}.`);
}

describe("synchronous reference counters", () => {
  it("handles filters, null references, transfers, deletes and independent counters", async () => {
    await database.insert(item).values([
      { id: 1, topicId: 1, status: "published" },
      { id: 2, topicId: 1, status: "draft" },
      { id: 3, topicId: null, status: "published" },
      { id: 4, topicId: 1, status: null },
    ]);
    expect((await counts())[0]).toEqual({ id: 1, count: 1, total: 3n });
    await database.update(item).set({ status: "published" }).where(eq(item.id, 2));
    await database.update(item).set({ topicId: 2 }).where(eq(item.id, 1));
    await database.update(item).set({ deletedAt: "deleted" }).where(eq(item.id, 2));
    await database.update(item).set({ topicId: 2 }).where(eq(item.id, 3));
    expect(await counts()).toEqual([{ id: 1, count: 0, total: 2n }, { id: 2, count: 2, total: 2n }, { id: 3, count: 0, total: 0n }]);
    await database.update(item).set({ topicId: null }).where(eq(item.id, 1));
    await database.delete(item).where(eq(item.id, 3));
    expect((await counts())[1]).toEqual({ id: 2, count: 0, total: 0n });
  });

  it("does not write the parent for irrelevant or equivalent source updates", async () => {
    await database.insert(item).values({ id: 1, topicId: 1, status: "draft" });
    const version = async () => (await pool.query("SELECT xmin::text AS version FROM kestrel_counter_test.topic WHERE id = 1")).rows[0].version;
    const before = await version();
    await database.update(item).set({ status: "draft", deletedAt: "irrelevant" }).where(eq(item.id, 1));
    expect(await version()).toBe(before);
  });

  it("rolls back source and counter together and preserves counts across upserts", async () => {
    await expect(database.transaction(async (transaction) => {
      await transaction.insert(item).values({ id: 1, topicId: 1, status: "published" });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await counts())[0]?.count).toBe(0);
    await database.insert(item).values({ id: 1, topicId: 1, status: "draft" });
    await database.insert(item).values({ id: 1, topicId: 1, status: "published" })
      .onConflictDoUpdate({ target: item.id, set: { status: "published" } });
    await database.insert(item).values({ id: 1, topicId: 1, status: "published" }).onConflictDoNothing();
    expect((await counts())[0]).toEqual({ id: 1, count: 1, total: 1n });
  });

  it("handles cascades through the source and removal of its target", async () => {
    await database.insert(owner).values({ id: 1 });
    await database.insert(item).values({ id: 1, topicId: 1, ownerId: 1, status: "published" });
    await database.delete(owner).where(eq(owner.id, 1));
    expect((await counts())[0]?.count).toBe(0);
    await database.insert(item).values({ id: 2, topicId: 1, status: "published" });
    await database.delete(topic).where(eq(topic.id, 1));
    expect(await database.select().from(item)).toEqual([]);
    await expect(database.update(topic).set({ id: 20 }).where(eq(topic.id, 2))).rejects.toThrow();
  });

  it("rebuilds only incorrect values and resumes strictly after committed keys", async () => {
    await database.insert(item).values([{ id: 1, topicId: 1, status: "published" }, { id: 2, topicId: 2, status: "published" }]);
    await database.update(topic).set({ count: 99 });
    const controller = new AbortController();
    const progress: ReferenceCounterProgress[] = [];
    const first = await maintenance.rebuild(filtered.id, {
      batchSize: 1, pauseMs: 0, signal: controller.signal,
      onProgress: async (value) => {
        // A separate connection sees the correction before the cursor is emitted.
        expect((await counts())[0]?.count).toBe(1);
        progress.push(value); controller.abort();
      },
    });
    expect(first).toMatchObject({ processed: 1, updated: 1, cursor: "1", completed: false });
    expect(progress).toHaveLength(1);
    const rest = await maintenance.rebuild(filtered.id, { after: first.cursor!, batchSize: 1, pauseMs: 0 });
    expect(rest).toMatchObject({ processed: 2, updated: 2, cursor: "3", completed: true });
    expect((await maintenance.rebuild(filtered.id, { pauseMs: 0 })).updated).toBe(0);
    expect((await maintenance.rebuild(filtered.id, { after: "999", pauseMs: 0 })).processed).toBe(0);
    await expect(maintenance.rebuild("missing")).rejects.toThrow("Unknown reference counter");
    await expect(maintenance.rebuild(filtered.id, { batchSize: 0 })).rejects.toThrow("batchSize");
  });

  it("retains a committed batch when progress reporting fails", async () => {
    await database.update(topic).set({ count: 99 });
    await expect(maintenance.rebuild(filtered.id, {
      batchSize: 1, pauseMs: 0, onProgress: () => { throw new Error("output failed"); },
    })).rejects.toThrow("output failed");
    expect((await counts()).map((row) => row.count)).toEqual([0, 99, 99]);
  });

  it("initializes pre-existing references without counting them during schema installation", async () => {
    // Model rows that predate counter installation, then restore ordinary execution.
    await pool.query("ALTER TABLE kestrel_counter_test.item DISABLE TRIGGER USER");
    try {
      await database.insert(item).values([{ id: 1, topicId: 1, status: "published" }, { id: 2, topicId: 1, status: "draft" }]);
    } finally { await pool.query("ALTER TABLE kestrel_counter_test.item ENABLE TRIGGER USER"); }
    await applyDatabaseSchemaContributions(schema, async (statement) => { await pool.query(statement); });
    expect((await counts())[0]).toEqual({ id: 1, count: 0, total: 0n });
    await maintenance.rebuild(filtered.id, { pauseMs: 0 });
    await maintenance.rebuild("topic.total", { pauseMs: 0 });
    expect((await counts())[0]).toEqual({ id: 1, count: 1, total: 2n });
  });

  it("rolls back a failing batch without publishing its cursor or losing earlier batches", async () => {
    await database.update(topic).set({ count: 99 });
    await pool.query("ALTER TABLE kestrel_counter_test.topic ADD CONSTRAINT reject_second_correction CHECK (id <> 2 OR published_count <> 0)");
    const progress: ReferenceCounterProgress[] = [];
    try {
      await expect(maintenance.rebuild(filtered.id, { batchSize: 1, pauseMs: 0, onProgress: (value) => { progress.push(value); } })).rejects.toThrow();
      expect(progress.map((value) => value.cursor)).toEqual(["1"]);
      expect((await counts()).map((row) => row.count)).toEqual([0, 99, 99]);
    } finally { await pool.query("ALTER TABLE kestrel_counter_test.topic DROP CONSTRAINT reject_second_correction"); }
    expect(await maintenance.rebuild(filtered.id, { after: "1", pauseMs: 0 })).toMatchObject({ completed: true, updated: 2 });
  });

  it("executes quoted identifiers, predicate literals and keys matching local variable names", async () => {
    const odd = pgSchema('kestrel.counter"test');
    const parent = odd.table('parent.name"', { id: text("old_key").primaryKey(), count: integer('count"').notNull().default(0) });
    const child = odd.table('child.name"', { parentId: text('reference"').references(() => parent.id), status: text("status") });
    const status = "published' $counter$";
    const definition = defineReferenceCounter(child, { id: "quoted.count", reference: child.parentId, target: parent.id, counter: parent.count, where: (row) => eq(row.status, status) });
    try {
      await pool.query(`CREATE SCHEMA "kestrel.counter""test";
        CREATE TABLE ${tableIdentifier(parent)} (old_key text PRIMARY KEY, "count""" integer NOT NULL DEFAULT 0);
        CREATE TABLE ${tableIdentifier(child)} ("reference""" text REFERENCES ${tableIdentifier(parent)} (old_key), status text);`);
      await applyDatabaseSchemaContributions({ parent, child }, async (statement) => { await pool.query(statement); });
      const id = "key'; SELECT 1; --";
      await database.insert(parent).values({ id });
      await database.insert(child).values({ parentId: id, status });
      expect((await database.select().from(parent))[0]?.count).toBe(1);
      await database.update(parent).set({ count: 8 });
      const service = new ReferenceCounterMaintenance(database, [definition]);
      expect(await service.rebuild(definition.id, { after: "a", pauseMs: 0 })).toMatchObject({ updated: 1, cursor: id });
      await database.delete(child);
      expect((await database.select().from(parent))[0]?.count).toBe(0);
    } finally { await pool.query('DROP SCHEMA IF EXISTS "kestrel.counter""test" CASCADE'); }
  });

  it("serializes concurrent increments without losing updates", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => database.insert(item).values({ id: index + 1, topicId: 1, status: "published" })));
    expect((await counts())[0]).toEqual({ id: 1, count: 12, total: 12n });
  });

  it("takes a fresh count snapshot after waiting for an uncommitted writer", async () => {
    const writer = await pool.connect();
    let rebuilding: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("INSERT INTO kestrel_counter_test.item (id, topic_id, status) VALUES (1, 1, 'published')");
      rebuilding = maintenance.rebuild(filtered.id, { pauseMs: 0 });
      await waitForLock('SELECT "id"::text AS cursor');
      await writer.query("COMMIT");
      await rebuilding;
      expect((await counts())[0]?.count).toBe(1);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await rebuilding;
    }
  });

  it("lets a source write waiting on a rebuild apply its delta after commit", async () => {
    // Interpose after the actual batch lock, while retaining a real PostgreSQL transaction.
    let writing: Promise<unknown> | undefined;
    const wrapped = {
      transaction: (callback: (transaction: any) => Promise<unknown>, config: any) => database.transaction(async (transaction) => {
        let first = true;
        const proxy = new Proxy(transaction, { get(target, property) {
          if (property !== "execute") return Reflect.get(target, property);
          return async (query: any) => {
            const result = await transaction.execute(query);
            if (first) {
              first = false;
              writing = pool.query("INSERT INTO kestrel_counter_test.item (id, topic_id, status) VALUES (1, 1, 'published')");
              await waitForLock("INSERT INTO kestrel_counter_test.item");
            }
            return result;
          };
        } });
        return callback(proxy);
      }, config),
    } as unknown as typeof database;
    try {
      await new ReferenceCounterMaintenance(wrapped, [filtered]).rebuild(filtered.id, { batchSize: 100, pauseMs: 0 });
      await writing;
      expect((await counts())[0]?.count).toBe(1);
    } finally { await writing; }
  });

  it("keeps bigint cursors exact beyond JavaScript's safe integer range", async () => {
    const first = 9007199254740993n;
    await database.insert(large).values([{ id: first, count: 4 }, { id: first + 1n, count: 5 }]);
    const result = await maintenance.rebuild("large.count", { after: String(first), pauseMs: 0 });
    expect(result).toMatchObject({ cursor: String(first + 1n), processed: 1, updated: 1 });
    expect((await database.select().from(large).orderBy(large.id)).map((row) => row.count)).toEqual([4, 0]);
  });

  it("discovers the counter through the App and exposes resumable CLI progress", async () => {
    await database.update(topic).set({ count: 99 });
    const app = new App({}).register(new PostgresDrizzleProvider(createPostgresTestConfig(), { schema }));
    const output: string[] = [];
    const progress: string[] = [];
    const cli = buildCli(app, { writeOutput: (value) => output.push(value), writeError: (value) => progress.push(value) });
    const listeners = process.listenerCount("SIGINT");
    try {
      expect(await cli.run(["database", "counter", "rebuild", "--id=topic.published", "--after=1", "--batch-size=1", "--pause-ms=0", "--_format=json"])).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({ completed: true, processed: 2, updated: 2, cursor: "3" });
      expect(progress.join("")).toContain("Resume cursor: 2");
      expect((await counts()).map((row) => row.count)).toEqual([99, 0, 0]);
      expect(process.listenerCount("SIGINT")).toBe(listeners);
    } finally { await app.dispose(); }
  });
});
