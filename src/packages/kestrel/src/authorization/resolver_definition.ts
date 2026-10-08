import {
  defineScopedAdapter,
  type ScopedAdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { PermissionResolver } from "./types.js";

/** An execution-local recipe; borrowed transaction contexts never escape their scope. */
export type PermissionResolverAdapterDefinition = ScopedAdapterDefinition<
  PermissionResolver,
  undefined,
  Readonly<Record<never, never>>
>;

/** Declares a synchronously ready scoped backend. */
export function definePermissionResolverAdapter<const Dependencies extends AdapterDependencies>(
  options: Omit<
    AdapterFactoryOptions<
      PermissionResolver,
      undefined,
      Readonly<Record<never, never>>,
      Dependencies
    >,
    "initialize"
  > & { readonly initialize?: never },
): PermissionResolverAdapterDefinition {
  return defineScopedAdapter(options);
}
