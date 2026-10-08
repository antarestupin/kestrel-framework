import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { defineThrottlingAdapter } from "../../adapter_definition.js";
import { PostgresRateLimitAdapter, type PostgresRateLimitDatabase } from "./adapter.js";
import { postgresThrottlingConfigBase, type PostgresThrottlingConfig } from "./configuration.js";
import { DenialCachingRateLimitAdapter } from "../denial_caching/adapter.js";
import { BackendFailureRateLimitAdapter } from "../backend_failure/adapter.js";
import { LeasedRateLimitAdapter } from "../leased/adapter.js";

/** Composes PostgreSQL reservations, failure handling and local lease coordination. */
export function postgresThrottling(
  database: RegisteredDependencyDescriptor<PostgresRateLimitDatabase>,
  settings: PostgresThrottlingConfig = postgresThrottlingConfigBase.schema.parse({}),
) {
  // Resolved settings are retained by reference; only omitted settings need defaults.
  return defineThrottlingAdapter({
    dependencies: { database },
    capabilities: { prune: true },
    create: ({ database }, { config, instrumentation }) => new LeasedRateLimitAdapter(
      new BackendFailureRateLimitAdapter(
        new DenialCachingRateLimitAdapter(new PostgresRateLimitAdapter(database, settings)),
        config.backendFailurePolicy,
      ),
      instrumentation === undefined ? {} : { instrumentation },
    ),
    // Closing the composed adapter returns leases but never closes the borrowed database.
    dispose: (adapter) => adapter.close?.(),
  });
}
