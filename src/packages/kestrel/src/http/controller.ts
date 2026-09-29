import type {
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions,
} from "fastify";
import type {
  input,
  output,
  ZodType,
} from "zod";

import { resolveValidation, type ValidationOptions } from "../definitions/index.js";
import type {
  Action,
  ActionRunner,
} from "../actions/index.js";
import type { ActionExecution } from "../app/index.js";
import {
  type ControllerContract,
  type ControllerHandlerResult,
  type ControllerObjectSchema,
  type ControllerOutputSchema,
} from "../controllers/index.js";
import { emptyControllerInputSchema } from "../controllers/contract.js";
import type {
  DependencyDeclarations,
  ResolvedDependencies,
} from "../di/index.js";
import type { HttpInputBinding } from "./bindings.js";
import {
  type HttpAccessPolicy,
  validateHttpAccessPolicy,
} from "./access.js";
import {
  validateHttpControllerAudienceSelection,
  type HttpControllerAudience,
} from "./audiences/index.js";
import type { HttpMiddleware } from "./middleware.js";
import type { HttpRoute } from "./route.js";

export type HttpObjectSchema = ControllerObjectSchema;
export type HttpFastifyOptions = Omit<RouteShorthandOptions, "schema">;

/** Resolves the response contract exposed by an action-backed controller. */
export type ActionHttpControllerOutputSchema<
  ActionOutputSchema extends ZodType,
  ControllerOutputSchema extends ZodType | undefined,
> = ControllerOutputSchema extends ZodType
  ? ControllerOutputSchema
  : ActionOutputSchema;

type HttpInputBindings<InputSchema extends HttpObjectSchema> = Partial<
  Record<keyof output<InputSchema> & string, HttpInputBinding>
>;

/** One reusable request input exposed to HTTP tooling such as Studio. */
export interface HttpControllerExample<
  InputSchema extends HttpObjectSchema,
> {
  /** Optional label used when a controller provides several examples. */
  name?: string;
  input: input<InputSchema>;
}

export interface HttpControllerHandlerContext<
  InputSchema extends HttpObjectSchema,
  Dependencies extends DependencyDeclarations<never>,
> {
  input: output<InputSchema>;
  deps: ResolvedDependencies<Dependencies>;
  request: FastifyRequest;
  reply: FastifyReply;
  execution: ActionExecution;
}

export interface ActionHttpControllerHandlerContext<
  ActionInputSchema extends HttpObjectSchema,
  ActionOutputSchema extends ZodType,
  ControllerInputSchema extends HttpObjectSchema,
  ControllerDependencies extends DependencyDeclarations<never>,
> extends HttpControllerHandlerContext<
    ControllerInputSchema,
    ControllerDependencies
  > {
  action: ActionRunner<ActionInputSchema, ActionOutputSchema>;
}

interface BaseHttpControllerOptions<
  InputSchema extends HttpObjectSchema,
  OutputSchema extends ControllerOutputSchema,
  Dependencies extends DependencyDeclarations<never>,
> {
  /** Human-readable description exposed to documentation tooling. */
  description?: string;
  /** Stable identifier shared by generated clients and API documents. */
  operationId?: string;
  /** Selects the targets that may expose this contract. */
  audiences?: readonly HttpControllerAudience[];
  /** Declares HTTP input; omitted input defaults to an empty object. */
  input?: InputSchema;
  /** Selects parsing for this controller's input and output contracts. */
  validation?: ValidationOptions;
  /** Optionally validates and documents the returned transport value. */
  output?: OutputSchema;
  /** Overrides automatic path, query or body bindings for selected fields. */
  bindings?: HttpInputBindings<InputSchema>;
  /** Provides complete logical inputs for documentation and request tooling. */
  examples?: readonly HttpControllerExample<InputSchema>[];
  /** Dependencies resolved specifically for the HTTP handler. */
  dependencies?: Dependencies;
  /** Surrounds the controller handler in declaration order. */
  middleware?: readonly HttpMiddleware<output<InputSchema>, any>[];
  /** Overrides the conventional success status code. */
  successStatusCode?: number;
  /** Exposes Fastify route options without replacing Kestrel contracts. */
  fastify?: HttpFastifyOptions;
}

export interface HttpControllerOptions<
  InputSchema extends HttpObjectSchema,
  OutputSchema extends ControllerOutputSchema,
  Dependencies extends DependencyDeclarations<never>,
