import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  json,
  pgSchema,
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
const schema = {
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

    await manager.database.delete(records).where(eq(records.id, id));

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
      __actor: null,
      __reason: null,
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
});
