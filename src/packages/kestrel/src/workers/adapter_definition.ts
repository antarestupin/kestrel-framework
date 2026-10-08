import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { WorkerAdapter } from "./types.js";
import type { WorkersConfig } from "./configuration.js";

/** Capabilities available during composition, before the backend is constructed. */
export type WorkerAdapterCapabilities = Readonly<Record<never, never>>;
export type WorkerAdapterDefinition = AdapterDefinition<WorkerAdapter, WorkersConfig, WorkerAdapterCapabilities>;

/** Defines a backend without coupling it to the application or provider lifecycle. */
export function defineWorkerAdapter<const Dependencies extends AdapterDependencies, Value extends WorkerAdapter>(
  options: AdapterFactoryOptions<Value, WorkersConfig, WorkerAdapterCapabilities, Dependencies>,
): WorkerAdapterDefinition {
  return defineAdapter(options);
}
