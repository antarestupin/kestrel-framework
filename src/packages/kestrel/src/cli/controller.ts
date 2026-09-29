import { resolveValidation, type ValidationOptions } from "../definitions/index.js";
import type {
  output,
  ZodType,
} from "zod";
import type {
  AppRunningMode,
  AppRuntime,
  AppWorkload,
} from "../app/app.js";

import type {
  Action,
  ActionRunner,
} from "../actions/index.js";
import type { ActionExecution } from "../app/index.js";
import {
  type ControllerContract,
  type ControllerHandlerResult,
  type ControllerObjectSchema,
} from "../controllers/index.js";
import { emptyControllerInputSchema } from "../controllers/contract.js";
import type {
  DependencyDeclarations,
  ResolvedDependencies,
} from "../di/index.js";
import type { CliInputBinding } from "./bindings.js";
import type { CliMiddleware } from "./middleware.js";

export type CliObjectSchema = ControllerObjectSchema;

type CliInputBindings<InputSchema extends CliObjectSchema> = Partial<
  Record<keyof output<InputSchema> & string, CliInputBinding>
>;

export interface CliControllerHandlerContext<
  InputSchema extends CliObjectSchema,
  Dependencies extends DependencyDeclarations<never>,
> {
  input: output<InputSchema>;
  deps: ResolvedDependencies<Dependencies>;
  execution: ActionExecution;
}

export interface ActionCliControllerHandlerContext<
  ActionInputSchema extends CliObjectSchema,
  ActionOutputSchema extends ZodType,
  ControllerInputSchema extends CliObjectSchema,
  ControllerDependencies extends DependencyDeclarations<never>,
> extends CliControllerHandlerContext<
    ControllerInputSchema,
    ControllerDependencies
  > {
  action: ActionRunner<ActionInputSchema, ActionOutputSchema>;
}

interface BaseCliControllerOptions<
  InputSchema extends CliObjectSchema,
  OutputSchema extends ZodType | undefined,
  Dependencies extends DependencyDeclarations<never>,
> {
  /** Human-readable description shown in CLI help and documentation. */
  description?: string;
  /** Declares CLI input; omitted input defaults to an empty object. */
  input?: InputSchema;
  /** Selects parsing for this controller's input and output contracts. */
  validation?: ValidationOptions;
  /** Optionally validates and documents the returned transport value. */
  output?: OutputSchema;
  /** Overrides the default `--<field>` binding for selected input fields. */
  bindings?: CliInputBindings<InputSchema>;
  /** Dependencies resolved specifically for the CLI handler. */
  dependencies?: Dependencies;
  /** Surrounds the controller handler in declaration order. */
  middleware?: readonly CliMiddleware<output<InputSchema>, any>[];
  /** Disables lifecycle observations for commands that interrupt their store. */
  observe?: boolean;
  /** Selects the infrastructure needed to execute this command. */
  runningMode?: AppRunningMode;
  /** Identifies the runtime represented by a long-running command. */
  runtime?: AppRuntime;
  /** Selects the long-running workloads prepared before bootstrap. */
  workloads?: readonly AppWorkload[];
  /** Resolves argument-dependent workloads before application bootstrap. */
  prepareWorkloads?: (arguments_: readonly string[]) => readonly AppWorkload[];
}

export interface CliControllerOptions<
  InputSchema extends CliObjectSchema,
  OutputSchema extends ZodType | undefined,
  Dependencies extends DependencyDeclarations<never>,
> extends BaseCliControllerOptions<
    InputSchema,
    OutputSchema,
    Dependencies
  > {
  /** Command exposed by the standalone CLI controller. */
  command: string;
  handler: (
    context: CliControllerHandlerContext<InputSchema, Dependencies>,
  ) =>
    | ControllerHandlerResult<OutputSchema>
    | Promise<ControllerHandlerResult<OutputSchema>>;
}

export interface ActionCliControllerOptions<
  ActionInputSchema extends CliObjectSchema,
  ActionOutputSchema extends ZodType,
  ControllerInputSchema extends CliObjectSchema,
  ControllerOutputSchema extends ZodType | undefined,
  ControllerDependencies extends DependencyDeclarations<never>,
> extends BaseCliControllerOptions<
    ControllerInputSchema,
    ControllerOutputSchema,
    ControllerDependencies
  > {
  handler?: (
    context: ActionCliControllerHandlerContext<
      ActionInputSchema,
      ActionOutputSchema,
      ControllerInputSchema,
      ControllerDependencies
    >,
  ) =>
    | ControllerHandlerResult<ControllerOutputSchema>
    | Promise<ControllerHandlerResult<ControllerOutputSchema>>;
}

interface BaseCliController<
  InputSchema extends CliObjectSchema,
  OutputSchema extends ZodType | undefined,
  Dependencies extends DependencyDeclarations<never>,
> extends ControllerContract<InputSchema, OutputSchema, Dependencies> {
  readonly command: string;
  readonly bindings: CliInputBindings<InputSchema>;
  readonly middleware: readonly CliMiddleware<output<InputSchema>, any>[];
  readonly observe: boolean;
  readonly runningMode: AppRunningMode;
  readonly runtime?: AppRuntime;
  readonly workloads: readonly AppWorkload[];
  readonly prepareWorkloads?: (
    arguments_: readonly string[],
  ) => readonly AppWorkload[];
}

