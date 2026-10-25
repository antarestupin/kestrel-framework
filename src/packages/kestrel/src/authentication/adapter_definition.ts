import {
  defineScopedAdapter,
  type ScopedAdapterDefinition,
  type AdapterDependencies,
  type AdapterFactoryOptions,
} from "../di/adapter.js";
import type { AuthenticationAdapter, SessionStorageAdapter } from "./stores.js";

/** An execution-local recipe; borrowed transaction contexts never escape their scope. */
export type AuthenticationAdapterDefinition<Claims = unknown> = ScopedAdapterDefinition<
  AuthenticationAdapter<Claims>,
  undefined,
  Readonly<Record<never, never>>
>;

/** Declares a synchronously ready scoped backend. */
export function defineAuthenticationAdapter<
  const Dependencies extends AdapterDependencies,
  Claims = unknown,
>(
  options: Omit<
    AdapterFactoryOptions<
      AuthenticationAdapter<Claims>,
      undefined,
      Readonly<Record<never, never>>,
      Dependencies
    >,
    "initialize"
  > & { readonly initialize?: never },
): AuthenticationAdapterDefinition<Claims> {
  return defineScopedAdapter(options);
}

/** Focused session recipes compose with any account and credential backend. */
export type SessionStorageAdapterDefinition<Claims = unknown> = ScopedAdapterDefinition<
  SessionStorageAdapter<Claims>, undefined, Readonly<Record<never, never>>
>;

export function defineSessionStorageAdapter<const Dependencies extends AdapterDependencies, Claims = unknown>(
  options: Omit<AdapterFactoryOptions<SessionStorageAdapter<Claims>, undefined, Readonly<Record<never, never>>, Dependencies>, "initialize">
    & { readonly initialize?: never },
): SessionStorageAdapterDefinition<Claims> {
  return defineScopedAdapter(options);
}
