import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import type { PostgresDrizzleManager } from "../../../db/index.js";
import { defineSubjectRoleStorageAdapter } from "../../adapter_definition.js";
import { PostgresSubjectRoleStorageAdapter } from "./store.js";
import { authorizationTables } from "./schema.js";
import type { PostgresAuthorizationTables } from "./tables.js";

/** Borrows the current execution's transaction manager. */
export function postgresSubjectRoles(
  databaseManager: RegisteredDependencyDescriptor<PostgresDrizzleManager>,
  tables: PostgresAuthorizationTables = authorizationTables,
) {
  return defineSubjectRoleStorageAdapter({
    dependencies: { databaseManager },
    capabilities: {},
    create: ({ databaseManager }) => new PostgresSubjectRoleStorageAdapter(databaseManager, tables),
  });
}
