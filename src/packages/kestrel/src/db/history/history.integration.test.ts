import { readHistoryPage } from "./reader.js";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  integer,
  json,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { createPostgresTestPool } from "../../testing/postgres.js";
import { PostgresDrizzleManager } from "../database_manager.js";
import { runWithHistoryContext } from "./context.js";
import {
  defineHistoryTable,
  getHistoryTableDefinitions,
} from "./definition.js";
import {
  createHistoryBaselineSql,
  createHistoryTriggerRemovalSql,
  createHistoryTriggerSql,
} from "./trigger_sql.js";

const historySchema = pgSchema("kestrel_history_test");
const records = historySchema.table("record", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  metadata: json("metadata").$type<{ category: string }>(),
  updatedAt: timestamp("updated_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});
const recordHistory = defineHistoryTable(records);
const existingRecords = historySchema.table("existing_record", {
  id: uuid("id").primaryKey(),
  value: text("value").notNull(),
});
const existingRecordHistory = defineHistoryTable(existingRecords, {
  baseline: "existing_rows",
});
// Two audit tables exercise both public selection modes against real triggers.
const selectedRecords = historySchema.table("selected_record", {
  id: uuid("id").primaryKey(), value: text("value"), count: integer("count"),
});
const includedHistory = defineHistoryTable(selectedRecords, {
  name: "included_history", include: [selectedRecords.value], baseline: "existing_rows",
});
const excludedHistory = defineHistoryTable(selectedRecords, {
  name: "excluded_history", exclude: [selectedRecords.count], baseline: "existing_rows",
});
const schema = {
  selectedRecords, includedHistory,
  records,
  recordHistory,
  existingRecords,
  existingRecordHistory,
};

let pool: Pool;

beforeAll(async () => {
  pool = createPostgresTestPool();
  await pool.query(`
    DROP SCHEMA IF EXISTS kestrel_history_test CASCADE;
    CREATE SCHEMA kestrel_history_test;
    CREATE TABLE kestrel_history_test.record (
      id uuid PRIMARY KEY,
      title text NOT NULL,
      content text,
      metadata json,
      updated_at timestamp with time zone NOT NULL
    );
    CREATE TABLE kestrel_history_test.record_history (
      id uuid,
      title text,
      content text,
      metadata json,
      updated_at timestamp with time zone,
      __sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      __operation smallint NOT NULL,
      __changed_columns text[] NOT NULL,
      __changed_at timestamp with time zone NOT NULL,
      __actor text,
      __reason text
    );
    CREATE TABLE kestrel_history_test.existing_record (
      id uuid PRIMARY KEY,
      value text NOT NULL
    );
    CREATE TABLE kestrel_history_test.existing_record_history (
      id uuid,
      value text,
      __sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      __operation smallint NOT NULL,
      __changed_columns text[] NOT NULL,
      __changed_at timestamp with time zone NOT NULL,
      __actor text,
      __reason text
    );
    CREATE TABLE kestrel_history_test.selected_record (id uuid PRIMARY KEY, value text, count integer);
    CREATE TABLE kestrel_history_test.included_history (
      id uuid, value text, __sequence bigint GENERATED ALWAYS AS IDENTITY,
      __operation smallint NOT NULL, __changed_columns text[] NOT NULL,
      __changed_at timestamptz NOT NULL, __actor text, __reason text
    );
    CREATE TABLE kestrel_history_test.excluded_history (LIKE kestrel_history_test.included_history INCLUDING ALL);
    INSERT INTO kestrel_history_test.selected_record VALUES ('ac3ddc0d-f5db-4a63-8518-d4a462f0bdd4', 'Baseline', 0);
    INSERT INTO kestrel_history_test.existing_record (id, value)
    VALUES ('ec3ddc0d-f5db-4a63-8518-d4a462f0bdd4', 'Predates history');
  `);
  for (const definition of getHistoryTableDefinitions(schema)) {
    const baselineSql = createHistoryBaselineSql(definition);
    if (baselineSql !== undefined) {
      await pool.query(baselineSql);
    }
    await pool.query(createHistoryTriggerSql(definition));
  }
});

afterAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS kestrel_history_test CASCADE;");
  await pool.end();
});

