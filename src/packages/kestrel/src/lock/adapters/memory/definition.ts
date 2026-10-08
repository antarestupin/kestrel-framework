import { defineLockAdapter } from "../../adapter_definition.js";
import { MemoryLockAdapter, type MemoryLockAdapterOptions } from "./adapter.js";

/** Constructs a backend lazily; injected connections remain borrowed. */
export function memoryLocks(options: MemoryLockAdapterOptions = {}) {
  return defineLockAdapter({
    dependencies: {},
    capabilities: { prune: true },
    create: () => new MemoryLockAdapter(options),
  });
}
