import {
  z,
  type input,
  type output,
  type ZodObject,
  type ZodType,
} from "zod";

export type RuntimeEnvironment = Readonly<
  Record<string, string | undefined>
>;

interface ConfigSourceContext {
  environment: string;
  env: RuntimeEnvironment;
  path: readonly string[];
}

interface ConventionalOverrideTarget {
  name: string;
  path: readonly string[];
  schema: ZodType;
}

interface ConfigResolutionState {
  conventionalTargets: Map<string, ConventionalOverrideTarget>;
  explicitEnvironmentVariables: Map<string, Set<string>>;
  consumedExplicitEnvironmentVariables: Set<string>;
}

type ConfigShape = Readonly<Record<string, ZodType>>;

export interface ResolveConfigOptions {
  environment?: unknown;
  env: RuntimeEnvironment;
}

export interface EnvVarOptions<Value> {
  fallback: Value;
}

export interface CreateConfigurationOptions<
  Environments extends readonly [string, ...string[]],
> {
  environments: Environments;
  defaultEnvironment: Environments[number];
  environmentOverrides?: ConventionalEnvironmentOverrideOptions;
}

export interface ConventionalEnvironmentOverrideOptions {
  /** Prefix reserved for schema-derived configuration variables. */
  prefix: string;
}

const configSourceMarker = Symbol("config-source");
const configContributionMarker = Symbol("config-contribution");
const environmentVariableSourceMarker = Symbol("environment-variable-source");

/** Defines the configuration fields owned and validated by a library. */
export interface ConfigBase<Schema extends ZodObject = ZodObject> {
  readonly schema: Schema;
}

export interface ConfigContribution<
  Schema extends ZodObject = ZodObject,
  Definition extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly [configContributionMarker]: true;
  readonly base: ConfigBase<Schema>;
  readonly definition: Definition;
}

/**
 * Represents a value that can only be produced with runtime configuration
 * context. Application code receives its resolved value instead of this source.
 */
export interface ConfigSource<Value> {
  readonly [configSourceMarker]: true;
  resolve(context: ConfigSourceContext): Value;
}

interface EnvironmentVariableConfigSource<Value> extends ConfigSource<Value> {
  readonly [environmentVariableSourceMarker]: string;
}

export type ResolvedConfig<Value> =
  Value extends ConfigContribution<
    infer Schema,
    infer Definition
  >
    ? output<Schema> & ResolvedConfig<
      Omit<Definition, keyof input<Schema>>
    >
    : Value extends ConfigSource<infer ResolvedValue>
    ? ResolvedConfig<ResolvedValue>
    : Value extends readonly unknown[]
      ? { -readonly [Key in keyof Value]: ResolvedConfig<Value[Key]> }
      : Value extends object
        ? { [Key in keyof Value]: ResolvedConfig<Value[Key]> }
        : Value;

export class ConfigurationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

/**
 * Creates the configuration contract owned by a library.
 *
 * Object schemas are used because applications may add sibling fields while
 * the library remains responsible for validating the fields it declares.
 */
export function defineConfigBase<const Schema extends ZodObject>(
  schema: Schema,
): ConfigBase<Schema> {
  return { schema };
}

type Configurable<Value> =
  | ConfigSource<unknown>
  | (Value extends readonly unknown[]
    ? { [Key in keyof Value]: Configurable<Value[Key]> }
    : Value extends object
      ? { [Key in keyof Value]: Configurable<Value[Key]> }
      : Value);

/** Application definition expected by a library configuration base. */
export type ConfigDefinition<Base extends ConfigBase> =
  Configurable<input<Base["schema"]>> & Record<string, unknown>;

/** Resolved configuration guaranteed to consumers of a library. */
export type ConfigOutput<Base extends ConfigBase> = output<Base["schema"]>;

/**
 * Completes a library configuration base with application values and typed
 * application-specific extensions.
 */
export function configure<
  const Schema extends ZodObject,
  const Definition extends ConfigDefinition<ConfigBase<Schema>>,
>(
  base: ConfigBase<Schema>,
  definition: Definition,
): ConfigContribution<Schema, Definition> {
  return {
    [configContributionMarker]: true,
    base,
    definition,
  };
}

/**
 * Creates a configuration API specialized for an application's environments.
 */
