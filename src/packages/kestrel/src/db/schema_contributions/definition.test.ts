import {
  pgSchema,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  defineDatabaseSchemaContribution,
  contributionsEqual,
  getDatabaseSchemaContributions,
} from "./definition.js";
import { defineUnloggedTable } from "./unlogged_table.js";
import { quoteSqlBody } from "../sql_dollar_quote.js";

describe("database schema contributions", () => {
  it("attaches composable metadata without exposing it to Drizzle", () => {
    const target = {};
    defineDatabaseSchemaContribution(target, {
      id: "test:first",
      installSql: "SELECT 1;",
    });
    defineDatabaseSchemaContribution(target, {
      id: "test:second",
      installSql: "SELECT 2;",
    });

    expect(Object.keys(target)).toEqual([]);
    const [metadata] = Object.getOwnPropertySymbols(target);
    expect(Object.getOwnPropertyDescriptor(target, metadata!)).toMatchObject({
      configurable: false, enumerable: false, writable: false,
    });
    expect(getDatabaseSchemaContributions({ target })).toEqual([
      { id: "test:first", installSql: "SELECT 1;" },
      { id: "test:second", installSql: "SELECT 2;" },
    ]);
  });

  it("compares only the complete SQL lifecycle, independent of property order", () => {
    const original = {
      id: "test:equal",
      installSql: "SELECT 1;",
      updateSql: "SELECT 2;",
      uninstallBeforeSql: "SELECT 3;",
      uninstallAfterSql: "SELECT 4;",
    };
    const reordered = {
      uninstallAfterSql: original.uninstallAfterSql,
      uninstallBeforeSql: original.uninstallBeforeSql,
      updateSql: original.updateSql,
      installSql: original.installSql,
      id: original.id,
    };

    // Two exports can describe the same lifecycle with a different object construction order.
    const first = defineDatabaseSchemaContribution({}, original);
    const second = defineDatabaseSchemaContribution({}, reordered);
    expect(getDatabaseSchemaContributions({ first, second })).toEqual([original]);
    for (const property of Object.keys(original) as (keyof typeof original)[]) {
      expect(contributionsEqual(original, { ...original, [property]: "Changed." })).toBe(false);
    }
  });

  it("rejects conflicting stable identifiers across schema exports", () => {
    const first = defineDatabaseSchemaContribution({}, {
      id: "test:duplicate",
      installSql: "SELECT 1;",
    });
    const second = defineDatabaseSchemaContribution({}, {
      id: "test:duplicate",
      installSql: "SELECT 2;",
    });

    expect(() => getDatabaseSchemaContributions({ first, second })).toThrow(
      'Conflicting database schema contribution "test:duplicate".',
    );
  });

  it("rejects duplicate declarations and incomplete lifecycle SQL on a single target", () => {
    const target = {};
    const contribution = { id: "test:unique", installSql: "SELECT 1;" };
    defineDatabaseSchemaContribution(target, contribution);
    expect(() => defineDatabaseSchemaContribution(target, contribution)).toThrow("Duplicate database schema contribution");
    expect(() => defineDatabaseSchemaContribution(target, { ...contribution, id: " " })).toThrow("stable id");
    expect(() => defineDatabaseSchemaContribution(target, { ...contribution, installSql: " " })).toThrow("requires install SQL");
    expect(getDatabaseSchemaContributions({ target, unrelated: null, version: 1 })).toEqual([contribution]);
  });

  it.each([
    [null, "A database schema contribution must be an object."],
    [42, "A database schema contribution must be an object."],
    [{ id: 42, installSql: "SELECT 1;" }, "A database schema contribution requires a stable id."],
    [{ id: "test:invalid", installSql: 42 }, 'Database schema contribution "test:invalid" requires install SQL.'],
    [{ id: "test:invalid", installSql: "SELECT 1;", updateSql: [] },
      'Database schema contribution "test:invalid" requires SQL text for "updateSql".'],
  ] as const)("rejects malformed lifecycle data before attaching it (%j)", (input, diagnostic) => {
    const target = {};
    // JavaScript callers can bypass the TypeScript definition.
    expect(() => defineDatabaseSchemaContribution(target, input as never)).toThrow(diagnostic);
    expect(getDatabaseSchemaContributions({ target })).toEqual([]);
  });

  it("derives the UNLOGGED lifecycle from a PostgreSQL table", () => {
    const schema = pgSchema("storage_test");
    const entries = defineUnloggedTable(schema.table("cache_entry", {
      key: text("key").primaryKey(),
    }));

    expect(getDatabaseSchemaContributions({ entries })).toEqual([
      expect.objectContaining({
        id: "postgres.table:storage_test.cache_entry:unlogged",
        installSql: 'ALTER TABLE "storage_test"."cache_entry" SET UNLOGGED;',
        updateSql: 'ALTER TABLE "storage_test"."cache_entry" SET UNLOGGED;',
      }),
    ]);
  });

  it("chooses an UNLOGGED cleanup delimiter outside the table identifier", () => {
    const table = defineUnloggedTable(pgTable("entry$database_schema$$database_schema_1$", { value: text("value") }));
    const [contribution] = getDatabaseSchemaContributions({ table });
    expect(contribution?.id).toBe("postgres.table:public.entry$database_schema$$database_schema_1$:unlogged");
    expect(contribution?.installSql).toBe('ALTER TABLE "entry$database_schema$$database_schema_1$" SET UNLOGGED;');
    // Both earlier tags occur inside the quoted name and cannot delimit its body.
    expect(contribution?.uninstallAfterSql).toMatch(/^DO \$database_schema_2\$\n[\s\S]+\n\$database_schema_2\$;$/u);
  });

  it("quotes identifiers and regclass literals independently during cleanup", () => {
    const table = defineUnloggedTable(pgSchema('owner\'s "schema"').table('the "table"', { id: text() }));
    const [contribution] = getDatabaseSchemaContributions({ table });
    const identifier = `"owner's ""schema"""."the ""table"""`;
    expect(contribution?.installSql).toBe(`ALTER TABLE ${identifier} SET UNLOGGED;`);
    expect(contribution?.uninstallAfterSql).toContain(`to_regclass('${identifier.replaceAll("'", "''")}')`);
    expect(contribution?.uninstallAfterSql).toContain(`ALTER TABLE ${identifier} SET LOGGED;`);
  });

  it("preserves the normal SQL delimiter and the framework schema names", async () => {
    const { devSchema } = await import("../dev_schema.js");
    const { utilsSchema } = await import("../utils_schema.js");
    expect(quoteSqlBody("SELECT 1;", "migration")).toBe("$migration$\nSELECT 1;\n$migration$");
    expect([devSchema.schemaName, utilsSchema.schemaName]).toEqual(["dev", "utils"]);
    expect(getDatabaseSchemaContributions({ devSchema, utilsSchema }).map(({ installSql }) => installSql)).toEqual([
      `COMMENT ON SCHEMA "dev" IS 'Disposable data used by local-development tools and diagnostics.';`,
      `COMMENT ON SCHEMA "utils" IS 'Reusable operational infrastructure data.';`,
    ]);
  });
});
