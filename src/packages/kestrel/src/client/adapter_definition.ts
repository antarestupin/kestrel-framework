import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { WebClientAdapter } from "./client.js";
export type WebClientAdapterDefinition = AdapterDefinition<
  WebClientAdapter,
  undefined,
  Readonly<Record<never, never>>
>;
/** Construction is lazy; HTTP mounting and server-owned hooks remain separate. */
export function defineWebClientAdapter<
  const Dependencies extends AdapterDependencies,
  Value extends WebClientAdapter,
>(
  options: AdapterFactoryOptions<Value, undefined, Readonly<Record<never, never>>, Dependencies>,
): WebClientAdapterDefinition {
  return defineAdapter(options);
}
