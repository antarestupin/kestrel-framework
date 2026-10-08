import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import type { PostgresDrizzleManager } from "../../../db/index.js";
import { defineAuthenticationAdapter } from "../../adapter_definition.js";
import { PostgresAuthenticationAdapter } from "./adapter.js";
import { authenticationTables } from "./schema.js";
import type { PostgresAuthenticationTables } from "./tables.js";

/** Borrows the current execution's transaction manager. */
export function postgresAuthentication<Claims = unknown>(
  databaseManager: RegisteredDependencyDescriptor<PostgresDrizzleManager>,
  tables: PostgresAuthenticationTables = authenticationTables,
) {
  return defineAuthenticationAdapter({
    dependencies: { databaseManager },
    capabilities: {},
    create: ({ databaseManager }) =>
      new PostgresAuthenticationAdapter<Claims>(databaseManager, tables),
  });
}
