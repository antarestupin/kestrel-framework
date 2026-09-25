import { getDatabaseSchemaContributions } from "./definition.js";

/** Executes declarative schema contributions against objects already created by a local Drizzle push. */
export async function applyDatabaseSchemaContributions(
  schema: Readonly<Record<string, unknown>>,
  execute: (sql: string) => Promise<unknown>,
): Promise<void> {
  for (const contribution of getDatabaseSchemaContributions(schema)) {
    await execute(contribution.installSql);
  }
}
