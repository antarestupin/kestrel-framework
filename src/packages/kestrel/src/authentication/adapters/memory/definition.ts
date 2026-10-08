import { defineAuthenticationAdapter } from "../../adapter_definition.js";
import { MemoryAuthenticationAdapter } from "./adapter.js";

/** Borrows application-owned in-memory state across execution scopes. */
export function memoryAuthentication<Claims>(adapter: MemoryAuthenticationAdapter<Claims>) {
  return defineAuthenticationAdapter({ dependencies: {}, capabilities: {}, create: () => adapter });
}
