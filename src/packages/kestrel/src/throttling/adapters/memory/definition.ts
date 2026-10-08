import { defineThrottlingAdapter } from "../../adapter_definition.js";
import { MemoryRateLimitAdapter, type MemoryRateLimitAdapterOptions } from "./adapter.js";

/** Process-local reservation state is isolated per application and needs no pruning task. */
export function memoryThrottling(options: MemoryRateLimitAdapterOptions = {}) {
  return defineThrottlingAdapter({
    dependencies: {},
    capabilities: { prune: false },
    create: () => new MemoryRateLimitAdapter(options),
  });
}
