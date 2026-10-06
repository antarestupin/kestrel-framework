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

export interface RegistrationOptions<Value> {
  lifetime?: DependencyLifetime;
  dispose?: (value: Value) => Promise<void> | void;
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
  registerValue<Value>(
    id: string,
    value: Value,
    options?: Pick<RegistrationOptions<Value>, "dispose">,
  ): void;
  resolve<
    Declaration extends DependencyDeclaration<Config, unknown>,
  >(declaration: Declaration): ResolvedDependency<Declaration>;
  resolveDependencies<
    const Declarations extends DependencyDeclarations<Config>,
  >(
    declarations: Declarations,
  ): ResolvedDependencies<Declarations>;
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
  public constructor(
    private readonly config: Config,
    private readonly container: AwilixContainer,
  ) {}

  public createScope(): DependencyContainer<Config> {
    return new DependencyContainerImpl(
      this.config,
      this.container.createScope(),
    );
  }

  public async dispose(): Promise<void> {
    await this.container.dispose();
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
    const resolver = applyRegistrationOptions(
      asFunction(factory),
      options,
    );

    this.container.register(id, resolver);
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
