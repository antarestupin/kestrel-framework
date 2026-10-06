import type { DependencyContainer } from "./container.js";

const dependencyDescriptorMarker = Symbol("dependency-descriptor");

/** Opts a definition into resolution without coupling DI to its library. */
export const resolveDependency = Symbol("resolveDependency");

export interface ResolvableDependency<Config, Value> {
  /** Produces a value synchronously in the caller's container, without caching. */
  [resolveDependency](container: DependencyContainer<Config>): Value;
}

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

export interface ResolvableDependencyDescriptor<Config, Value>
  extends DependencyDescriptorBase {
  readonly kind: "resolvable";
  readonly target: ResolvableDependency<Config, Value>;
}

export type DependencyDescriptor<Config, Value> =
  | ClassDependencyDescriptor<Value>
  | ConfigDependencyDescriptor<Config, Value>
  | RegisteredDependencyDescriptor<Value>
  | ResolvableDependencyDescriptor<Config, Value>;

export type DependencyDeclaration<Config, Value> =
  | Constructor<Value>
  | DependencyDescriptor<Config, Value>
  | ResolvableDependency<Config, Value>;

export type DependencyDeclarations<Config> = Record<
  string,
  DependencyDeclaration<Config, unknown>
>;

export type ResolvedDependency<Declaration> =
  Declaration extends ResolvableDependency<infer _Config, infer Value>
    ? Value
    : Declaration extends DependencyDeclaration<
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
  // Check the protocol first so callable definitions can opt in as well.
  if (resolveDependency in declaration) {
    return {
      [dependencyDescriptorMarker]: true,
      kind: "resolvable",
      target: declaration,
    };
  }

  if (typeof declaration === "function") {
    return {
      [dependencyDescriptorMarker]: true,
      kind: "class",
      target: declaration,
    };
  }

  return declaration;
}
