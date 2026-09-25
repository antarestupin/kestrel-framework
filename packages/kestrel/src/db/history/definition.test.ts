import { sql, getTableColumns } from "drizzle-orm";
import {
  customType,
  getTableConfig,
  integer,
  pgSchema,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";

import { getDatabaseSchemaContributions } from "../schema_contributions/index.js";
import {
  defineHistoryTable,
  getHistoryTableDefinitions,
} from "./definition.js";

const testSchema = pgSchema("history_definition_test");
const source = testSchema.table("article", {
  id: uuid("id").default(sql`uuidv7()`).primaryKey(),
  revision: serial("revision").notNull(),
  title: text("title").notNull().unique(),
  publishedAt: timestamp("published_at", {
    mode: "date",
    withTimezone: true,
  }),
});
const history = defineHistoryTable(source);

describe("defineHistoryTable", () => {
  it("derives nullable source columns and compact event metadata", () => {
    const config = getTableConfig(history);
    const columns = getTableColumns(history);

    expect(config).toMatchObject({
      name: "article_history",
      schema: "history_definition_test",
    });
    expect(columns.id.notNull).toBe(false);
    expect(columns.id.hasDefault).toBe(false);
    expect(columns.revision.getSQLType()).toBe("integer");
    expect(columns.title.notNull).toBe(false);
    expect(config.foreignKeys).toEqual([]);
    expect(config.uniqueConstraints).toEqual([]);
    expect(config.checks).toHaveLength(1);
    expect(config.indexes).toHaveLength(1);
    expect(config.indexes[0]?.config.columns.map((column) =>
      "name" in column ? column.name : undefined
    ))
      .toEqual(["id", "__sequence"]);
    expect(columns.__sequence.generatedIdentity?.type).toBe("always");
    expect(columns.__operation.notNull).toBe(true);
    expect(columns.__operation.getSQLType()).toBe("smallint");
    expect(columns.__changedColumns.notNull).toBe(true);

    type History = typeof history.$inferSelect;
    expectTypeOf<History["id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<History["revision"]>().toEqualTypeOf<number | null>();
    expectTypeOf<History["publishedAt"]>().toEqualTypeOf<Date | null>();
    expectTypeOf<History["__sequence"]>().toEqualTypeOf<bigint>();
    expectTypeOf<History["__operation"]>()
      .toEqualTypeOf<"insert" | "update" | "delete">();
    expectTypeOf<History["__changedColumns"]>()
      .toEqualTypeOf<Array<"id" | "revision" | "title" | "publishedAt">>();
  });

  it("discovers definitions without adding enumerable schema properties", () => {
    expect(getHistoryTableDefinitions({ source, history })).toEqual([
      expect.objectContaining({
        source,
        table: history,
        identityKeys: ["id"],
      }),
    ]);
    expect(Object.keys(history)).not.toContain("historyTableDefinition");
    expect(getDatabaseSchemaContributions({ history })).toEqual([
      expect.objectContaining({
        id: "postgres.history:history_definition_test.article:article_history",
        installSql: expect.stringContaining("CREATE OR REPLACE FUNCTION"),
        uninstallBeforeSql: expect.stringContaining("DROP TRIGGER IF EXISTS"),
      }),
    ]);
  });

  it("supports an explicit composite identity", () => {
    const compositeSource = pgTable("history_composite_source", {
      tenantId: integer("tenant_id").notNull(),
      recordId: integer("record_id").notNull(),
      value: text("value"),
    });
    const compositeHistory = defineHistoryTable(compositeSource, {
      identity: [compositeSource.tenantId, compositeSource.recordId],
    });
    const [definition] = getHistoryTableDefinitions({ compositeHistory });

    expect(definition?.identityKeys).toEqual(["tenantId", "recordId"]);
  });

  it("rejects missing identities and reserved source columns", () => {
    const noIdentity = pgTable("history_without_identity", {
      value: text("value"),
    });
    const reserved = pgTable("history_reserved", {
      id: integer("id").primaryKey(),
      metadata: text("__metadata"),
    });

    expect(() => defineHistoryTable(noIdentity)).toThrow(
      "requires at least one identity column",
    );
    expect(() => defineHistoryTable(reserved)).toThrow(
      'reserved history prefix "__"',
    );
  });

  it("rejects PostgreSQL types outside the supported matrix", () => {
    const unsupportedType = customType<{ data: string }>({
      dataType: () => "made_up_type",
    });
    const unsupported = pgTable("history_unsupported", {
      id: integer("id").primaryKey(),
      value: unsupportedType("value"),
    });

    expect(() => defineHistoryTable(unsupported)).toThrow(
      'does not support PostgreSQL type "made_up_type"',
    );
  });
});
