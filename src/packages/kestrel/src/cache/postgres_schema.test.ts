import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";

import { getFrameworkDatabaseTableKeys } from "../db/framework_table.js";
import { getDatabaseSchemaContributions } from "../db/schema_contributions/index.js";
import { cacheEntries } from "./postgres_schema.js";

it("exports the PostgreSQL cache table with the migration and adapter contracts intact", () => {
  const { name, schema, columns, indexes } = getTableConfig(cacheEntries);
  expect([schema, name]).toEqual(["utils", "cache_entry"]);
  expect(columns.map((column) => [column.name, column.getSQLType(), column.notNull])).toEqual([
    ["key", "text", true],
    ["value", "jsonb", true],
    ["tags", "text[]", true],
    ["expires_at", "timestamp with time zone", true],
    ["created_at", "timestamp with time zone", true],
    ["size_bytes", "integer", true],
  ]);
  expect(cacheEntries.key.primary).toBe(true);
  expect(cacheEntries.expiresAt.dataType).toBe("date");
  expect(cacheEntries.createdAt.dataType).toBe("date");
  expect(cacheEntries.tags.default).toBeInstanceOf(SQL);
  expect(new PgDialect().sqlToQuery(cacheEntries.tags.default as SQL).sql).toBe("ARRAY[]::text[]");
  expect(indexes.map(({ config }) => config)).toMatchObject([
    { name: "cache_entry_expires_at_idx", columns: [{ name: "expires_at" }] },
    { name: "cache_entry_tags_idx", method: "gin", columns: [{ name: "tags" }] },
  ]);

  // These registrations keep generated migrations and schema-push ownership aligned.
  expect(getFrameworkDatabaseTableKeys({ cacheEntries })).toEqual(new Set(['["utils","cache_entry"]']));
  const contributions = getDatabaseSchemaContributions({ cacheEntries });
  expect(contributions).toContainEqual(expect.objectContaining({
    installSql: 'ALTER TABLE "utils"."cache_entry" SET UNLOGGED;',
  }));
  const descriptions = contributions.find((contribution) => contribution.id.endsWith(":descriptions"));
  expect(descriptions?.installSql).toContain('COMMENT ON TABLE "utils"."cache_entry"');
  for (const column of columns) {
    expect(descriptions?.installSql).toContain(`COMMENT ON COLUMN "utils"."cache_entry"."${column.name}"`);
  }
});
