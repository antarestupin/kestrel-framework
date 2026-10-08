import {
  defineScopedAdapter,
  type ScopedAdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { SubjectRoleStorageAdapter } from "./types.js";

/** An execution-local recipe; borrowed transaction contexts never escape their scope. */
export type SubjectRoleStorageAdapterDefinition = ScopedAdapterDefinition<
  SubjectRoleStorageAdapter,
  undefined,
  Readonly<Record<never, never>>
>;

/** Declares a synchronously ready scoped backend. */
export function defineSubjectRoleStorageAdapter<const Dependencies extends AdapterDependencies>(
  options: Omit<
    AdapterFactoryOptions<
      SubjectRoleStorageAdapter,
      undefined,
      Readonly<Record<never, never>>,
      Dependencies
    >,
    "initialize"
  > & { readonly initialize?: never },
): SubjectRoleStorageAdapterDefinition {
  return defineScopedAdapter(options);
}
