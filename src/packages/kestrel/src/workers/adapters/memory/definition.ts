import { defineWorkerAdapter } from "../../adapter_definition.js";
import { MemoryWorkerAdapter, type MemoryWorkerAdapterOptions } from "./adapter.js";

/** Creates a queue adapter lazily; borrowed infrastructure retains its owner. */
export function memoryWorkers(options: MemoryWorkerAdapterOptions = {}) {
  return defineWorkerAdapter({
    dependencies: {},
    capabilities: {},
    create: (_dependencies) => new MemoryWorkerAdapter(options),
  });
}
