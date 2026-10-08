import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { RateLimitAdapter } from "./types.js";
import type { ThrottlingConfig } from "./configuration.js";
import type { ThrottlingInstrumentation } from "./observations.js";
export interface ThrottlingAdapterContext {
  readonly config: ThrottlingConfig;
  readonly instrumentation?: ThrottlingInstrumentation;
}

/** Capabilities available during composition, before the backend is constructed. */
export interface ThrottlingAdapterCapabilities {
  readonly prune: boolean;
}
export type ThrottlingAdapterDefinition = AdapterDefinition<RateLimitAdapter, ThrottlingAdapterContext, ThrottlingAdapterCapabilities>;

/** Defines a backend without coupling it to the application or provider lifecycle. */
export function defineThrottlingAdapter<const Dependencies extends AdapterDependencies, Value extends RateLimitAdapter>(
  options: AdapterFactoryOptions<Value, ThrottlingAdapterContext, ThrottlingAdapterCapabilities, Dependencies>,
): ThrottlingAdapterDefinition {
  return defineAdapter(options);
}
