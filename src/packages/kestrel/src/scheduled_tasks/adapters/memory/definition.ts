import { defineScheduledTaskAdapter } from "../../adapter_definition.js";
import { MemoryScheduledTaskAdapter, type MemoryScheduledTaskAdapterOptions } from "./adapter.js";

/** Constructs a backend lazily; injected connections remain borrowed. */
export function memoryScheduledTasks(options: MemoryScheduledTaskAdapterOptions = {}) {
  return defineScheduledTaskAdapter({
    dependencies: {},
    capabilities: {},
    create: () => new MemoryScheduledTaskAdapter(options),
  });
}
