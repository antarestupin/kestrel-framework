import {
  type input,
  type output,
  z,
  type ZodType,
} from "zod";

import {
  type DependencyDeclarations,
  type ResolvedDependencies,
} from "../di/index.js";
import {
  resolveValidation,
  type DefinitionContract,
  type ValidationOptions,
} from "../definitions/index.js";
import type { ActionMiddleware } from "./middleware.js";

// Actions without an explicit input or output use null as their contract.
const nullActionSchema = z.null();

export interface ActionOptions<
  InputSchema extends ZodType = typeof nullActionSchema,
  OutputSchema extends ZodType = typeof nullActionSchema,
  Dependencies extends DependencyDeclarations<never> = {},
> {
  /** Stable name used to identify the action. */
  name: string;
  /** Human-readable summary inherited by controllers and documentation. */
  description?: string;
  /** Declares the business input; omitted input defaults to null. */
  input?: InputSchema;
  /** Both boundaries default to sync unless explicitly configured. */
  validation?: ValidationOptions;
  /** Declares the business output; omitted output defaults to null. */
  output?: OutputSchema;
  /** Dependencies are resolved from the application scope for every run. */
  dependencies?: Dependencies;
  /** Surrounds the handler and output validation in declaration order. */
  middleware?: readonly ActionMiddleware<any>[];
  handler: (
    input: output<InputSchema>,
    dependencies: ResolvedDependencies<Dependencies>,
  ) =>
    | input<OutputSchema>
    | Promise<input<OutputSchema>>;
}

/**
 * Describes a typed business operation independently from its runtime
 * application and external controllers.
 */
export interface Action<
  InputSchema extends ZodType = ZodType,
  OutputSchema extends ZodType = ZodType,
  Dependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> extends DefinitionContract<InputSchema, OutputSchema, Dependencies> {
  readonly name: string;
  /** Actions always declare and validate their business output contract. */
  readonly outputSchema: OutputSchema;
  readonly middleware: readonly ActionMiddleware<any>[];
  /**
   * Creates an immutable action variant through a typed transformation.
   */
  derive<
    DerivedInputSchema extends ZodType,
    DerivedOutputSchema extends ZodType,
    const DerivedDependencies extends DependencyDeclarations<never>,
  >(
    transform: (
      action: Action<
        InputSchema,
        OutputSchema,
        Dependencies
      >,
    ) => Action<
      DerivedInputSchema,
      DerivedOutputSchema,
      DerivedDependencies
    >,
  ): Action<
    DerivedInputSchema,
    DerivedOutputSchema,
    DerivedDependencies
  >;
  readonly handler: (
    input: output<InputSchema>,
    dependencies: ResolvedDependencies<Dependencies>,
  ) =>
    | input<OutputSchema>
    | Promise<input<OutputSchema>>;
}

/**
 * Declares an action contract, its dependencies and its business handler.
 *
 * Input and output schemas are retained on the definition for runtime
 * validation, controller generation and future introspection tooling.
 */
export function defineAction<
  InputSchema extends ZodType = typeof nullActionSchema,
  OutputSchema extends ZodType = typeof nullActionSchema,
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  options: ActionOptions<
    InputSchema,
    OutputSchema,
    Dependencies
  >,
): Action<InputSchema, OutputSchema, Dependencies> {
  const action: Action<
    InputSchema,
    OutputSchema,
    Dependencies
  > = {
    name: options.name,
    validation: resolveValidation(options.validation),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    inputSchema: options.input ?? nullActionSchema as unknown as InputSchema,
    outputSchema: options.output ?? nullActionSchema as unknown as OutputSchema,
    dependencies: options.dependencies ?? ({} as Dependencies),
    middleware: options.middleware ?? [],
    derive: (transform) => transform(action),
    handler: options.handler,
  };

  return action;
}
