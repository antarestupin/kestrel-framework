import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";

import { getFrameworkDatabaseTableKeys } from "../../db/framework_table.js";
import { getDatabaseSchemaContributions } from "../../db/schema_contributions/index.js";
import { observations } from "./schema.js";

it("exports the development observation schema and timeline indexes", () => {
  const { schema, name, columns, indexes } = getTableConfig(observations);
  expect([schema, name]).toEqual(["dev", "observation"]);
  expect(columns.map((column) => [column.name, column.getSQLType(), column.notNull])).toEqual([
    ["sequence", "bigint", true],
    ["id", "uuid", true],
    ["execution_id", "text", true],
    ["occurred_at", "timestamp with time zone", true],
    ["name", "text", true],
    ["category", "text", true],
    ["schema_version", "integer", true],
    ["outcome", "text", false],
    ["duration_ms", "double precision", false],
    ["data", "jsonb", true],
    ["created_at", "timestamp with time zone", true],
  ]);
  expect(observations.sequence).toMatchObject({ primary: true, dataType: "number", generatedIdentity: { type: "always" } });
  expect(observations.occurredAt.dataType).toBe("date");
  expect(observations.createdAt.dataType).toBe("date");
  expect(observations.createdAt.default).toBeInstanceOf(SQL);
  expect(new PgDialect().sqlToQuery(observations.createdAt.default as SQL).sql).toBe("now()");
  expect(indexes.map(({ config }) => config)).toMatchObject([
    { name: "observation_id_idx", unique: true, columns: [{ name: "id" }] },
    {
      name: "observation_execution_timeline_idx",
      columns: [{ name: "execution_id" }, { name: "occurred_at" }, { name: "sequence" }],
    },
    { name: "observation_occurred_at_idx", columns: [{ name: "occurred_at" }] },
    { name: "observation_category_occurred_at_idx", columns: [{ name: "category" }, { name: "occurred_at" }] },
    { name: "observation_name_occurred_at_idx", columns: [{ name: "name" }, { name: "occurred_at" }] },
  ]);

  // Schema push preserves provenance and the descriptions shown in development tooling.
  expect(getFrameworkDatabaseTableKeys({ observations })).toEqual(new Set(['["dev","observation"]']));
  const descriptions = getDatabaseSchemaContributions({ observations }).find(({ id }) => id.endsWith(":descriptions"));
  expect(descriptions?.installSql).toContain('COMMENT ON TABLE "dev"."observation"');
  for (const column of columns) {
    expect(descriptions?.installSql).toContain(`COMMENT ON COLUMN "dev"."observation"."${column.name}"`);
  }
});
