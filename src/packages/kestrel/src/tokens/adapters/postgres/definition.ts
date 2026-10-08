import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import type { PostgresDrizzleManager } from "../../../db/index.js";
import { defineTokenStorageAdapter } from "../../adapter_definition.js";
import { PostgresTokenStorageAdapter } from "./adapter.js";
import { tokenRecords } from "./schema.js";
import type { PostgresTokenTable } from "./tables.js";

/** Borrows the current execution's transaction manager. */
export function postgresTokens(
  databaseManager: RegisteredDependencyDescriptor<PostgresDrizzleManager>,
  tables: PostgresTokenTable = tokenRecords,
) {
  return defineTokenStorageAdapter({
    dependencies: { databaseManager },
    capabilities: {},
    create: ({ databaseManager }) => new PostgresTokenStorageAdapter(databaseManager, tables),
  });
}