export function createConfigurationApi<
  const Environments extends readonly [string, ...string[]],
>(
  options: CreateConfigurationOptions<Environments>,
) {
  type Environment = Environments[number];
  type EnvironmentValues = Partial<Record<Environment, unknown>> & {
    default?: unknown;
  };
  type RejectUnknownEnvironmentKeys<Values> = Record<
    Exclude<keyof Values, keyof EnvironmentValues>,
    never
  >;

  const environmentSchema = z.enum(options.environments);
  const conventionalOverrides = options.environmentOverrides;

  if (
    conventionalOverrides !== undefined
    && !/^[A-Z][A-Z0-9_]*$/u.test(conventionalOverrides.prefix)
  ) {
    throw new ConfigurationError(
      `Invalid conventional environment variable prefix "${conventionalOverrides.prefix}". Expected uppercase letters, digits, and single underscores.`,
    );
  }

  if (conventionalOverrides?.prefix.includes("__") === true) {
    throw new ConfigurationError(
      `Invalid conventional environment variable prefix "${conventionalOverrides.prefix}". Double underscores are reserved as path separators.`,
    );
  }

  /**
   * Declares a configuration object while preserving its exact inferred shape.
   */
  function defineConfig<
    const Definition extends Record<string, unknown>,
  >(definition: Definition): Definition {
    return definition;
  }

  /**
   * Declares a value selected from the active application environment.
   */
  function fromEnv<const Values extends EnvironmentValues>(
    values: Values & RejectUnknownEnvironmentKeys<Values>,
  ): ConfigSource<Values[keyof Values]> {
    return createConfigSource((context) => {
      if (hasOwnProperty(values, context.environment)) {
        return values[
          context.environment as Environment
        ] as Values[keyof Values];
      }

      if (hasOwnProperty(values, "default")) {
        return values.default as Values[keyof Values];
      }

      throw new ConfigurationError(
        `No value is configured for environment "${context.environment}" at "${formatPath(context.path)}".`,
      );
    });
  }

  /**
   * Maps the same value to several application environments.
   */
  function envs<
    const SelectedEnvironments extends readonly [
      Environment,
      ...Environment[],
    ],
    Value,
  >(
    selectedEnvironments: SelectedEnvironments,
    value: Value,
  ): { [Key in SelectedEnvironments[number]]: Value } {
    return Object.fromEntries(
      selectedEnvironments.map((environment) => [
        environment,
        value,
      ]),
    ) as { [Key in SelectedEnvironments[number]]: Value };
  }

  /** Declares an environment variable with optional fallback or validation. */
  function envVar(name: string): ConfigSource<string | undefined>;
  function envVar<const Fallback>(
    name: string,
    options: EnvVarOptions<Fallback>,
  ): ConfigSource<string | Fallback>;
  function envVar<Schema extends ZodType>(
    name: string,
    schema: Schema,
  ): ConfigSource<output<Schema>>;
  function envVar<Schema extends ZodType, Fallback>(
    name: string,
    schemaOrOptions?: Schema | EnvVarOptions<Fallback>,
  ): ConfigSource<output<Schema> | string | Fallback | undefined> {
    return createEnvironmentVariableConfigSource(name, (context) => {
      // A configuration base validates raw variables after all sources have
      // been resolved. Standalone application fields may still validate here.
      if (schemaOrOptions === undefined) {
        return context.env[name];
      }

      if (isEnvVarOptions(schemaOrOptions)) {
        return context.env[name] ?? schemaOrOptions.fallback;
      }

      const result = schemaOrOptions.safeParse(context.env[name]);

      if (!result.success) {
        const details = result.error.issues
          .map((issue) => issue.message)
          .join("; ");

        throw new ConfigurationError(
          `Invalid environment variable "${name}" at "${formatPath(context.path)}": ${details}`,
          { cause: result.error },
        );
      }

      return result.data;
    });
  }

  /**
   * Validates an environment name, using the application default when omitted.
   */
  function resolveEnvironment(
    value: unknown = options.defaultEnvironment,
  ): Environment {
    const result = environmentSchema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    const received =
      value === undefined ? "undefined" : JSON.stringify(value);

    throw new ConfigurationError(
      `Invalid application environment ${received}. Expected one of: ${options.environments.join(", ")}.`,
      { cause: result.error },
    );
  }

  /**
   * Resolves every dynamic source into a plain, fully typed config value.
   */
  function resolveConfig<
    const Definition extends Record<string, unknown>,
  >(
    definition: Definition,
    resolveOptions: ResolveConfigOptions,
  ): ResolvedConfig<Definition> {
    const context = {
      environment: resolveEnvironment(resolveOptions.environment),
      env: resolveOptions.env,
    };

    const state: ConfigResolutionState = {
      conventionalTargets: new Map(),
      explicitEnvironmentVariables: new Map(),
      consumedExplicitEnvironmentVariables: new Set(),
    };

    if (conventionalOverrides !== undefined) {
      collectConventionalTargets(
        definition,
        [],
        conventionalOverrides,
        state,
      );
    }

    const resolved = resolveValue(
      definition,
      context,
      [],
      state,
      conventionalOverrides,
    ) as ResolvedConfig<Definition>;

    if (conventionalOverrides !== undefined) {
      rejectUnknownConventionalVariables(
        resolveOptions.env,
        conventionalOverrides,
        state,
      );
    }

    return resolved;
  }

  return {
    defineConfig,
    environments: options.environments,
    environmentSchema,
    envs,
    envVar,
    fromEnv,
    resolveConfig,
    resolveEnvironment,
  };
}

