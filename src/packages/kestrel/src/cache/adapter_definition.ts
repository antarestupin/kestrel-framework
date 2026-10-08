import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { CacheAdapter } from "./types.js";
import type { CacheConfig } from "./configuration.js";

/** Capabilities available during composition, before the backend is constructed. */
export interface CacheAdapterCapabilities {
  readonly prune: boolean;
  readonly tags: boolean;
}
export type CacheAdapterDefinition = AdapterDefinition<CacheAdapter, CacheConfig, CacheAdapterCapabilities>;

/** Defines a backend without coupling it to the application or provider lifecycle. */
export function defineCacheAdapter<const Dependencies extends AdapterDependencies, Value extends CacheAdapter>(
  options: AdapterFactoryOptions<Value, CacheConfig, CacheAdapterCapabilities, Dependencies>,
): CacheAdapterDefinition {
  return defineAdapter(options);
}
