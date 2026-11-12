import {
  asClass,
  asFunction,
  asValue,
  createContainer as createAwilixContainer,
  InjectionMode,
  type AwilixContainer,
  type BuildResolver,
  type Constructor as AwilixConstructor,
  type DisposableResolver,
} from "awilix";

import { AsyncFactoryScope } from "./async_factory.js";

import {
  type Constructor,
  type DependencyDeclaration,
  type DependencyDeclarations,
  type DependencyLifetime,
  normalizeDependency,
  resolveDependency,
  type ResolvedDependencies,
  type ResolvedDependency,
} from "./dependencies.js";

/** Internal binding for a root-owned value that is already cached by its lifecycle handle. */
export const singletonReference = Symbol("singletonReference");

export interface RegistrationOptions<Value> {
  lifetime?: DependencyLifetime;
  dispose?: (value: Value) => Promise<void> | void;
  [singletonReference]?: true;
}

export interface DependencyContainer<Config> {
  createScope(): DependencyContainer<Config>;
  dispose(): Promise<void>;
  hasRegistration(id: string): boolean;
  registerClass<Value>(
    id: string,
    target: Constructor<Value>,
    options?: RegistrationOptions<Value>,
  ): void;
  registerFactory<Value, Dependencies extends object>(
    id: string,
    factory: (dependencies: Dependencies) => Value,
    options?: RegistrationOptions<Value>,
  ): void;
  /** Awaits explicit prerequisites before invoking the factory or constructor. */
  registerAsyncFactory<Value, const Dependencies extends DependencyDeclarations<Config>>(
    id: string,
    dependencies: Dependencies,
    factory: (dependencies: ResolvedDependencies<Dependencies>) => Value | Promise<Value>,
    options?: RegistrationOptions<Value>,
  ): void;
  registerValue<Value>(
    id: string,
    value: Value,
    options?: Pick<RegistrationOptions<Value>, "dispose">,
  ): void;
  resolve<
    Declaration extends DependencyDeclaration<Config, unknown>,
  >(declaration: Declaration): ResolvedDependency<Declaration>;
  resolveAsync<Declaration extends DependencyDeclaration<Config, unknown>>(
    declaration: Declaration,
  ): Promise<ResolvedDependency<Declaration>>;
  resolveDependencies<
    const Declarations extends DependencyDeclarations<Config>,
  >(
    declarations: Declarations,
  ): ResolvedDependencies<Declarations>;
  resolveDependenciesAsync<const Declarations extends DependencyDeclarations<Config>>(
    declarations: Declarations,
  ): Promise<ResolvedDependencies<Declarations>>;
}

/**
 * Creates a Kestrel-owned dependency container.
 *
 * Awilix remains an implementation detail so application code only deals with
 * app dependency declarations and registration methods.
 */
