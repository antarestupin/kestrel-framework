import { sql, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  bigserial,
  customType,
  getTableConfig,
  integer,
  pgEnum,
  pgSchema,
  pgTable,
  PgDialect,
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
import { getFrameworkDatabaseTableKeys } from "../framework_table.js";
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
    expect(config.checks[0]?.name).toBe("history_definition_test_article_history_operation_check");
    expect(config.indexes[0]?.config.name).toBe("history_definition_test_article_history_identity_sequence_idx");
    expect(config.indexes[0]?.config.columns.map((column) =>
      "name" in column ? column.name : undefined
    ))
      .toEqual(["id", "__sequence"]);
    expect(columns.__sequence.generatedIdentity?.type).toBe("always");
    expect(columns.__sequence.mapFromDriverValue("9007199254740993")).toBe(9_007_199_254_740_993n);
    expect(columns.__operation.notNull).toBe(true);
    expect(columns.__operation.getSQLType()).toBe("smallint");
    for (const [operation, code] of [["insert", 1], ["update", 2], ["delete", 3]] as const) {
      expect(columns.__operation.mapToDriverValue(operation)).toBe(code);
      expect(columns.__operation.mapFromDriverValue(code)).toBe(operation);
    }
    expect(() => columns.__operation.mapFromDriverValue(4)).toThrow('Unknown database history operation code "4"');
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
    const included = defineHistoryTable(source, { include: [source.id, source.title] });
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
    // Spreading a Drizzle table must not also register the copy as a history definition.
    expect(getHistoryTableDefinitions({ copy: { ...history } })).toEqual([]);
    const [definition] = getHistoryTableDefinitions({ history });
    const descriptor = Object.getOwnPropertySymbols(history)
      .map((key) => Object.getOwnPropertyDescriptor(history, key))
      .find((value) => value?.value === definition);
    expect(descriptor).toMatchObject({ configurable: false, enumerable: false, writable: false });
    const [contribution] = getDatabaseSchemaContributions({ history });
    expect(contribution).toMatchObject({
      id: "postgres.history:history_definition_test.article:article_history",
      installSql: expect.stringContaining("CREATE OR REPLACE FUNCTION"),
      uninstallBeforeSql: expect.stringContaining("DROP TRIGGER IF EXISTS"),
    });
    expect(contribution?.installSql).toBe(contribution?.updateSql);
  });

  it("copies existing rows only for the first installation of a public history table", () => {
    const current = pgTable("baseline_history_source", { id: integer().primaryKey() });
    const baseline = defineHistoryTable(current, { baseline: "existing_rows" });
    expect(getTableConfig(baseline).schema).toBeUndefined();
    const [contribution] = getDatabaseSchemaContributions({ baseline });
    expect(contribution?.installSql).toMatch(/^LOCK TABLE "public"\."baseline_history_source" IN SHARE ROW EXCLUSIVE MODE;/u);
    expect(contribution?.updateSql).toMatch(/^CREATE OR REPLACE FUNCTION/u);
  });

  it("keeps reserved history metadata names under Drizzle column casing", () => {
    const query = drizzle.mock({ casing: "snake_case" }).select().from(history).toSQL();
    // PostgreSQL triggers refer to the physical names, including the reserved prefix.
    for (const column of ["__sequence", "__operation", "__changed_columns", "__changed_at", "__actor", "__reason"]) {
      expect(query.sql).toContain(`"${column}"`);
    }
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

  it("retains metadata types and marks only generated tables as framework-owned", () => {
    const unqualifiedSource = pgTable("public_record", { id: integer("id").primaryKey() });
    const unqualifiedHistory = defineHistoryTable(unqualifiedSource, { baseline: "existing_rows" });
    const config = getTableConfig(unqualifiedHistory);
    const columns = getTableColumns(unqualifiedHistory);
    expect(config.schema).toBeUndefined();
    expect(columns.__sequence.name).toBe("__sequence");
    expect(columns.__sequence.mapFromDriverValue("9007199254740993")).toBe(9007199254740993n);
    expect(columns.__operation.name).toBe("__operation");
    expect(columns.__changedAt.getSQLType()).toBe("timestamp with time zone");
    expect(columns.__changedAt.mapFromDriverValue("2026-10-01T10:00:00+02:00")).toEqual(new Date("2026-10-01T08:00:00Z"));
    expect(columns.__actor.name).toBe("__actor");
    expect(columns.__reason.name).toBe("__reason");
    expect(config.indexes[0]?.config.name).toBe("public_record_history_identity_sequence_idx");
    expect(config.checks[0]?.name).toBe("public_record_history_operation_check");
    expect(new PgDialect().sqlToQuery(config.checks[0]!.value).sql).toContain('"__operation" IN (1, 2, 3)');
    expect(getFrameworkDatabaseTableKeys({ unqualifiedSource, unqualifiedHistory })).toEqual(new Set(['["public","public_record_history"]']));

    const [contribution] = getDatabaseSchemaContributions({ unqualifiedHistory });
    expect(contribution?.id).toBe("postgres.history:public.public_record:public_record_history");
    expect(contribution?.installSql).toContain('LOCK TABLE "public"."public_record"');
    expect(contribution?.installSql).toContain("CREATE OR REPLACE FUNCTION");
    expect(contribution?.updateSql).toContain("CREATE OR REPLACE FUNCTION");
    expect(contribution?.updateSql).not.toContain("LOCK TABLE");
    expect(getHistoryTableDefinitions({ unqualifiedHistory, alias: unqualifiedHistory, invalid: 1, absent: null })).toHaveLength(1);
  });

  it("preserves supported PostgreSQL type dimensions and rejects partial type matches", () => {
    // Drizzle custom types may expose these PostgreSQL forms even when it lacks a built-in builder.
    const tableForType = (sqlType: string) => pgTable("typed_history_source", {
      id: integer("id").primaryKey(), value: customType<{ data: string }>({ dataType: () => sqlType })("value"),
    });
    const supported = [
      "smallint", "integer", "bigint", "real", "double precision", "boolean",
      "text", "uuid", "json", "jsonb", "bytea", "date", "inet", "cidr", "macaddr", "macaddr8",
      "character varying(32)", "varchar", "character(2)", "char(1)", "bit(4)", "bit varying(16)",
      "numeric", "numeric(20)", "decimal(20,12)",
      "timestamp", "time", "time(0)", "time with time zone", "timestamp(6) without time zone",
      "interval", "interval(6)", "interval year to month", "interval day to second(4)",
      "text[]", "integer[12]", "varchar(16)[8]", "timestamp(3) with time zone[]",
    ];
    for (const sqlType of supported) {
      expect(getTableColumns(defineHistoryTable(tableForType(sqlType))).value.getSQLType()).toBe(sqlType);
    }

    const unsupported = [
      "text extra", "extra text", "extra varchar", "varchar(1) extra", "varchar()",
      "text[1] extra", "te[1]xt", "timestamp[] with time zone", "integer[bogus]",
      "extra numeric", "numeric(20) extra", "decimal(20,)",
      "extra time", "time(7)", "timestamp(12)", "timestamp with timezone",
      "extra interval", "interval year(9)", "interval day to second()",
    ];
    for (const sqlType of unsupported) {
      expect(() => defineHistoryTable(tableForType(sqlType))).toThrow(`does not support PostgreSQL type "${sqlType}"`);
    }
  });

  it("keeps managed index and constraint names distinct within PostgreSQL's byte limit", () => {
    const longPrefix = "é".repeat(29);
    const create = (suffix: string) => getTableConfig(defineHistoryTable(source, { name: `${longPrefix}${suffix}` }));
    const first = create("a");
    const second = create("b");
    const names = [first.indexes[0]!.config.name!, first.checks[0]!.name,
      second.indexes[0]!.config.name!, second.checks[0]!.name];
    expect(new Set(names).size).toBe(4);
    expect(names.every((name) => Buffer.byteLength(name, "utf8") <= 63)).toBe(true);
    expect(names[0]).toBe(create("a").indexes[0]?.config.name);
  });
});