describe("database history", () => {
  it.each(["record$history$", "record%"])("installs triggers for quoted source name %s", async (name) => {
    const source = historySchema.table(name, { id: integer("id").primaryKey(), value: text("value") });
    const history = defineHistoryTable(source, { name: "quoted_record_history" });
    const [definition] = getHistoryTableDefinitions({ history });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // These fixed test names are valid identifiers but special inside a PL/pgSQL body.
      await client.query(`CREATE TABLE kestrel_history_test."${name}" (id integer PRIMARY KEY, value text)`);
      await client.query(`CREATE TABLE kestrel_history_test.quoted_record_history (
        id integer, value text, __sequence bigint GENERATED ALWAYS AS IDENTITY,
        __operation smallint, __changed_columns text[], __changed_at timestamptz, __actor text, __reason text
      )`);
      await client.query(createHistoryTriggerSql(definition!));

      const database = drizzle(client);
      await database.insert(source).values({ id: 1, value: "recorded" });
      expect(await database.select().from(history)).toEqual([
        expect.objectContaining({ id: 1, value: "recorded", __operation: "insert" }),
      ]);
      await expect(database.update(source).set({ id: 2 }).where(eq(source.id, 1)))
        .rejects.toMatchObject({ cause: { message: `History identity columns of ${name} are immutable` } });
    } finally {
      try { await client.query("ROLLBACK"); }
      finally { client.release(); }
    }
  });

  it("keeps histories distinct for source names with a common multi-byte prefix", async () => {
    const prefix = "é".repeat(28);
    const sources = [`${prefix}a`, `${prefix}b`].map((name) =>
      historySchema.table(name, { id: integer("id").primaryKey(), value: text("value") }));
    const histories = sources.map((source, index) => defineHistoryTable(source, { name: `wide_audit_${index}` }));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Each source name fits PostgreSQL's byte budget. Their generated function names need shortening.
      for (const [index, source] of sources.entries()) {
        const history = histories[index]!;
        const [definition] = getHistoryTableDefinitions({ history });
        await client.query(`CREATE TABLE kestrel_history_test."${prefix}${index === 0 ? "a" : "b"}" (id integer PRIMARY KEY, value text)`);
        await client.query(`CREATE TABLE kestrel_history_test."wide_audit_${index}" (
          id integer, value text, __sequence bigint GENERATED ALWAYS AS IDENTITY,
          __operation smallint, __changed_columns text[], __changed_at timestamptz, __actor text, __reason text
        )`);
        expect(definition?.source).toBe(source);
        await client.query(createHistoryTriggerSql(definition!));
      }

      const database = drizzle(client);
      await database.insert(sources[0]!).values({ id: 1, value: "first source" });
      await database.insert(sources[1]!).values({ id: 2, value: "second source" });
      for (const [index, history] of histories.entries()) {
        expect(await database.select({ id: history.id }).from(history)).toEqual([{ id: index + 1 }]);
      }
    } finally {
      try { await client.query("ROLLBACK"); }
      finally { client.release(); }
    }
  });

  it("reads real sparse events across stable cursor pages with explicit null and deletion", async () => {
    const database = drizzle(pool);
    const id = crypto.randomUUID();
    await database.insert(records).values({ id, title: "First", content: "Original", updatedAt: new Date() });
    await database.update(records).set({ content: null }).where(eq(records.id, id));
    await database.delete(records).where(eq(records.id, id));
    const request = { identity: { id }, fields: ["title", "content"], pageSize: 2 };
    const latest = await readHistoryPage(database, recordHistory, request);
    expect(latest.events.map((event) => event.operation)).toEqual(["delete", "update"]);
    expect(latest.events.map((event) => event.values)).toEqual([{}, { content: null }]);
    expect(latest.nextCursor).not.toBeNull();
    const older = await readHistoryPage(database, recordHistory, { ...request, before: latest.nextCursor! });
    expect(older.events.map((event) => event.values)).toEqual([{ title: "First", content: "Original" }]);
    expect(older.nextCursor).toBeNull();
  });

  it("ignores counter-only updates but records tracked changes, nulls and deletions", async () => {
    for (const history of [includedHistory, excludedHistory]) {
      const [definition] = getHistoryTableDefinitions({ history });
      // Replace the source triggers when switching from include to exclude mode.
      await pool.query(createHistoryTriggerSql(definition!));
      const database = drizzle(pool);
      const id = crypto.randomUUID();
      await database.insert(selectedRecords).values({ id, value: "Initial", count: 0 });
      await database.update(selectedRecords).set({ count: 1 }).where(eq(selectedRecords.id, id));
      expect(await database.select().from(history).where(eq(history.id, id))).toHaveLength(1);
      await database.update(selectedRecords).set({ count: 2, value: null }).where(eq(selectedRecords.id, id));
      await database.delete(selectedRecords).where(eq(selectedRecords.id, id));
      const events = await database.select().from(history).where(eq(history.id, id)).orderBy(asc(history.__sequence));
      expect(events.map(event => event.__operation)).toEqual(["insert", "update", "delete"]);
      expect(events[1]).toMatchObject({ value: null, __changedColumns: ["value"] });
    }
    const database = drizzle(pool);
    expect((await database.select().from(includedHistory)).find(event => event.value === "Baseline"))
      .toMatchObject({ __changedColumns: ["id", "value"] });
  });

  it("copies existing rows when a baseline is requested", async () => {
    const database = drizzle(pool, { schema });
    const events = await database.select().from(existingRecordHistory);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "ec3ddc0d-f5db-4a63-8518-d4a462f0bdd4",
      value: "Predates history",
      __operation: "insert",
      __changedColumns: ["id", "value"],
      __actor: null,
      __reason: null,
    });
  });

  it("stores a complete creation followed by sparse changes and deletion", async () => {
    const database = drizzle(pool, { schema });
    const manager = new PostgresDrizzleManager({ database });
    const id = "4a6624b8-0dda-4df0-83fb-acebc14ed09c";
    const initialDate = new Date("2026-08-27T10:00:00.000Z");
    const updatedDate = new Date("2026-08-27T11:00:00.000Z");

    await runWithHistoryContext(manager, {
      actor: "member:first",
      reason: "Create the record",
    }, () => manager.database.insert(records).values({
      id,
      title: "Initial title",
      content: "Initial content",
      metadata: { category: "initial" },
      updatedAt: initialDate,
    }));

    await runWithHistoryContext(manager, {
      actor: "member:second",
      reason: "Clear obsolete content",
    }, () => manager.database.update(records).set({
      content: null,
      metadata: { category: "updated" },
      updatedAt: updatedDate,
    }).where(eq(records.id, id)));

    // PostgreSQL fires the UPDATE trigger, but the function skips the event
    // after comparing every source column.
    await manager.database.update(records)
      .set({ title: "Initial title" })
      .where(eq(records.id, id));

    await runWithHistoryContext(manager, { actor: "member:third", reason: "Remove the record" }, () =>
      manager.database.delete(records).where(eq(records.id, id))
    );

    const events = await database.select()
      .from(recordHistory)
      .where(eq(recordHistory.id, id))
      .orderBy(asc(recordHistory.__sequence));

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      id,
      title: "Initial title",
      content: "Initial content",
      metadata: { category: "initial" },
      updatedAt: initialDate,
      __operation: "insert",
      __changedColumns: ["id", "title", "content", "metadata", "updatedAt"],
      __actor: "member:first",
      __reason: "Create the record",
    });
    expect(events[1]).toMatchObject({
      id,
      title: null,
      content: null,
      metadata: { category: "updated" },
      updatedAt: updatedDate,
      __operation: "update",
      __changedColumns: ["content", "metadata", "updatedAt"],
      __actor: "member:second",
      __reason: "Clear obsolete content",
    });
    expect(events[2]).toMatchObject({
      id,
      title: null,
      content: null,
      metadata: null,
      updatedAt: null,
      __operation: "delete",
      __changedColumns: [],
      __actor: "member:third",
      __reason: "Remove the record",
    });
  });

  it("rejects identity changes without adding a history event", async () => {
    const database = drizzle(pool, { schema });
    const originalId = "df54cacb-b174-4221-bd42-b1b310cb4ce9";
    await database.insert(records).values({
      id: originalId,
      title: "Stable identity",
      updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    });

    try {
      await database.update(records).set({
        id: "2be6aefd-9853-498a-b8f0-ff9dfc8182bc",
      }).where(eq(records.id, originalId));
      expect.fail("Expected the identity update to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { cause?: Error }).cause?.message).toContain(
        "History identity columns of record are immutable",
      );
    }

    await expect(database.select().from(recordHistory)
      .where(eq(recordHistory.id, originalId))).resolves.toHaveLength(1);
  });

  it("restores a parent history context after a nested operation", async () => {
    const database = drizzle(pool, { schema });
    const manager = new PostgresDrizzleManager({ database });
    const firstId = "5bb56828-0b7d-41e9-a94e-7c3375bbbd6b";
    const nestedId = "120ee5eb-a75e-451f-826d-1821d36e16fc";
    const lastId = "ca9268f0-109b-49a5-b038-a2f979431921";
    const updatedAt = new Date("2026-08-27T13:00:00.000Z");

    await runWithHistoryContext(manager, { actor: "outer" }, async () => {
      await manager.database.insert(records).values({
        id: firstId,
        title: "First outer event",
        updatedAt,
      });
      await runWithHistoryContext(manager, { actor: "nested" }, () =>
        manager.database.insert(records).values({
          id: nestedId,
          title: "Nested event",
          updatedAt,
        })
      );
      await manager.database.insert(records).values({
        id: lastId,
        title: "Last outer event",
        updatedAt,
      });
    });

    const events = await database.select({
      id: recordHistory.id,
      actor: recordHistory.__actor,
    }).from(recordHistory)
      .where(eq(recordHistory.__operation, "insert"));
    const actors = new Map(events.map((event) => [event.id, event.actor]));

    expect(actors.get(firstId)).toBe("outer");
    expect(actors.get(nestedId)).toBe("nested");
    expect(actors.get(lastId)).toBe("outer");
  });

  it("clears omitted nested metadata and restores the parent when the operation throws", async () => {
    const database = drizzle(pool, { schema });
    const manager = new PostgresDrizzleManager({ database });
    const nestedId = "d4e97f0c-117b-4da9-8c4b-d983b295c498";
    const lastId = "99bda09f-53e0-45f9-8039-6dd504cae167";
    const updatedAt = new Date("2026-08-27T13:00:00.000Z");
    const failure = new Error("Nested operation failed.");

    // The nested scope joins the same transaction, so a caught application error
    // leaves both inserts available while the outer history metadata is restored.
    await runWithHistoryContext(manager, { actor: "outer", reason: "review" }, async () => {
      await expect(runWithHistoryContext(manager, {}, async () => {
        await manager.database.insert(records).values({ id: nestedId, title: "Nested event", updatedAt });
        throw failure;
      })).rejects.toBe(failure);
      await manager.database.insert(records).values({ id: lastId, title: "Last outer event", updatedAt });
    });

    const events = await database.select({ id: recordHistory.id, actor: recordHistory.__actor, reason: recordHistory.__reason })
      .from(recordHistory);
    expect(events.find((event) => event.id === nestedId)).toEqual({ id: nestedId, actor: null, reason: null });
    expect(events.find((event) => event.id === lastId)).toEqual({ id: lastId, actor: "outer", reason: "review" });
  });

  it("keeps default-schema audit writes on their declared table when search_path changes", async () => {
    const source = pgTable("kestrel_history_path_record", { id: integer("id").primaryKey() });
    const history = defineHistoryTable(source);
    const [definition] = getHistoryTableDefinitions({ history });
    const client = await pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL search_path = public");
      await client.query(`
        CREATE TABLE public.kestrel_history_path_record (id integer PRIMARY KEY);
        CREATE TABLE public.kestrel_history_path_record_history (
          id integer, __operation smallint, __changed_columns text[], __changed_at timestamptz, __actor text, __reason text
        );
        CREATE TABLE kestrel_history_test.kestrel_history_path_record_history
          (LIKE public.kestrel_history_path_record_history);
      `);
      await client.query(createHistoryTriggerSql(definition!));

      // A tenant-specific search path may contain a table with the same name.
      await client.query("SET LOCAL search_path = kestrel_history_test, public");
      await client.query("INSERT INTO public.kestrel_history_path_record (id) VALUES (1)");
      const audit = await client.query("SELECT id FROM public.kestrel_history_path_record_history");
      const shadow = await client.query("SELECT id FROM kestrel_history_test.kestrel_history_path_record_history");
      expect(audit.rows).toEqual([{ id: 1 }]);
      expect(shadow.rows).toEqual([]);

      const trigger = await client.query<{ function_id: string }>(`SELECT tgfoid::text AS function_id
        FROM pg_trigger WHERE tgrelid = 'public.kestrel_history_path_record'::regclass AND tgname = '__history_insert'`);
      expect(trigger.rows).toHaveLength(1);
      await client.query(createHistoryTriggerRemovalSql(definition!));
      await client.query("INSERT INTO public.kestrel_history_path_record (id) VALUES (2)");
      expect((await client.query("SELECT id FROM public.kestrel_history_path_record_history")).rows).toEqual([{ id: 1 }]);
      expect((await client.query("SELECT oid FROM pg_proc WHERE oid = $1", [trigger.rows[0]!.function_id])).rows).toEqual([]);
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  });
});