function isEnvVarOptions<Value>(
  value: ZodType | EnvVarOptions<Value>,
): value is EnvVarOptions<Value> {
  return !("safeParse" in value);
}

function createConfigSource<Value>(
  resolver: (context: ConfigSourceContext) => Value,
): ConfigSource<Value> {
  return {
    [configSourceMarker]: true,
    resolve: resolver,
  };
}

function createEnvironmentVariableConfigSource<Value>(
  name: string,
  resolver: (context: ConfigSourceContext) => Value,
): EnvironmentVariableConfigSource<Value> {
  return {
    ...createConfigSource(resolver),
    [environmentVariableSourceMarker]: name,
  };
}

function resolveValue(
  value: unknown,
  context: Omit<ConfigSourceContext, "path">,
  path: readonly string[],
  state: ConfigResolutionState,
  conventionalOverrides: ConventionalEnvironmentOverrideOptions | undefined,
): unknown {
  if (isConfigContribution(value)) {
    const resolvedDefinition = resolveValue(
      value.definition,
      context,
      path,
      state,
      conventionalOverrides,
    );

    if (conventionalOverrides !== undefined) {
      applyConventionalOverrides(
        resolvedDefinition,
        value.base.schema,
        path,
        context.env,
        state,
      );
    }

    // Library schemas validate their declared fields while passthrough keeps
    // exact application extensions in the resolved configuration.
    const result = value.base.schema.passthrough().safeParse(
      resolvedDefinition,
    );

    if (!result.success) {
      const details = result.error.issues
        .map((issue) => {
          const issuePath = [...path, ...issue.path.map(String)];
          return `${formatPath(issuePath)}: ${issue.message}`;
        })
        .join("; ");

      throw new ConfigurationError(
        `Invalid configuration: ${details}`,
        { cause: result.error },
      );
    }

    return result.data;
  }

  if (isConfigSource(value)) {
    if (isEnvironmentVariableConfigSource(value)) {
      const pathKey = createPathKey(path);
      const variables = state.explicitEnvironmentVariables.get(pathKey)
        ?? new Set<string>();

      variables.add(value[environmentVariableSourceMarker]);
      state.explicitEnvironmentVariables.set(pathKey, variables);
      state.consumedExplicitEnvironmentVariables.add(
        value[environmentVariableSourceMarker],
      );
    }

    const resolvedValue = value.resolve({
      environment: context.environment,
      env: context.env,
      path,
    });

    // Sources may return another source, allowing environment-specific
    // environment variables without adding a separate primitive.
    return resolveValue(
      resolvedValue,
      context,
      path,
      state,
      conventionalOverrides,
    );
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      resolveValue(
        item,
        context,
        [...path, String(index)],
        state,
        conventionalOverrides,
      ),
    );
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveValue(
          item,
          context,
          [...path, key],
          state,
          conventionalOverrides,
        ),
      ]),
    );
  }

  return value;
}

