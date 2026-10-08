import { defineCacheAdapter } from "../../adapter_definition.js";
import { MemoryCacheAdapter } from "./adapter.js";
import { memoryCacheConfigBase, type MemoryCacheConfig } from "./configuration.js";

/** Creates isolated bounded storage for each application. */
export function memoryCache(options: Partial<MemoryCacheConfig> = {}) {
  const settings = memoryCacheConfigBase.schema.parse(options);
  return defineCacheAdapter({
    dependencies: {},
    capabilities: { prune: true, tags: true },
    create: (_dependencies, config) => new MemoryCacheAdapter({
      ...settings, maxEntrySizeBytes: config.maxEntrySizeBytes, pruneBatchSize: config.pruneBatchSize,
    }),
  });
}
