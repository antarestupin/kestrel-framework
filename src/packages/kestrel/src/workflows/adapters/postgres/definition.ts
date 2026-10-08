import { defineWorkflowAdapter } from "../../adapter_definition.js";
import {
  PostgresWorkflowAdapter,
  type PostgresWorkflowAdapterOptions,
  type PostgresWorkflowDatabase,
} from "./adapter.js";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";

/** Declares the activity transport before any storage is instantiated. */
export function postgresWorkflows(
  database: RegisteredDependencyDescriptor<PostgresWorkflowDatabase>,
  settings: PostgresWorkflowAdapterOptions = {},
) {
  // Keep the resolved settings reference; the adapter supplies omitted standalone defaults.
  const activityDispatchMode = settings.activityDispatchMode ?? "embedded";
  return defineWorkflowAdapter({
    dependencies: { database },
    capabilities: { activityDispatchMode },
    create: ({ database }) => new PostgresWorkflowAdapter(database, settings),
  });
}
