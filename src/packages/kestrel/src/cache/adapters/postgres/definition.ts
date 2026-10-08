import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { defineCacheAdapter } from "../../adapter_definition.js";
import { PostgresCacheAdapter, type PostgresCacheDatabase } from "./adapter.js";
import { postgresCacheConfigBase, type PostgresCacheConfig } from "./configuration.js";

/** Borrows a shared connection and constructs one adapter per application. */
export function postgresCache(
  database: RegisteredDependencyDescriptor<PostgresCacheDatabase>,
  settings: PostgresCacheConfig = postgresCacheConfigBase.schema.parse({}),
) {
  // Resolved settings are retained by reference; only omitted settings need defaults.
  return defineCacheAdapter({
    dependencies: { connection: database },
    capabilities: { prune: true, tags: true },
    create: ({ connection }, config) => new PostgresCacheAdapter(connection, {
      maxEntries: settings.maxEntries, defaultPruneLimit: config.pruneBatchSize,
      maxEntrySizeBytes: config.maxEntrySizeBytes,
    }),
  });
}
