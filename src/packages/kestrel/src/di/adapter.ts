import { singletonReference, type DependencyContainer } from "./container.js";
import {
  type RegisteredDependencyDescriptor,
  type ResolvedDependencies,
} from "./dependencies.js";

/** Adapter factories receive only declared, typed infrastructure dependencies. */
export type AdapterDependencies = Readonly<Record<string, RegisteredDependencyDescriptor<unknown>>>;
export type AdapterDependencyResolver = <Value>(dependency: RegisteredDependencyDescriptor<Value>) => Value;

/** A reusable recipe; all mutable lifecycle state belongs to its app registration. */
export interface AdapterDefinition<Value, Context, Capabilities> {
  readonly capabilities: Readonly<Capabilities>;
  create(resolve: AdapterDependencyResolver, context: Context): Value;
  initialize?(value: Value): void | Promise<void>;
  /** Dispose only resources owned by the adapter, never borrowed dependencies. */
  dispose?(value: Value): void | Promise<void>;
}

export interface AdapterFactoryOptions<Value, Context, Capabilities, Dependencies extends AdapterDependencies> {
  readonly dependencies: Dependencies;
  readonly capabilities: Readonly<Capabilities>;
  readonly create: (dependencies: ResolvedDependencies<Dependencies>, context: Context) => Value;
  readonly initialize?: (value: Value) => void | Promise<void>;
  readonly dispose?: (value: Value) => void | Promise<void>;
}

/** Erases dependency-map generics while preserving inference at the declaration. */
export function defineAdapter<Value, Context, Capabilities, const Dependencies extends AdapterDependencies>(
  options: AdapterFactoryOptions<Value, Context, Capabilities, Dependencies>,
): AdapterDefinition<Value, Context, Capabilities> {
  const dependencies = { ...options.dependencies };
  const create = options.create;
  return Object.freeze({
    capabilities: Object.freeze({ ...options.capabilities }),
    create: (resolve: AdapterDependencyResolver, context: Context) => create(
      Object.fromEntries(Object.entries(dependencies).map(([name, dependency]) => [name, resolve(dependency)])) as ResolvedDependencies<Dependencies>,
      context,
    ),
    ...(options.initialize === undefined ? {} : { initialize: options.initialize }),
    ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
  });
}

export interface AdapterRegistration<Value> {
  get(): Value;
  boot(): Promise<void>;
  dispose(): Promise<void>;
}

/** Registers one lazy adapter and its lifecycle, including failed initialization cleanup. */
export function registerAdapter<Config, Value, Context, Capabilities>(
  container: DependencyContainer<Config>,
  id: string,
  definition: AdapterDefinition<Value, Context, Capabilities>,
  context: Context,
  options: {
    validate?: (value: Value) => void;
    /** Drain consumers before releasing their adapter. */
    beforeDispose?: () => void | Promise<void>;
    /** @internal True after the app shutdown boundary has observed this disposal result. */
    hasObservedDisposal?: () => boolean;
  } = {},
): AdapterRegistration<Value> {
  let activated = false;
  let disposed = false;
  let created = false;
  let value: Value;
  let bootPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  let validationError: unknown;
  let invalid = false;
  const registration: AdapterRegistration<Value> = {
    get() {
      if (disposed) throw new Error(`Adapter "${id}" is disposed.`);
      if (invalid) throw validationError;
      activated = true;
      if (!created) {
        value = definition.create((dependency) => container.resolve(dependency), context);
        // Track ownership before validation so even a rejected instance is released.
        created = true;
        try { options.validate?.(value); } catch (error) {
          invalid = true;
          validationError = error;
          throw error;
        }
      }
      return value;
    },
    boot() {
      if (disposed) return Promise.reject(new Error(`Adapter "${id}" is disposed.`));
      activated = true;
      bootPromise ??= Promise.resolve().then(() => {
        const adapter = registration.get();
        return definition.initialize?.(adapter);
      });
      return bootPromise;
    },
    dispose() {
      disposed = true;
      disposePromise ??= (async () => {
        if (!activated) return;
        await bootPromise?.catch(() => undefined);
        const errors: unknown[] = [];
        try { await options.beforeDispose?.(); } catch (error) { errors.push(error); }
        // Keep the drain failure even when release independently fails.
        try { if (created) await definition.dispose?.(value); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, `Adapter "${id}" disposal failed.`);
      })();
      return disposePromise;
    },
  };
  // Own the lightweight handle immediately so even unused registrations close with their container.
  container.registerValue(`${id}Registration`, registration, {
    dispose: (value) => {
      if (!options.hasObservedDisposal?.()) return value.dispose();
    },
  });
  container.registerFactory(id, () => registration.get(), { lifetime: "singleton", [singletonReference]: true });
  return registration;
}

/** Scoped services are ready synchronously; async infrastructure belongs to a booted singleton. */
export type ScopedAdapterDefinition<Value, Context, Capabilities> =
  Omit<AdapterDefinition<Value, Context, Capabilities>, "initialize"> & { readonly initialize?: never };

/** Defines an execution-local adapter without silently starting asynchronous initialization. */
export function defineScopedAdapter<Value, Context, Capabilities, const Dependencies extends AdapterDependencies>(
  options: Omit<AdapterFactoryOptions<Value, Context, Capabilities, Dependencies>, "initialize"> & { readonly initialize?: never },
): ScopedAdapterDefinition<Value, Context, Capabilities> {
  return defineAdapter(options) as ScopedAdapterDefinition<Value, Context, Capabilities>;
}

/** Resolves descriptors from the active DI cradle, preserving transactions and scope isolation. */
export function registerScopedAdapter<Config, Value, Context, Capabilities>(
  container: DependencyContainer<Config>,
  id: string,
  definition: ScopedAdapterDefinition<Value, Context, Capabilities>,
  context: Context,
): void {
  if (definition.initialize !== undefined) {
    throw new TypeError("Scoped adapters must be synchronously ready; initialize shared infrastructure during application boot.");
  }
  container.registerFactory<Value, Record<string, unknown>>(id, (dependencies) =>
    definition.create(<T>(dependency: RegisteredDependencyDescriptor<T>) => dependencies[dependency.id] as T, context),
  { lifetime: "scoped", ...(definition.dispose === undefined ? {} : { dispose: definition.dispose }) });
}
