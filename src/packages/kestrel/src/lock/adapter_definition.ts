import {
  defineAdapter,
  type AdapterDependencies,
  type AdapterFactoryOptions,
  type AdapterDefinition,
} from "../di/adapter.js";
import type { LockAdapter } from "./types.js";
import type { LockConfig } from "./configuration.js";

/** Public backend recipe shared by built-in and third-party integrations. */
export type LockAdapterDefinition = AdapterDefinition<
  LockAdapter,
  LockConfig,
  { readonly prune: boolean }
>;

/** Declares dependencies without opening resources during application composition. */
export function defineLockAdapter<
  const Dependencies extends AdapterDependencies,
  Value extends LockAdapter,
>(
  options: AdapterFactoryOptions<Value, LockConfig, { readonly prune: boolean }, Dependencies>,
): LockAdapterDefinition {
  return defineAdapter(options);
}