/** Defines a CLI command implemented directly by its transport handler. */
export interface StandaloneCliController<
  InputSchema extends CliObjectSchema = typeof emptyControllerInputSchema,
  OutputSchema extends ZodType | undefined = undefined,
  Dependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> extends BaseCliController<InputSchema, OutputSchema, Dependencies> {
  readonly source: "standalone";
  readonly handler: (
    context: CliControllerHandlerContext<InputSchema, Dependencies>,
  ) =>
    | ControllerHandlerResult<OutputSchema>
    | Promise<ControllerHandlerResult<OutputSchema>>;
}

/** Defines a CLI command that delegates to a reusable application action. */
export interface ActionCliController<
  ActionInputSchema extends CliObjectSchema = CliObjectSchema,
  ActionOutputSchema extends ZodType = ZodType,
  ActionDependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
  ControllerInputSchema extends CliObjectSchema = ActionInputSchema,
  ControllerOutputSchema extends ZodType | undefined = undefined,
  ControllerDependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> extends BaseCliController<
    ControllerInputSchema,
    ControllerOutputSchema,
    ControllerDependencies
  > {
  readonly source: "action";
  readonly action: Action<
    ActionInputSchema,
    ActionOutputSchema,
    ActionDependencies
  >;
  readonly handler?: (
    context: ActionCliControllerHandlerContext<
      ActionInputSchema,
      ActionOutputSchema,
      ControllerInputSchema,
      ControllerDependencies
    >,
  ) =>
    | ControllerHandlerResult<ControllerOutputSchema>
    | Promise<ControllerHandlerResult<ControllerOutputSchema>>;
}

export type CliController<
  ActionInputSchema extends CliObjectSchema = CliObjectSchema,
  ActionOutputSchema extends ZodType = ZodType,
  ActionDependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
  ControllerInputSchema extends CliObjectSchema = CliObjectSchema,
  ControllerOutputSchema extends ZodType | undefined = ZodType | undefined,
  ControllerDependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> =
  | StandaloneCliController<
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >
  | ActionCliController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >;

/** Defines a CLI controller independently from application actions. */
export function defineCliController<
  InputSchema extends CliObjectSchema = typeof emptyControllerInputSchema,
  OutputSchema extends ZodType | undefined = undefined,
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  options: CliControllerOptions<
    InputSchema,
    OutputSchema,
    Dependencies
  >,
): StandaloneCliController<InputSchema, OutputSchema, Dependencies> {
  const normalizedCommand = normalizeCommand(options.command);

  return {
    source: "standalone",
    validation: resolveValidation(options.validation),
    command: normalizedCommand,
    inputSchema: options.input ?? emptyControllerInputSchema as InputSchema,
    bindings: options.bindings ?? {},
    dependencies: options.dependencies ?? ({} as Dependencies),
    middleware: options.middleware ?? [],
    observe: options.observe ?? true,
    runningMode: options.runningMode ?? "standard",
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    workloads: options.workloads ?? [],
    ...(options.prepareWorkloads === undefined
      ? {}
      : { prepareWorkloads: options.prepareWorkloads }),
    handler: options.handler,
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.output === undefined
      ? {}
      : { outputSchema: options.output }),
  };
}

/** Defines a CLI controller that delegates to an application action. */
export function defineActionCliController<
  ActionInputSchema extends CliObjectSchema,
  ActionOutputSchema extends ZodType,
  const ActionDependencies extends DependencyDeclarations<never>,
  ControllerInputSchema extends CliObjectSchema = ActionInputSchema,
  ControllerOutputSchema extends ZodType | undefined = undefined,
  const ControllerDependencies extends DependencyDeclarations<never> = {},
>(
  action: Action<
    ActionInputSchema,
    ActionOutputSchema,
    ActionDependencies
  >,
  command: string,
  options: ActionCliControllerOptions<
    ActionInputSchema,
    ActionOutputSchema,
    ControllerInputSchema,
    ControllerOutputSchema,
    ControllerDependencies
  > = {},
): ActionCliController<
  ActionInputSchema,
  ActionOutputSchema,
  ActionDependencies,
  ControllerInputSchema,
  ControllerOutputSchema,
  ControllerDependencies
> {
  const normalizedCommand = normalizeCommand(command);

  return {
    source: "action",
    // Inherited schemas retain their policy unless explicitly overridden.
    validation: resolveValidation(options.validation ?? {
      input: options.input === undefined ? action.validation.input : "sync",
      output: "sync",
    }),
    action,
    command: normalizedCommand,
    inputSchema:
      options.input
      ?? (action.inputSchema as unknown as ControllerInputSchema),
    bindings: options.bindings ?? {},
    dependencies:
      options.dependencies ?? ({} as ControllerDependencies),
    middleware: options.middleware ?? [],
    observe: options.observe ?? true,
    runningMode: options.runningMode ?? "standard",
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    workloads: options.workloads ?? [],
    ...(options.prepareWorkloads === undefined
      ? {}
      : { prepareWorkloads: options.prepareWorkloads }),
    ...(options.description === undefined
      && action.description === undefined
      ? {}
      : { description: options.description ?? action.description }),
    ...(options.output === undefined
      ? {}
      : { outputSchema: options.output }),
    ...(options.handler === undefined
      ? {}
      : { handler: options.handler }),
  };
}

function normalizeCommand(command: string): string {
  const normalizedCommand = command.trim().replaceAll(/\s+/g, " ");

  if (normalizedCommand.length === 0) {
    throw new TypeError("A CLI command path cannot be empty.");
  }

  return normalizedCommand;
}
