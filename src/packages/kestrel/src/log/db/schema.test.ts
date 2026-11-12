import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";

import { getFrameworkDatabaseTableKeys } from "../../db/framework_table.js";
import { getDatabaseSchemaContributions } from "../../db/schema_contributions/index.js";
import { logs } from "./schema.js";

it("exports the development log table used by the transport and Studio", () => {
  const { schema, name, columns, indexes } = getTableConfig(logs);
  expect([schema, name]).toEqual(["dev", "log"]);
  expect(columns.map((column) => [column.name, column.getSQLType(), column.notNull])).toEqual([
    ["id", "bigint", true],
    ["logged_at", "timestamp with time zone", true],
    ["level", "integer", true],
    ["message", "text", false],
    ["request_id", "text", false],
    ["payload", "jsonb", true],
    ["created_at", "timestamp with time zone", true],
  ]);
  expect(logs.id).toMatchObject({ primary: true, dataType: "number", generatedIdentity: { type: "always" } });
  expect(logs.loggedAt.dataType).toBe("date");
  expect(logs.createdAt.dataType).toBe("date");
  expect(logs.createdAt.default).toBeInstanceOf(SQL);
  expect(new PgDialect().sqlToQuery(logs.createdAt.default as SQL).sql).toBe("now()");
  expect(indexes.map(({ config }) => config)).toMatchObject([
    { name: "log_logged_at_idx", columns: [{ name: "logged_at" }] },
    { name: "log_level_logged_at_idx", columns: [{ name: "level" }, { name: "logged_at" }] },
  ]);

  // Schema push uses the declaration's ownership marker and PostgreSQL comments.
  expect(getFrameworkDatabaseTableKeys({ logs })).toEqual(new Set(['["dev","log"]']));
  const descriptions = getDatabaseSchemaContributions({ logs }).find(({ id }) => id.endsWith(":descriptions"));
  expect(descriptions?.installSql).toContain('COMMENT ON TABLE "dev"."log"');
  for (const column of columns) {
    expect(descriptions?.installSql).toContain(`COMMENT ON COLUMN "dev"."log"."${column.name}"`);
  }
});
