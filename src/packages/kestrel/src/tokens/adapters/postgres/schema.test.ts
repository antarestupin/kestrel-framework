import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, pgSchema, PgDialect } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";
import { expect, it, vi } from "vitest";

import { getFrameworkDatabaseTableKeys } from "../../../db/framework_table.js";
import { PostgresDrizzleManager } from "../../../db/index.js";
import { getDatabaseSchemaContributions } from "../../../db/schema_contributions/definition.js";
import { createDependencyContainer, dep } from "../../../di/index.js";
import { postgresTokens } from "./definition.js";
import { createPostgresTokenTable, tokenRecords, tokensSqlSchema } from "./schema.js";

it("declares the production token row and its migration metadata", () => {
  const { schema, name, columns } = getTableConfig(tokenRecords);
  expect(tokensSqlSchema.schemaName).toBe("tokens");
  expect({ schema, name }).toEqual({ schema: "tokens", name: "token" });
  expect(columns.map((column) => [column.name, column.getSQLType(), column.notNull])).toEqual([
    ["id", "uuid", true],
    ["definition", "text", true],
    ["subject", "text", false],
    ["subject_exclusive", "boolean", true],
    ["digest", "bytea", true],
    ["payload", "jsonb", true],
    ["expires_at", "timestamp with time zone", true],
    ["consumed_at", "timestamp with time zone", false],
    ["revoked_at", "timestamp with time zone", false],
    ["created_at", "timestamp with time zone", true],
  ]);
  expect(tokenRecords.id.primary).toBe(true);
  expect(tokenRecords.subjectExclusive.default).toBe(false);
  for (const column of [tokenRecords.expiresAt, tokenRecords.consumedAt, tokenRecords.revokedAt, tokenRecords.createdAt]) {
    expect(column.mapFromDriverValue("2026-01-01T00:00:00.000Z")).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  }

  const exports = { tokensSqlSchema, tokenRecords };
  expect(getFrameworkDatabaseTableKeys(exports)).toEqual(new Set(['["tokens","token"]']));
  const contributions = getDatabaseSchemaContributions(exports);
  expect(contributions.find(({ id }) => id === "postgres.schema:tokens:description")?.installSql)
    .toContain('COMMENT ON SCHEMA "tokens" IS ');
  const table = contributions.find(({ id }) => id === "postgres.table:tokens.token:descriptions");
  expect(table?.installSql).toContain('COMMENT ON TABLE "tokens"."token" IS ');
  for (const column of columns) {
    expect(table?.installSql).toContain(`COMMENT ON COLUMN "tokens"."token"."${column.name}" IS `);
  }
});

it("keeps migration indexes and checks scoped to the declared schema and name", () => {
  const { indexes, checks } = getTableConfig(tokenRecords);
  const dialect = new PgDialect();
  expect(indexes.map(({ config }) => [
    config.name, config.unique, config.columns.map((column) => "name" in column ? column.name : undefined),
  ])).toEqual([
    ["tokens_token_digest_unique", true, ["digest"]],
    ["tokens_token_definition_subject_idx", false, ["definition", "subject"]],
    ["tokens_token_active_subject_unique", true, ["definition", "subject"]],
    ["tokens_token_expiry_idx", false, ["expires_at"]],
    ["tokens_token_consumed_idx", false, ["consumed_at"]],
    ["tokens_token_revoked_idx", false, ["revoked_at"]],
  ]);
  expect(dialect.sqlToQuery(indexes[2]!.config.where!).sql).toBe(
    '"tokens"."token"."subject_exclusive" and "tokens"."token"."consumed_at" is null and "tokens"."token"."revoked_at" is null',
  );
  expect(checks[0]?.name).toBe("tokens_token_exclusive_subject_check");
  expect(dialect.sqlToQuery(checks[0]!.value).sql).toBe(
    'not "tokens"."token"."subject_exclusive" or "tokens"."token"."subject" is not null',
  );

  const dedicated = getTableConfig(createPostgresTokenTable(pgSchema("invitation"), {
    tableName: "member_token", indexPrefix: "member_custom",
  }));
  expect(dedicated.schema).toBe("invitation");
  expect(dedicated.name).toBe("member_token");
  expect(dedicated.indexes[0]?.config.name).toBe("member_custom_digest_unique");
});

it("defaults the PostgreSQL adapter recipe to the shared production table", async () => {
  const container = createDependencyContainer({});
  const query = vi.fn(async (_query: unknown, _parameters: unknown[]) => ({ rows: [] }));
  const database = drizzle({ query } as unknown as PoolClient);
  const manager = new PostgresDrizzleManager({
    database: database as ConstructorParameters<typeof PostgresDrizzleManager>[0]["database"],
  });
  const dependency = dep<PostgresDrizzleManager>("borrowedDatabase");
  container.registerValue(dependency.id, manager);

  try {
    const adapter = postgresTokens(dependency).create((descriptor) => container.resolve(descriptor), undefined);
    await expect(adapter.findValid({ definition: "invitation", digest: Buffer.from("digest"), now: new Date(0) }))
      .resolves.toBeUndefined();
    // The real Drizzle session exposes the selected schema and table without a live connection.
    expect(query.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('from "tokens"."token"') });
  } finally {
    await container.dispose();
  }
});
