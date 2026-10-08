import { defineLockAdapter } from "../../adapter_definition.js";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { PostgresLockAdapter, type PostgresLockDatabase } from "./adapter.js";

/** Constructs a backend lazily; injected connections remain borrowed. */
export function postgresLocks(database: RegisteredDependencyDescriptor<PostgresLockDatabase>) {
  return defineLockAdapter({
    dependencies: { database },
    capabilities: { prune: true },
    create: ({ database }) => new PostgresLockAdapter(database),
  });
}
