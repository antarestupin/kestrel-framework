import type {
  DependencyContainer,
  DependencyDeclarations,
  ResolvedDependencies,
} from "../di/index.js";

/** Replays the remaining middleware pipeline and returns its result type. */
export type MiddlewareNext<Result> = () => Promise<Result>;

/**
 * Describes one named, inspectable middleware with independently resolved
 * dependencies.
 *
 * The handler is generic over Result so middleware can surround or replay an
 * execution, but cannot replace its successful result with another type.
 */
export interface Middleware<
  Context,
  Dependencies extends DependencyDeclarations<never>,
> {
  readonly name: string;
  readonly dependencies: Dependencies;
  readonly handler: <Result>(
    context: Context & {
      deps: ResolvedDependencies<Dependencies>;
    },
    next: MiddlewareNext<Result>,
  ) => Promise<Result>;
}

export interface MiddlewareOptions<
  Context,
  Dependencies extends DependencyDeclarations<never>,
> {
  dependencies?: Dependencies;
  handler: Middleware<Context, Dependencies>["handler"];
}

/** Creates a middleware definition without binding it to an application. */
export function defineMiddleware<
  Context,
  const Dependencies extends DependencyDeclarations<never> = {},
>(
  name: string,
  options: MiddlewareOptions<Context, Dependencies>,
): Middleware<Context, Dependencies> {
  const normalizedName = name.trim();

  if (normalizedName.length === 0) {
    throw new TypeError("A middleware name cannot be empty.");
  }

  return {
    name: normalizedName,
    dependencies: options.dependencies ?? ({} as Dependencies),
    handler: options.handler,
  };
}

/**
 * Runs middleware in declaration order and unwinds it in reverse order.
 */
export function runMiddlewarePipeline<Context, Result, Config>(
  middleware: readonly Middleware<Context, any>[],
  context: Context,
  container: Pick<DependencyContainer<Config>, "resolveDependencies">,
  terminal: MiddlewareNext<Result>,
): Promise<Result> {
  const dispatch = async (nextIndex: number): Promise<Result> => {
    const current = middleware[nextIndex];

    if (current === undefined) {
      return terminal();
    }

    const dependencies = container.resolveDependencies(
      current.dependencies,
    );

    return current.handler(
      { ...context, deps: dependencies },
      // Every continuation call starts a fresh traversal of the suffix.
      () => dispatch(nextIndex + 1),
    );
  };

  return dispatch(0);
}
