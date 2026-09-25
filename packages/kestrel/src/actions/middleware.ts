import type {
  DependencyDeclarations,
} from "../di/index.js";
import {
  defineMiddleware,
  type Middleware,
  type MiddlewareOptions,
} from "../middleware/index.js";

/** Inspectable action metadata exposed without coupling middleware to schemas. */
export interface ActionMiddlewareTarget {
  readonly name: string;
  readonly description?: string;
}

/** Context available while surrounding one validated action execution. */
export interface ActionMiddlewareContext {
  readonly action: ActionMiddlewareTarget;
  readonly input: unknown;
}

export type ActionMiddleware<
  Dependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> = Middleware<ActionMiddlewareContext, Dependencies>;

/** Defines middleware that can be attached to compatible actions. */
export function defineActionMiddleware<
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  name: string,
  options: MiddlewareOptions<
    ActionMiddlewareContext,
    Dependencies
  >,
): ActionMiddleware<Dependencies> {
  return defineMiddleware(name, options);
}
