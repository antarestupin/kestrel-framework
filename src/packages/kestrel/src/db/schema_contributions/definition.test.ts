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
  getDatabaseSchemaContributions,
} from "./definition.js";
import { defineUnloggedTable } from "./unlogged_table.js";

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
    expect(getDatabaseSchemaContributions({ target })).toEqual([
      { id: "test:first", installSql: "SELECT 1;" },
      { id: "test:second", installSql: "SELECT 2;" },
    ]);
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

  it("derives the UNLOGGED lifecycle from a PostgreSQL table", () => {
    const schema = pgSchema("storage_test");
    const entries = defineUnloggedTable(schema.table("cache_entry", {
      key: text("key").primaryKey(),
    }));

    expect(getDatabaseSchemaContributions({ entries })).toEqual([
      expect.objectContaining({
        id: "postgres.table:storage_test.cache_entry:unlogged",
        installSql: 'ALTER TABLE "storage_test"."cache_entry" SET UNLOGGED;',
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
});