function collectConventionalTargets(
  value: unknown,
  path: readonly string[],
  options: ConventionalEnvironmentOverrideOptions,
  state: ConfigResolutionState,
): void {
  if (isConfigContribution(value)) {
    collectSchemaTargets(value.base.schema, path, options, state);
    // Application extensions may contain another contribution of their own.
    collectConventionalTargets(value.definition, path, options, state);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectConventionalTargets(item, [...path, String(index)], options, state);
    });
    return;
  }

  if (isPlainObject(value) && !isConfigSource(value)) {
    Object.entries(value).forEach(([key, item]) => {
      collectConventionalTargets(item, [...path, key], options, state);
    });
  }
}

function collectSchemaTargets(
  schema: ZodType,
  path: readonly string[],
  options: ConventionalEnvironmentOverrideOptions,
  state: ConfigResolutionState,
): void {
  const shape = getObjectShape(schema);

  if (shape === undefined) return;

  Object.entries(shape).forEach(([key, fieldSchema]) => {
    const fieldPath = [...path, key];
    const nestedShape = getObjectShape(fieldSchema);

    if (nestedShape !== undefined) {
      collectSchemaTargets(fieldSchema, fieldPath, options, state);
      return;
    }

    if (isUnsupportedConventionalTarget(fieldSchema)) return;

    const name = createConventionalVariableName(options.prefix, fieldPath);
    const previous = state.conventionalTargets.get(name);

    if (
      previous !== undefined
      && createPathKey(previous.path) !== createPathKey(fieldPath)
    ) {
      throw new ConfigurationError(
        `Conventional environment variable "${name}" maps to both "${formatPath(previous.path)}" and "${formatPath(fieldPath)}".`,
      );
    }

    state.conventionalTargets.set(name, {
      name,
      path: fieldPath,
      schema: fieldSchema,
    });
  });
}

function applyConventionalOverrides(
  value: unknown,
  schema: ZodType,
  path: readonly string[],
  env: RuntimeEnvironment,
  state: ConfigResolutionState,
): void {
  if (!isPlainObject(value)) return;

  const shape = getObjectShape(schema);

  if (shape === undefined) return;

  Object.entries(shape).forEach(([key, fieldSchema]) => {
    const fieldPath = [...path, key];
    const nestedShape = getObjectShape(fieldSchema);

    if (nestedShape !== undefined) {
      if (!hasConventionalOverrideBelow(fieldPath, env, state)) return;

      if (!isPlainObject(value[key])) {
        value[key] = createDefaultObject(fieldSchema);
      }

      applyConventionalOverrides(
        value[key],
        fieldSchema,
        fieldPath,
        env,
        state,
      );
      return;
    }

    if (isUnsupportedConventionalTarget(fieldSchema)) return;

    const target = findTargetByPath(fieldPath, state);

    if (target === undefined || env[target.name] === undefined) return;

    const explicitVariables = state.explicitEnvironmentVariables.get(
      createPathKey(fieldPath),
    );

    if (explicitVariables !== undefined) {
      if (!explicitVariables.has(target.name)) {
        const explicitNames = [...explicitVariables]
          .map((name) => `envVar("${name}")`)
          .join(", ");

        throw new ConfigurationError(
          `Conventional environment variable "${target.name}" cannot override "${formatPath(fieldPath)}" because that path explicitly uses ${explicitNames}.`,
        );
      }

      return;
    }

    value[key] = decodeConventionalValue(
      env[target.name] as string,
      target,
    );
  });
}

function rejectUnknownConventionalVariables(
  env: RuntimeEnvironment,
  options: ConventionalEnvironmentOverrideOptions,
  state: ConfigResolutionState,
): void {
  const reservedPrefix = `${options.prefix}__`;

  for (const [name, value] of Object.entries(env)) {
    if (
      value === undefined
      || !name.startsWith(reservedPrefix)
      || state.conventionalTargets.has(name)
      || state.consumedExplicitEnvironmentVariables.has(name)
    ) {
      continue;
    }

    throw new ConfigurationError(
      `Unknown conventional environment variable "${name}".`,
    );
  }
}

function decodeConventionalValue(
  rawValue: string,
  target: ConventionalOverrideTarget,
): unknown {
  const rawResult = target.schema.safeParse(rawValue);

  if (rawResult.success) return rawValue;

  let decodedValue: unknown;

  try {
    decodedValue = JSON.parse(rawValue) as unknown;
  } catch {
    throw invalidConventionalVariableError(target, rawResult.error);
  }

  const decodedResult = target.schema.safeParse(decodedValue);

  if (decodedResult.success) return decodedValue;

  throw invalidConventionalVariableError(target, decodedResult.error);
}

