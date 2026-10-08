import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterFactoryOptions,
  type AdapterDependencies,
} from "../di/adapter.js";
import type { ObservationWriter } from "./recorder.js";
import type { DevObservationSource } from "./source.js";

/** Writing is mandatory; browsing is an independently advertised capability. */
export interface ObservationAdapter {
  readonly writer: ObservationWriter;
  readonly source?: DevObservationSource;
  readonly available?: boolean;
}
export type ObservationAdapterDefinition = AdapterDefinition<
  ObservationAdapter,
  undefined,
  { readonly query: boolean }
>;
export function defineObservationAdapter<
  const Dependencies extends AdapterDependencies,
  Value extends ObservationAdapter,
>(
  options: AdapterFactoryOptions<Value, undefined, { readonly query: boolean }, Dependencies>,
): ObservationAdapterDefinition {
  return defineAdapter(options);
}
