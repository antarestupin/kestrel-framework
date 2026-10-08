export {
  createDependencyContainer,
  type DependencyContainer,
  type RegistrationOptions,
} from "./container.js";
export {
  createDependencyApi,
  dep,
  fromConfig,
  normalizeDependency,
  resolveDependency,
  type ClassDependencyDescriptor,
  type ConfigDependencyDescriptor,
  type Constructor,
  type DependencyDeclaration,
  type DependencyDeclarations,
  type DependencyDescriptor,
  type DependencyLifetime,
  type RegisteredDependencyDescriptor,
  type ResolvableDependency,
  type ResolvableDependencyDescriptor,
  type ResolvedDependencies,
  type ResolvedDependency,
} from "./dependencies.js";
export {
  defineAdapter,
  registerAdapter,
  type AdapterDefinition,
  type AdapterDependencies,
  type AdapterDependencyResolver,
  type AdapterFactoryOptions,
  type AdapterRegistration,
} from "./adapter.js";

export { defineScopedAdapter, registerScopedAdapter, type ScopedAdapterDefinition } from "./adapter.js";