> extends BaseHttpControllerOptions<
    InputSchema,
    OutputSchema,
    Dependencies
  > {
  /** Explicit access boundary required before this controller may execute. */
  access: HttpAccessPolicy;
  /** Route exposed by the standalone HTTP controller. */
  route: HttpRoute;
  handler: (
    context: HttpControllerHandlerContext<InputSchema, Dependencies>,
  ) =>
    | ControllerHandlerResult<OutputSchema>
    | Promise<ControllerHandlerResult<OutputSchema>>;
}

export interface ActionHttpControllerOptions<
  ActionInputSchema extends HttpObjectSchema,
  ActionOutputSchema extends ZodType,
  ControllerInputSchema extends HttpObjectSchema,
  ControllerOutputSchema extends ZodType | undefined,
  ControllerDependencies extends DependencyDeclarations<never>,
> extends BaseHttpControllerOptions<
    ControllerInputSchema,
    ControllerOutputSchema,
    ControllerDependencies
  > {
  handler?: (
    context: ActionHttpControllerHandlerContext<
      ActionInputSchema,
      ActionOutputSchema,
      ControllerInputSchema,
      ControllerDependencies
    >,
  ) =>
    | ControllerHandlerResult<ActionHttpControllerOutputSchema<
      ActionOutputSchema,
      ControllerOutputSchema
    >>
    | Promise<ControllerHandlerResult<ActionHttpControllerOutputSchema<
      ActionOutputSchema,
      ControllerOutputSchema
    >>>;
}

interface BaseHttpController<
  InputSchema extends HttpObjectSchema,
  OutputSchema extends ControllerOutputSchema,
  Dependencies extends DependencyDeclarations<never>,
> extends ControllerContract<InputSchema, OutputSchema, Dependencies> {
  readonly access: HttpAccessPolicy;
  readonly route: HttpRoute;
  readonly operationId: string;
  readonly audiences?: readonly HttpControllerAudience[];
  readonly bindings: HttpInputBindings<InputSchema>;
  readonly examples?: readonly HttpControllerExample<InputSchema>[];
  readonly successStatusCode: number;
  readonly fastify: HttpFastifyOptions;
  readonly middleware: readonly HttpMiddleware<output<InputSchema>, any>[];
}

/** Defines an HTTP endpoint implemented directly by its transport handler. */
export interface StandaloneHttpController<
  InputSchema extends HttpObjectSchema = typeof emptyControllerInputSchema,
  OutputSchema extends ControllerOutputSchema = undefined,
  Dependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> extends BaseHttpController<InputSchema, OutputSchema, Dependencies> {
  readonly source: "standalone";
  readonly handler: (
    context: HttpControllerHandlerContext<InputSchema, Dependencies>,
  ) =>
    | ControllerHandlerResult<OutputSchema>
    | Promise<ControllerHandlerResult<OutputSchema>>;
}

/** Defines an HTTP endpoint that delegates to a reusable application action. */
export interface ActionHttpController<
  ActionInputSchema extends HttpObjectSchema = HttpObjectSchema,
  ActionOutputSchema extends ZodType = ZodType,
  ActionDependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
  ControllerInputSchema extends HttpObjectSchema = ActionInputSchema,
  ControllerOutputSchema extends ZodType | undefined = undefined,
  ControllerDependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> extends BaseHttpController<
    ControllerInputSchema,
    ControllerOutputSchema,
    ControllerDependencies
  > {
  readonly source: "action";
  /** Effective wire output, inherited from the action when not overridden. */
  readonly outputSchema: ControllerOutputSchema;
  readonly action: Action<
    ActionInputSchema,
    ActionOutputSchema,
    ActionDependencies
  >;
  readonly handler?: (
    context: ActionHttpControllerHandlerContext<
      ActionInputSchema,
      ActionOutputSchema,
      ControllerInputSchema,
      ControllerDependencies
    >,
  ) =>
    | ControllerHandlerResult<ControllerOutputSchema>
    | Promise<ControllerHandlerResult<ControllerOutputSchema>>;
}

export type HttpController<
  ActionInputSchema extends HttpObjectSchema = HttpObjectSchema,
  ActionOutputSchema extends ZodType = ZodType,
  ActionDependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
  ControllerInputSchema extends HttpObjectSchema = HttpObjectSchema,
  ControllerOutputSchema extends ZodType | undefined = ZodType | undefined,
  ControllerDependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> =
  | StandaloneHttpController<
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >
  | ActionHttpController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >;

