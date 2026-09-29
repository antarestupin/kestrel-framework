const dependencyDescriptorMarker = Symbol("dependency-descriptor");

export type DependencyLifetime = "singleton" | "scoped" | "transient";

export type Constructor<Value = object> = new (
  ...args: never[]
) => Value;

interface DependencyDescriptorBase {
  readonly [dependencyDescriptorMarker]: true;
}

export interface ClassDependencyDescriptor<Value>
  extends DependencyDescriptorBase {
  readonly kind: "class";
  readonly target: Constructor<Value>;
}

export interface ConfigDependencyDescriptor<Config, Value>
  extends DependencyDescriptorBase {
  readonly kind: "config";
  readonly selector: (config: Config) => Value;
}

export interface RegisteredDependencyDescriptor<Value>
  extends DependencyDescriptorBase {
  readonly kind: "registered";
  readonly id: string;
}

export type DependencyDescriptor<Config, Value> =
  | ClassDependencyDescriptor<Value>
  | ConfigDependencyDescriptor<Config, Value>
  | RegisteredDependencyDescriptor<Value>;

export type DependencyDeclaration<Config, Value> =
  | Constructor<Value>
  | DependencyDescriptor<Config, Value>;

export type DependencyDeclarations<Config> = Record<
  string,
  DependencyDeclaration<Config, unknown>
>;

export type ResolvedDependency<Declaration> =
  Declaration extends DependencyDeclaration<
    infer _Config,
    infer Value
  >
    ? Value
    : never;

export type ResolvedDependencies<
  Declarations extends Record<string, unknown>,
> = {
  [Key in keyof Declarations]: ResolvedDependency<Declarations[Key]>;
};

/**
 * Declares a dependency selected from the resolved application configuration.
 */
export function fromConfig<Config, Value>(
  selector: (config: Config) => Value,
): ConfigDependencyDescriptor<Config, Value> {
  return {
    [dependencyDescriptorMarker]: true,
    kind: "config",
    selector,
  };
}

/**
 * Creates dependency declaration helpers bound to an application config type.
 */
export function createDependencyApi<Config>() {
  return {
    fromConfig: <Value>(
      selector: (config: Config) => Value,
    ): ConfigDependencyDescriptor<Config, Value> =>
      fromConfig(selector),
  };
}

/**
 * Declares a dependency that must be found by id in the runtime container.
 */
export function dep<Value>(
  id: string,
): RegisteredDependencyDescriptor<Value> {
  return {
    [dependencyDescriptorMarker]: true,
    kind: "registered",
    id,
  };
}

/**
 * Converts the ergonomic declaration syntax into Kestrel's internal
 * descriptor representation.
 */
export function normalizeDependency<Config, Value>(
  declaration: DependencyDeclaration<Config, Value>,
): DependencyDescriptor<Config, Value> {
  if (typeof declaration === "function") {
    return {
      [dependencyDescriptorMarker]: true,
      kind: "class",
      target: declaration,
    };
  }

  return declaration;
}
