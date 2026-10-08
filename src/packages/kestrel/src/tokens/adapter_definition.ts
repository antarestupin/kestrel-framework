import {
  defineScopedAdapter,
  type ScopedAdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { TokenStorageAdapter } from "./types.js";

/** An execution-local recipe; borrowed transaction contexts never escape their scope. */
export type TokenStorageAdapterDefinition = ScopedAdapterDefinition<
  TokenStorageAdapter,
  undefined,
  Readonly<Record<never, never>>
>;

/** Declares a synchronously ready scoped backend. */
export function defineTokenStorageAdapter<const Dependencies extends AdapterDependencies>(
  options: Omit<
    AdapterFactoryOptions<
      TokenStorageAdapter,
      undefined,
      Readonly<Record<never, never>>,
      Dependencies
    >,
    "initialize"
  > & { readonly initialize?: never },
): TokenStorageAdapterDefinition {
  return defineScopedAdapter(options);
}