/** Defines an HTTP controller independently from application actions. */
export function defineHttpController<
  InputSchema extends HttpObjectSchema = typeof emptyControllerInputSchema,
  OutputSchema extends ZodType | undefined = undefined,
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  options: HttpControllerOptions<
    InputSchema,
    OutputSchema,
    Dependencies
  >,
): StandaloneHttpController<InputSchema, OutputSchema, Dependencies> {
  return {
    source: "standalone",
    validation: resolveValidation(options.validation),
    access: validateHttpAccessPolicy(options.access),
    route: options.route,
    operationId: resolveHttpOperationId(
      options.operationId,
      `${options.route.method} ${options.route.url}`,
    ),
    ...(options.audiences === undefined
      ? {}
      : {
          audiences: validateHttpControllerAudienceSelection(
            options.audiences,
          ),
        }),
    inputSchema: options.input ?? emptyControllerInputSchema as InputSchema,
    bindings: options.bindings ?? {},
    ...(options.examples === undefined
      ? {}
      : { examples: options.examples }),
    dependencies: options.dependencies ?? ({} as Dependencies),
    middleware: options.middleware ?? [],
    successStatusCode: getSuccessStatusCode(
      options.route,
      options.successStatusCode,
    ),
    fastify: options.fastify ?? {},
    handler: options.handler,
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.output === undefined
      ? {}
      : { outputSchema: options.output }),
  };
}

/** Defines an HTTP controller that delegates to an application action. */
export function defineActionHttpController<
  ActionInputSchema extends HttpObjectSchema,
  ActionOutputSchema extends ZodType,
  const ActionDependencies extends DependencyDeclarations<never>,
  ControllerInputSchema extends HttpObjectSchema = ActionInputSchema,
  ControllerOutputSchema extends ZodType | undefined = undefined,
  const ControllerDependencies extends DependencyDeclarations<never> = {},
>(
  action: Action<
    ActionInputSchema,
    ActionOutputSchema,
    ActionDependencies
  >,
  route: HttpRoute,
  access: HttpAccessPolicy,
  options: ActionHttpControllerOptions<
    ActionInputSchema,
    ActionOutputSchema,
    ControllerInputSchema,
    ControllerOutputSchema,
    ControllerDependencies
  > = {},
): ActionHttpController<
  ActionInputSchema,
  ActionOutputSchema,
  ActionDependencies,
  ControllerInputSchema,
  ActionHttpControllerOutputSchema<
    ActionOutputSchema,
    ControllerOutputSchema
  >,
  ControllerDependencies
> {
  const controller = {
    source: "action",
    // Inherited schemas retain their policy unless explicitly overridden.
    validation: resolveValidation(options.validation ?? {
      input: options.input === undefined ? action.validation.input : "sync",
      output: options.output === undefined ? action.validation.output : "sync",
    }),
    action,
    access: validateHttpAccessPolicy(access),
    route,
    operationId: resolveHttpOperationId(
      options.operationId,
      action.name,
    ),
    ...(options.audiences === undefined
      ? {}
      : {
          audiences: validateHttpControllerAudienceSelection(
            options.audiences,
          ),
        }),
    inputSchema:
      options.input
      ?? (action.inputSchema as unknown as ControllerInputSchema),
    bindings: options.bindings ?? {},
    ...(options.examples === undefined
      ? {}
      : { examples: options.examples }),
    dependencies:
      options.dependencies ?? ({} as ControllerDependencies),
    middleware: options.middleware ?? [],
    successStatusCode: getSuccessStatusCode(route, options.successStatusCode),
    fastify: options.fastify ?? {},
    ...(options.description === undefined
      && action.description === undefined
      ? {}
      : { description: options.description ?? action.description }),
    // The action schema is the effective wire response contract unless the
    // controller explicitly replaces it for a transport-specific mapping.
    outputSchema: options.output ?? action.outputSchema,
    ...(options.handler === undefined
      ? {}
      : { handler: options.handler }),
  };

  return controller as ActionHttpController<
    ActionInputSchema,
    ActionOutputSchema,
    ActionDependencies,
    ControllerInputSchema,
    ActionHttpControllerOutputSchema<
      ActionOutputSchema,
      ControllerOutputSchema
    >,
    ControllerDependencies
  >;
}

function resolveHttpOperationId(
  configuredOperationId: string | undefined,
  fallbackOperationId: string,
): string {
  const operationId = configuredOperationId ?? fallbackOperationId;

  if (operationId.trim() === "") {
    throw new TypeError(
      "An HTTP controller operation identifier cannot be empty.",
    );
  }

  return operationId;
}

function getSuccessStatusCode(
  route: HttpRoute,
  configuredStatusCode: number | undefined,
): number {
  const successStatusCode =
    configuredStatusCode ?? (route.method === "POST" ? 201 : 200);

  if (
    !Number.isInteger(successStatusCode)
    || successStatusCode < 200
    || successStatusCode > 299
  ) {
    throw new TypeError(
      "An HTTP controller success status code must be a 2xx integer.",
    );
  }

  return successStatusCode;
}
