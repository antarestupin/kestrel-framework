import { defineTokenStorageAdapter } from "../../adapter_definition.js";
import { MemoryTokenStorageAdapter } from "./adapter.js";

/** Borrows application-owned in-memory state across execution scopes. */
export function memoryTokens(adapter: MemoryTokenStorageAdapter) {
  return defineTokenStorageAdapter({ dependencies: {}, capabilities: {}, create: () => adapter });
}