export function createDependencyContainer<Config>(
  config: Config,
): DependencyContainer<Config> {
  const container = createAwilixContainer({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  container.register("config", asValue(config));

  return new DependencyContainerImpl(config, container);
}

class DependencyContainerImpl<Config>
  implements DependencyContainer<Config>
{
  private readonly asyncFactories: AsyncFactoryScope<Config>;
  private disposal: Promise<void> | undefined;

  public constructor(
    private readonly config: Config,
    private readonly container: AwilixContainer,
    root?: AsyncFactoryScope<Config>,
  ) {
    this.asyncFactories = new AsyncFactoryScope(this, container, root);
  }

  public createScope(): DependencyContainer<Config> {
    return new DependencyContainerImpl(
      this.config,
      this.container.createScope(),
      this.asyncFactories.rootScope,
    );
  }

  public dispose(): Promise<void> {
    this.disposal ??= (async () => {
      const errors: unknown[] = [];
      // Async consumers release resources before synchronous prerequisites.
      try { await this.asyncFactories.dispose(); } catch (error) { errors.push(error); }
      // Awilix owns the cache. Clear it before cleanup and wait for every disposer,
      // including slow callbacks that overlap an earlier failure.
      const resources = [...this.container.cache.values()];
      this.container.cache.clear();
      const results = await Promise.allSettled(resources.map(async ({ resolver, value }) =>
        (resolver as DisposableResolver<unknown>).dispose?.(value),
      ));
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (errors.length > 0) throw new AggregateError(errors, "Dependency disposal failed.");
    })();
    return this.disposal;
  }

  public hasRegistration(id: string): boolean {
    return this.container.hasRegistration(id);
  }

  public registerClass<Value>(
    id: string,
    target: Constructor<Value>,
    options: RegistrationOptions<Value> = {},
  ): void {
    const resolver = applyRegistrationOptions(
      asClass(target as AwilixConstructor<Value>),
      options,
    );

    this.container.register(id, resolver);
  }

  public registerFactory<Value, Dependencies extends object>(
    id: string,
    factory: (dependencies: Dependencies) => Value,
    options: RegistrationOptions<Value> = {},
  ): void {
    // Forwarding an owned singleton is safe for cached consumers. Resolve its
    // handle every time so a cached raw value cannot bypass a disposal guard.
    const resolver = options[singletonReference]
      ? asFunction(factory, { isLeakSafe: true })
      : applyRegistrationOptions(asFunction(factory), options);

    this.container.register(id, resolver);
  }

  /** Explicit declarations make asynchronous dependency graphs inspectable. */
  public registerAsyncFactory<Value, const Dependencies extends DependencyDeclarations<Config>>(
    id: string,
    dependencies: Dependencies,
    factory: (dependencies: ResolvedDependencies<Dependencies>) => Value | Promise<Value>,
    options: RegistrationOptions<Value> = {},
  ): void {
    this.asyncFactories.register(id, dependencies, factory, options);
  }

  public async resolveAsync<Declaration extends DependencyDeclaration<Config, unknown>>(
    declaration: Declaration,
  ): Promise<ResolvedDependency<Declaration>> {
    return await this.asyncFactories.resolve(declaration) as ResolvedDependency<Declaration>;
  }

  public async resolveDependenciesAsync<const Declarations extends DependencyDeclarations<Config>>(
    declarations: Declarations,
  ): Promise<ResolvedDependencies<Declarations>> {
    this.asyncFactories.assertOpen();
    const entries = Object.entries(declarations);
    const results = await Promise.allSettled(entries.map(([, declaration]) => this.resolveAsync(declaration)));
    return Object.fromEntries(entries.map(([name], index) => {
      const result = results[index]!;
      if (result.status === "rejected") throw result.reason;
      return [name, result.value];
    })) as ResolvedDependencies<Declarations>;
  }

  public registerValue<Value>(
    id: string,
    value: Value,
    options: Pick<RegistrationOptions<Value>, "dispose"> = {},
  ): void {
    if (options.dispose === undefined) {
      this.container.register(id, asValue(value));
      return;
    }

    // Awilix values do not support disposal, so a singleton factory is used
    // when ownership of an existing resource is transferred to the container.
    const resolver = asFunction(() => value)
      .singleton()
      .disposer(options.dispose);

    this.container.register(id, resolver);

    // The resource already exists, so resolve it immediately to ensure Awilix
    // tracks it for disposal even if no consumer requests it later.
    this.container.resolve(id);
  }

  public resolve<
    Declaration extends DependencyDeclaration<Config, unknown>,
  >(declaration: Declaration): ResolvedDependency<Declaration> {
    const descriptor = normalizeDependency(declaration);

    if (descriptor.kind === "resolvable") {
      // Preserve the active scope and the definition's method receiver.
      return descriptor.target[resolveDependency](this) as ResolvedDependency<Declaration>;
    }

    if (descriptor.kind === "config") {
      return descriptor.selector(
        this.config,
      ) as ResolvedDependency<Declaration>;
    }

    if (descriptor.kind === "registered") {
      return this.container.resolve(
        descriptor.id,
      ) as ResolvedDependency<Declaration>;
    }

    return this.container.build(descriptor.target, {
      injectionMode: InjectionMode.PROXY,
    }) as ResolvedDependency<Declaration>;
  }

  public resolveDependencies<
    const Declarations extends DependencyDeclarations<Config>,
  >(
    declarations: Declarations,
  ): ResolvedDependencies<Declarations> {
    return Object.fromEntries(
      Object.entries(declarations).map(([name, declaration]) => [
        name,
        this.resolve(declaration),
      ]),
    ) as ResolvedDependencies<Declarations>;
  }
}

function applyRegistrationOptions<Value>(
  resolver: BuildResolver<Value> & DisposableResolver<Value>,
  options: RegistrationOptions<Value>,
): BuildResolver<Value> & DisposableResolver<Value> {
  const lifetime = options.lifetime ?? "transient";
  let configuredResolver = resolver;

  if (lifetime === "singleton") {
    configuredResolver = configuredResolver.singleton();
  } else if (lifetime === "scoped") {
    configuredResolver = configuredResolver.scoped();
  } else {
    configuredResolver = configuredResolver.transient();
  }

  if (options.dispose !== undefined) {
    configuredResolver = configuredResolver.disposer(
      options.dispose,
    );
  }

  return configuredResolver;
}
