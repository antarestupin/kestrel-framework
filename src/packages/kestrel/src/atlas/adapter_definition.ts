import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { AtlasClientAdapter } from "./adapters/client/adapter.js";
export type AtlasClientAdapterDefinition = AdapterDefinition<
  AtlasClientAdapter,
  undefined,
  Readonly<Record<never, never>>
>;
/** Construction is lazy; HTTP mounting and server-owned hooks remain separate. */
export function defineAtlasClientAdapter<
  const Dependencies extends AdapterDependencies,
  Value extends AtlasClientAdapter,
>(
  options: AdapterFactoryOptions<Value, undefined, Readonly<Record<never, never>>, Dependencies>,
): AtlasClientAdapterDefinition {
  return defineAdapter(options);
}
