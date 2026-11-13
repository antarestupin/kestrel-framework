import { setTimeout as pause } from "node:timers/promises";
import timerPromises from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, integer, pgSchema, pgTable, text } from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../app/index.js";
import { buildCli } from "../../cli/runner.js";
import { createPostgresTestConfig, createPostgresTestPool } from "../../testing/postgres.js";
import { PostgresDrizzleProvider } from "../provider.js";
import { applyDatabaseSchemaContributions } from "../schema_contributions/apply.js";
import { defineReferenceCounter, getReferenceCounterDefinitions } from "./definition.js";
import { ReferenceCounterMaintenance, type ReferenceCounterProgress } from "./maintenance.js";
import { counterObjectName, tableIdentifier } from "./sql.js";
import { createReferenceCounterRemovalSql } from "./trigger_sql.js";

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

let initialized = false;

async function installCounterFixture() {
  pool ??= createPostgresTestPool();
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
}

beforeEach(async () => {
  if (!initialized) {
    // Fail the exercising test if PostgreSQL rejects the generated trigger.
    await installCounterFixture();
    initialized = true;
  }
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
  it("qualifies default-schema counter objects and removes both trigger functions", async () => {
    const parent = pgTable("kestrel_counter_path_parent", {
      id: integer("id").primaryKey(), count: integer("count").notNull().default(0),
    });
    const child = pgTable("kestrel_counter_path_child", {
      id: integer("id").primaryKey(), parentId: integer("parent_id").references(() => parent.id),
    });
    const definition = defineReferenceCounter(child, {
      id: "counter.path", reference: child.parentId, target: parent.id, counter: parent.count,
    });
    const functionName = counterObjectName(definition);
    const client = await pool.connect();
    try {
      // A tenant-first search path must leave the installation on the declared public tables.
      await client.query(`
        BEGIN;
        SET LOCAL search_path = kestrel_counter_test, public;
        CREATE TABLE public.kestrel_counter_path_parent (id integer PRIMARY KEY, count integer NOT NULL DEFAULT 0);
        CREATE TABLE public.kestrel_counter_path_child (
          id integer PRIMARY KEY, parent_id integer REFERENCES public.kestrel_counter_path_parent
        );
        CREATE TABLE kestrel_counter_test.kestrel_counter_path_parent (LIKE public.kestrel_counter_path_parent INCLUDING ALL);
        CREATE TABLE kestrel_counter_test.kestrel_counter_path_child (LIKE public.kestrel_counter_path_child INCLUDING ALL);
        INSERT INTO public.kestrel_counter_path_parent (id) VALUES (1);
        INSERT INTO kestrel_counter_test.kestrel_counter_path_parent (id) VALUES (1);
      `);
      await applyDatabaseSchemaContributions({ parent, child }, async (statement) => { await client.query(statement); });
      await client.query("INSERT INTO public.kestrel_counter_path_child VALUES (1, 1)");
      expect((await client.query("SELECT count FROM public.kestrel_counter_path_parent")).rows).toEqual([{ count: 1 }]);
      expect((await client.query("SELECT count FROM kestrel_counter_test.kestrel_counter_path_parent")).rows).toEqual([{ count: 0 }]);

      const installedFunctions = () => client.query(`SELECT proname FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ($1, $2)`, [functionName, `${functionName}_key`]);
      expect((await installedFunctions()).rows).toHaveLength(2);

      await client.query(createReferenceCounterRemovalSql(definition));
      await client.query(`
        DELETE FROM public.kestrel_counter_path_child WHERE id = 1;
        UPDATE public.kestrel_counter_path_parent SET id = 2 WHERE id = 1;
        INSERT INTO public.kestrel_counter_path_child VALUES (2, 2);
      `);
      expect((await client.query("SELECT id, count FROM public.kestrel_counter_path_parent")).rows).toEqual([{ id: 2, count: 1 }]);
      expect((await installedFunctions()).rows).toEqual([]);
    } finally {
      try { await client.query("ROLLBACK"); }
      finally { client.release(); }
    }
  });

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
    const cursors: (string | undefined)[] = [];
    const rest = await maintenance.rebuild(filtered.id, {
      after: first.cursor!, batchSize: 1, pauseMs: 0,
      onProgress: ({ cursor }) => {
        expect(cursors.length).toBeLessThan(2);
        cursors.push(cursor);
        expect(cursors).toEqual(["2", "3"].slice(0, cursors.length));
      },
    });
    expect(rest).toMatchObject({ processed: 2, updated: 2, cursor: "3", completed: true });
    expect((await maintenance.rebuild(filtered.id, { pauseMs: 0 })).updated).toBe(0);
    const emptyProgress: ReferenceCounterProgress[] = [];
    expect(await maintenance.rebuild(filtered.id, {
      after: "999", pauseMs: 0, onProgress: (value) => { emptyProgress.push(value); },
    })).toEqual({ id: filtered.id, processed: 0, updated: 0, cursor: "999", completed: true });
    expect(emptyProgress).toEqual([]);
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

  it("keeps the rebuild cursor independent of mutations to callback progress", async () => {
    await database.update(topic).set({ count: 99 });
    const reported: string[] = [];
    const result = await maintenance.rebuild(filtered.id, {
      batchSize: 1, pauseMs: 0,
      onProgress(progress) {
        reported.push(progress.cursor!);
        // An untyped diagnostic consumer can retain or annotate the callback object.
        Object.assign(progress, { cursor: "999", processed: -1, updated: -1 });
      },
    });

    expect(reported).toEqual(["1", "2", "3"]);
    expect(result).toStrictEqual({ id: filtered.id, cursor: "3", processed: 3, updated: 3, completed: true });
    expect((await counts()).map(({ count }) => count)).toEqual([0, 0, 0]);
  });

  it("orders a primary key physically named cursor by its native type", async () => {
    const parent = namespace.table("cursor_parent", {
      id: integer("cursor").primaryKey(), count: integer("count").notNull().default(0),
    });
    const child = namespace.table("cursor_child", {
      parentId: integer("parent_id").references(() => parent.id),
    });
    const definition = defineReferenceCounter(child, {
      id: "cursor.count", reference: child.parentId, target: parent.id, counter: parent.count,
    });
    await pool.query(`
      CREATE TABLE ${tableIdentifier(parent)} (cursor integer PRIMARY KEY, count integer NOT NULL DEFAULT 0);
      CREATE TABLE ${tableIdentifier(child)} (parent_id integer REFERENCES ${tableIdentifier(parent)});
    `);
    try {
      await database.insert(parent).values([{ id: 2, count: 8 }, { id: 10, count: 8 }]);
      const cursors: (string | undefined)[] = [];
      const service = new ReferenceCounterMaintenance(database, [definition]);
      const result = await service.rebuild(definition.id, {
        batchSize: 1, pauseMs: 0, onProgress: ({ cursor }) => { cursors.push(cursor); },
      });
      expect(cursors).toEqual(["2", "10"]);
      expect(result).toMatchObject({ processed: 2, updated: 2, cursor: "10", completed: true });
      expect(await database.select().from(parent).orderBy(parent.id)).toEqual([{ id: 2, count: 0 }, { id: 10, count: 0 }]);
    } finally {
      await pool.query(`DROP TABLE ${tableIdentifier(child)}, ${tableIdentifier(parent)}`);
    }
  });

  it("advances exactly once per full batch and stops on an empty page", async () => {
    await database.update(topic).set({ count: 8 });
    const progress: (string | undefined)[] = [];
    const result = await maintenance.rebuild(filtered.id, {
      batchSize: 1, after: "1", pauseMs: 0,
      onProgress: ({ cursor }) => {
        expect(progress.length).toBeLessThan(2);
        expect(cursor).toBeDefined();
        expect(Number(cursor)).toBeGreaterThan(Number(progress.at(-1) ?? "1"));
        progress.push(cursor);
      },
    });
    expect(progress).toEqual(["2", "3"]);
    expect(result).toMatchObject({ processed: 2, updated: 2, cursor: "3", completed: true });
  });

  it("validates rebuild limits and preserves the resume cursor when cancelled before work", async () => {
    await database.update(topic).set({ count: 99 });
    for (const options of [
      { batchSize: 1.5 }, { batchSize: 10_001 }, { batchSize: Number.NaN },
      { pauseMs: -1 }, { pauseMs: 0.5 }, { pauseMs: 60_001 },
    ]) {
      await expect(maintenance.rebuild(filtered.id, options))
        .rejects.toThrow("Counter rebuild requires batchSize 1..10000 and pauseMs 0..60000.");
    }

    const controller = new AbortController();
    controller.abort();
    const progress: ReferenceCounterProgress[] = [];
    // Maximum values are valid. A pre-cancelled rebuild must leave every batch untouched.
    expect(await maintenance.rebuild(filtered.id, {
      after: "1", batchSize: 10_000, pauseMs: 60_000, signal: controller.signal,
      onProgress: (value) => { progress.push(value); },
    })).toEqual({ id: filtered.id, processed: 0, updated: 0, cursor: "1", completed: false });
    expect(progress).toEqual([]);
    expect((await counts()).map((row) => row.count)).toEqual([99, 99, 99]);
  });

  it("reports cancellation even when the just-committed partial batch reached the end", async () => {
    await database.update(topic).set({ count: 99 });
    const controller = new AbortController();
    const onProgress = (progress: ReferenceCounterProgress) => {
      expect(progress).toEqual({ id: filtered.id, cursor: "3", processed: 3, updated: 3 });
      controller.abort();
    };

    expect(await maintenance.rebuild(filtered.id, { batchSize: 10, pauseMs: 0, signal: controller.signal, onProgress }))
      .toEqual({ id: filtered.id, cursor: "3", processed: 3, updated: 3, completed: false });
    expect((await counts()).map((row) => row.count)).toEqual([0, 0, 0]);
  });

  it("interrupts the inter-batch pause without starting another batch", async () => {
    await database.update(topic).set({ count: 99 });
    const controller = new AbortController();
    const sleep = vi.spyOn(timerPromises, "setTimeout");
    sleep.mockImplementation(async (_milliseconds, _value, options) => {
      // The real timer adapter receives the same signal that owns the rebuild.
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    syncBuiltinESMExports();
    try {
      const result = await maintenance.rebuild(filtered.id, {
        batchSize: 1, pauseMs: 60_000, signal: controller.signal,
      });
      expect(sleep).toHaveBeenCalledExactlyOnceWith(60_000, undefined, { signal: controller.signal });
      expect(result).toEqual({ id: filtered.id, cursor: "1", completed: false, processed: 1, updated: 1 });
      expect((await counts()).map(({ count }) => count)).toEqual([0, 99, 99]);
    } finally {
      sleep.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await maintenance.rebuild(filtered.id, { after: "1", batchSize: 1, pauseMs: 1 }))
      .toMatchObject({ completed: true, updated: 2, cursor: "3" });
  });


  it("skips the timer at zero delay and propagates a non-cancellation timer failure", async () => {
    const failure = new Error("Timer adapter failed.");
    const sleep = vi.spyOn(timerPromises, "setTimeout").mockRejectedValue(failure);
    syncBuiltinESMExports();
    try {
      await expect(maintenance.rebuild(filtered.id, { batchSize: 1, pauseMs: 0 }))
        .resolves.toMatchObject({ processed: 3, completed: true });
      expect(sleep).not.toHaveBeenCalled();
      await expect(maintenance.rebuild(filtered.id, { batchSize: 1, pauseMs: 1 })).rejects.toBe(failure);
    } finally {
      sleep.mockRestore();
      syncBuiltinESMExports();
    }
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
    let rebuildClient: PoolClient | undefined;
    let rebuilding: Promise<unknown> | undefined;
    try {
      // The rebuild must explicitly use READ COMMITTED even with stricter application defaults.
      rebuildClient = await pool.connect();
      await rebuildClient.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await writer.query("BEGIN");
      await writer.query("INSERT INTO kestrel_counter_test.item (id, topic_id, status) VALUES (1, 1, 'published')");
      const service = new ReferenceCounterMaintenance(drizzle(rebuildClient), [filtered]);
      rebuilding = service.rebuild(filtered.id, { pauseMs: 0 });
      void rebuilding.catch(() => {});
      await waitForLock('SELECT parent."id"::text AS cursor');
      await writer.query("COMMIT");
      await rebuilding;
      expect((await counts())[0]?.count).toBe(1);
    } finally {
      try {
        await writer.query("ROLLBACK");
        await rebuilding;
      } finally {
        writer.release();
        rebuildClient?.release(true);
      }
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
