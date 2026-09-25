import type {
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type { ActionExecution } from "../app/index.js";
import type { DependencyDeclarations } from "../di/index.js";
import {
  defineMiddleware,
  type Middleware,
  type MiddlewareOptions,
} from "../middleware/index.js";
import type { HttpRoute } from "./route.js";

/** HTTP controller metadata available to transport middleware. */
export interface HttpMiddlewareTarget {
  readonly source: "standalone" | "action";
  readonly route: HttpRoute;
  readonly description?: string;
}

/** Context available while surrounding one validated HTTP execution. */
export interface HttpMiddlewareContext<Input> {
  readonly controller: HttpMiddlewareTarget;
  readonly input: Input;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly execution: ActionExecution;
}

export type HttpMiddleware<
  Input,
  Dependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> = Middleware<HttpMiddlewareContext<Input>, Dependencies>;

/** Defines middleware that can be attached to compatible HTTP controllers. */
export function defineHttpMiddleware<
  Input = unknown,
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  name: string,
  options: MiddlewareOptions<
    HttpMiddlewareContext<Input>,
    Dependencies
  >,
): HttpMiddleware<Input, Dependencies> {
  return defineMiddleware(name, options);
}
