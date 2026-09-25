import type { ActionExecution } from "../app/index.js";
import type { DependencyDeclarations } from "../di/index.js";
import {
  defineMiddleware,
  type Middleware,
  type MiddlewareOptions,
} from "../middleware/index.js";

/** CLI controller metadata available to transport middleware. */
export interface CliMiddlewareTarget {
  readonly source: "standalone" | "action";
  readonly command: string;
  readonly description?: string;
}

/** Context available while surrounding one validated CLI execution. */
export interface CliMiddlewareContext<Input> {
  readonly controller: CliMiddlewareTarget;
  readonly input: Input;
  readonly execution: ActionExecution;
}

export type CliMiddleware<
  Input,
  Dependencies extends DependencyDeclarations<never> = DependencyDeclarations<never>,
> = Middleware<CliMiddlewareContext<Input>, Dependencies>;

/** Defines middleware that can be attached to compatible CLI controllers. */
export function defineCliMiddleware<
  Input = unknown,
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  name: string,
  options: MiddlewareOptions<
    CliMiddlewareContext<Input>,
    Dependencies
  >,
): CliMiddleware<Input, Dependencies> {
  return defineMiddleware(name, options);
}