function invalidConventionalVariableError(
  target: ConventionalOverrideTarget,
  error: z.ZodError,
): ConfigurationError {
  const details = error.issues.map((issue) => issue.message).join("; ");

  return new ConfigurationError(
    `Invalid conventional environment variable "${target.name}" at "${formatPath(target.path)}": ${details}`,
    { cause: error },
  );
}

function getObjectShape(schema: ZodType): ConfigShape | undefined {
  const unwrapped = unwrapSchema(schema);
  return unwrapped instanceof z.ZodObject
    ? unwrapped.shape as ConfigShape
    : undefined;
}

function unwrapSchema(schema: ZodType): ZodType {
  let current = schema;

  while (
    (
      current.type === "optional"
      || current.type === "nullable"
      || current.type === "default"
      || current.type === "prefault"
      || current.type === "catch"
      || current.type === "readonly"
      || current.type === "nonoptional"
    )
    && "unwrap" in current
    && typeof current.unwrap === "function"
  ) {
    current = current.unwrap() as ZodType;
  }

  return current;
}

function isUnsupportedConventionalTarget(schema: ZodType): boolean {
  const unwrapped = unwrapSchema(schema);
  const schemaType = unwrapped.type;

  if (
    schemaType === "array"
    || schemaType === "tuple"
    || schemaType === "record"
    || schemaType === "map"
    || schemaType === "set"
    || schemaType === "intersection"
    || schemaType === "lazy"
  ) {
    return true;
  }

  if (schemaType === "pipe") {
    const pipe = unwrapped as ZodType & {
      in: ZodType;
      out: ZodType;
    };

    return [pipe.in, pipe.out].some((part) =>
      getObjectShape(part) !== undefined
      || isUnsupportedConventionalTarget(part)
    );
  }

  if (schemaType !== "union") return false;

  const union = unwrapped as z.ZodUnion;
  return union.options.some((option) =>
    getObjectShape(option as ZodType) !== undefined
    || isUnsupportedConventionalTarget(option as ZodType)
  );
}

function createDefaultObject(schema: ZodType): Record<string, unknown> {
  const result = schema.safeParse(undefined);

  if (result.success && isPlainObject(result.data)) {
    return clonePlainObject(result.data);
  }

  return {};
}

function clonePlainObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isPlainObject(item) ? clonePlainObject(item) : item,
  ]));
}

function hasConventionalOverrideBelow(
  path: readonly string[],
  env: RuntimeEnvironment,
  state: ConfigResolutionState,
): boolean {
  const pathKey = `${createPathKey(path)}\u0000`;

  return [...state.conventionalTargets.values()].some((target) =>
    createPathKey(target.path).startsWith(pathKey)
    && env[target.name] !== undefined
  );
}

function findTargetByPath(
  path: readonly string[],
  state: ConfigResolutionState,
): ConventionalOverrideTarget | undefined {
  const pathKey = createPathKey(path);
  return [...state.conventionalTargets.values()].find(
    (target) => createPathKey(target.path) === pathKey,
  );
}

function createConventionalVariableName(
  prefix: string,
  path: readonly string[],
): string {
  const segments = path.map((segment) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment)) {
      throw new ConfigurationError(
        `Configuration path "${formatPath(path)}" cannot be converted to a conventional environment variable because segment "${segment}" is not an identifier.`,
      );
    }

    return segment
      .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .toUpperCase();
  });

  return [prefix, ...segments].join("__");
}

function createPathKey(path: readonly string[]): string {
  return path.join("\u0000");
}

function isConfigContribution(
  value: unknown,
): value is ConfigContribution {
  return (
    typeof value === "object"
    && value !== null
    && configContributionMarker in value
  );
}

function isConfigSource(value: unknown): value is ConfigSource<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    configSourceMarker in value
  );
}

function isEnvironmentVariableConfigSource(
  value: ConfigSource<unknown>,
): value is EnvironmentVariableConfigSource<unknown> {
  return environmentVariableSourceMarker in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOwnProperty(
  value: object,
  property: PropertyKey,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}
