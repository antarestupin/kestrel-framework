import { sql, getTableColumns } from "drizzle-orm";
import {
  bigserial,
  customType,
  getTableConfig,
  integer,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  serial,
  smallserial,
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

  it("filters tracked columns and preserves inferred identity and result types", () => {
    const excluded = defineHistoryTable(source, { exclude: [source.revision] });
    const included = defineHistoryTable(source, { include: [source.title] });
    const identityOnly = defineHistoryTable(source, { include: [] });
    expect(Object.keys(getTableColumns(excluded))).not.toContain("revision");
    expect(Object.keys(getTableColumns(included)).filter(key => !key.startsWith("__")))
      .toEqual(["id", "title"]);
    expect(Object.keys(getTableColumns(identityOnly)).filter(key => !key.startsWith("__")))
      .toEqual(["id"]);
    expectTypeOf<keyof typeof included.$inferSelect>()
      .toEqualTypeOf<"id" | "title" | "__sequence" | "__operation" | "__changedColumns" | "__changedAt" | "__actor" | "__reason">();
    expectTypeOf<typeof included.$inferSelect.__changedColumns>()
      .toEqualTypeOf<Array<"id" | "title">>();
    expectTypeOf<keyof typeof excluded.$inferSelect>()
      .toEqualTypeOf<Exclude<keyof typeof history.$inferSelect, "revision">>();
    const composite = pgTable("selected_composite", {
      tenant: integer("tenant"), record: integer("record"), value: text("value"),
    });
    const selected = defineHistoryTable(composite, {
      identity: [composite.tenant, composite.record], include: [],
    });
    expect(Object.keys(getTableColumns(selected)).filter(key => !key.startsWith("__")))
      .toEqual(["tenant", "record"]);
  });

  it("rejects conflicting selection, foreign columns and excluded identities", () => {
    // Untyped callers must receive the same mutual-exclusion guarantee.
    expect(() => defineHistoryTable(source, {
      include: [source.title],
      // @ts-expect-error The selection modes are mutually exclusive.
      exclude: [source.revision],
    })).toThrow("cannot be used together");
    const other = pgTable("other_history_source", { id: uuid("id").primaryKey() });
    expect(() => defineHistoryTable(source, {
      include: [other.id] as unknown as [typeof source.id],
    })).toThrow("must belong to the source table");
    expect(() => defineHistoryTable(source, { exclude: [source.id] }))
      .toThrow("identity columns cannot be excluded");
    expect(() => defineHistoryTable(source, { include: source.title } as never))
      .toThrow("column selection must be an array");
    expect(() => defineHistoryTable(source, { identity: [other.id] as unknown as [typeof source.id] }))
      .toThrow("identity column must belong to the source table");
    expect(() => defineHistoryTable(source, { identity: [source.id, source.id] }))
      .toThrow("identity columns must be unique");
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

  it("infers table-level composite identities in declared primary-key order", () => {
    const composite = pgTable("history_composite_source", {
      tenantId: integer("tenant_id").notNull(), recordId: integer("record_id").notNull(),
    }, (row) => [primaryKey({ columns: [row.recordId, row.tenantId] })]);

    const derived = defineHistoryTable(composite);
    const [definition] = getHistoryTableDefinitions({ derived });
    expect(definition?.identityKeys).toEqual(["recordId", "tenantId"]);
    expect(getTableConfig(derived).indexes[0]?.config.columns.map((column) =>
      "name" in column ? column.name : undefined)).toEqual(["record_id", "tenant_id", "__sequence"]);
  });

  it("rejects missing identities and reserved source columns", () => {
    const noIdentity = pgTable("history_without_identity", {
      value: text("value"),
    });
    const reserved = pgTable("history_reserved", {
      id: integer("id").primaryKey(),
      metadata: text("__metadata"),
    });
    const reservedProperty = pgTable("history_reserved_property", {
      id: integer("id").primaryKey(), __metadata: text("metadata"),
    });

    expect(() => defineHistoryTable(noIdentity)).toThrow(
      "requires at least one identity column",
    );
    expect(() => defineHistoryTable(reserved)).toThrow(
      'reserved history prefix "__"',
    );
    expect(() => defineHistoryTable(reservedProperty)).toThrow('Source property "__metadata"');
  });

  it("preserves enum names and serial widths without copying identity defaults", () => {
    const status = pgEnum('default"status', ["ready", "done"]);
    const namedStatus = testSchema.enum('qualified"status', ["ready", "done"]);
    const source = pgTable("history_enum_source", {
      id: smallserial("id").primaryKey(),
      revision: bigserial("revision", { mode: "bigint" }).notNull(),
      state: status("state"),
      namedState: namedStatus("named_state"),
    });
    const columns = getTableColumns(defineHistoryTable(source));

    expect(columns.id.getSQLType()).toBe("smallint");
    expect(columns.revision.getSQLType()).toBe("bigint");
    expect(columns.id.hasDefault).toBe(false);
    expect(columns.revision.hasDefault).toBe(false);
    expect(columns.state.getSQLType()).toBe('"default""status"');
    expect(columns.namedState.getSQLType()).toBe('"history_definition_test"."qualified""status"');
  });

  it("preserves the compact operation encoding and rejects corrupt event codes", () => {
    const operation = getTableColumns(history).__operation;
    // Old history rows depend on these codes remaining stable across migrations.
    expect(operation.mapToDriverValue("update")).toBe(2);
    expect(operation.mapToDriverValue("delete")).toBe(3);
    expect(() => operation.mapFromDriverValue(9)).toThrow('Unknown database history operation code "9"');
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
