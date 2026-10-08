import {
  defineAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { WorkflowAdapter } from "./adapter.js";
export interface WorkflowAdapterContext {
  readonly activityDispatchMode: "embedded" | "outbox";
}

/** Capabilities available during composition, before the backend is constructed. */
export interface WorkflowAdapterCapabilities {
  readonly activityDispatchMode: "embedded" | "outbox";
}
export type WorkflowAdapterDefinition = AdapterDefinition<WorkflowAdapter, WorkflowAdapterContext, WorkflowAdapterCapabilities>;

/** Defines a backend without coupling it to the application or provider lifecycle. */
export function defineWorkflowAdapter<const Dependencies extends AdapterDependencies, Value extends WorkflowAdapter>(
  options: AdapterFactoryOptions<Value, WorkflowAdapterContext, WorkflowAdapterCapabilities, Dependencies>,
): WorkflowAdapterDefinition {
  return defineAdapter(options);
}
