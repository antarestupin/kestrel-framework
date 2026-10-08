import { defineWorkflowAdapter } from "../../adapter_definition.js";
import { MemoryWorkflowAdapter, type MemoryWorkflowAdapterOptions } from "./adapter.js";

/** Declares the activity transport before any storage is instantiated. */
export function memoryWorkflows(options: MemoryWorkflowAdapterOptions = {}) {
  const activityDispatchMode = options.activityDispatchMode ?? "embedded";

  return defineWorkflowAdapter({
    dependencies: {},
    capabilities: { activityDispatchMode },
    create: (_dependencies) => new MemoryWorkflowAdapter({ ...options, activityDispatchMode }),
  });
}
