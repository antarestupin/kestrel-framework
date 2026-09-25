import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { applyDatabaseSchemaContributions } from "../../db/schema_contributions/index.js";
import {
  type DatabaseMigrationDefinition,
  migrateDatabase,
} from "../migrator/index.js";
import type { DatabaseResetDefinition } from "./definition.js";

/** Clears declared schemas and reapplies the configured local migrations. */
export async function resetDatabase(
  pool: Pool,
  database: NodePgDatabase<any>,
  definition: DatabaseResetDefinition,
  migration: DatabaseMigrationDefinition,
): Promise<void> {
  await pool.query(createResetSql(definition.schemas));
  await migrateDatabase(database, migration);

  if (definition.push !== undefined) {
    await pushDevelopmentSchema(pool, database, definition.push);
  }
}

/** Quotes identifiers because PostgreSQL cannot parameterize schema names. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Builds the reset transaction from application-owned schema declarations. */
function createResetSql(schemas: readonly string[]): string {
  const statements = schemas.map((schema) =>
    `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE;`
  );

  if (schemas.includes("public")) {
    statements.push("CREATE SCHEMA public;");
  }

  return statements.join("\n");
}

/** Applies local-only schema declarations without an interactive subprocess. */
async function pushDevelopmentSchema(
  pool: Pool,
  database: NodePgDatabase<any>,
  definition: NonNullable<DatabaseResetDefinition["push"]>,
): Promise<void> {
  // Drizzle Kit is a development-only dependency, so load it only when this
  // local maintenance path is actually invoked.
  const { pushSchema } = await import("drizzle-kit/api");
  const push = await pushSchema(
    { ...definition.schema },
    database as Parameters<typeof pushSchema>[1],
    definition.schemaFilter === undefined
      ? undefined
      : [...definition.schemaFilter],
    definition.tablesFilter === undefined
      ? undefined
      : [...definition.tablesFilter],
  );

  await push.apply();
  // Drizzle Push ignores non-enumerable contribution metadata, so replay the
  // desired local-only properties after it has created the development tables.
  await applyDatabaseSchemaContributions(
    definition.schema,
    async (statement) => pool.query(statement),
  );
}
