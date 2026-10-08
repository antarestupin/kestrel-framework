import { defineScheduledTaskAdapter } from "../../adapter_definition.js";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { PostgresScheduledTaskAdapter, type PostgresScheduledTaskDatabase } from "./adapter.js";

/** Constructs a backend lazily; injected connections remain borrowed. */
export function postgresScheduledTasks(
  database: RegisteredDependencyDescriptor<PostgresScheduledTaskDatabase>,
) {
  return defineScheduledTaskAdapter({
    dependencies: { database },
    capabilities: {},
    create: ({ database }) => new PostgresScheduledTaskAdapter(database),
  });
}
