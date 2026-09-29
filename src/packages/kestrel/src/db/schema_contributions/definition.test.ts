import {
  pgSchema,
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
});
