import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { defineCacheAdapter } from "../../adapter_definition.js";
import { RedisCacheAdapter, type RedisCacheClient } from "./adapter.js";
import { redisCacheConfigBase, type RedisCacheConfig } from "./configuration.js";

/** Borrows a shared connection and constructs one adapter per application. */
export function redisCache(
  connection: RegisteredDependencyDescriptor<RedisCacheClient>,
  settings: RedisCacheConfig = redisCacheConfigBase.schema.parse({}),
) {
  // Resolved settings are retained by reference; only omitted settings need defaults.
  return defineCacheAdapter({
    dependencies: { connection: connection },
    capabilities: { prune: false, tags: false },
    create: ({ connection }, config) => new RedisCacheAdapter(connection, {
      keyPrefix: settings.keyPrefix,
      maxEntrySizeBytes: config.maxEntrySizeBytes,
    }),
  });
}
