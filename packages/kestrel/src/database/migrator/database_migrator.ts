import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export interface DatabaseMigrationDefinition {
  readonly migrationsFolder: string;
}

/** Applies every versioned Drizzle migration, including generated custom SQL. */
export async function migrateDatabase(
  database: NodePgDatabase<any>,
  definition: DatabaseMigrationDefinition,
): Promise<void> {
  await migrate(database, {
    migrationsFolder: definition.migrationsFolder,
  });
}
