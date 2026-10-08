import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { StudioClientAdapter } from "./adapters/client/adapter.js";
export type StudioClientAdapterDefinition = AdapterDefinition<
  StudioClientAdapter,
  undefined,
  Readonly<Record<never, never>>
>;
/** Construction is lazy; HTTP mounting and server-owned hooks remain separate. */
export function defineStudioClientAdapter<
  const Dependencies extends AdapterDependencies,
  Value extends StudioClientAdapter,
>(
  options: AdapterFactoryOptions<Value, undefined, Readonly<Record<never, never>>, Dependencies>,
): StudioClientAdapterDefinition {
  return defineAdapter(options);
}
