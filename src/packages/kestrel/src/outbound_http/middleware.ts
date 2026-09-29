import {
  outboundHttpMiddlewarePriorities,
  type DefineOutboundHttpMiddlewareOptions,
  type OutboundHttpMiddleware,
  type OutboundHttpMiddlewareContext,
  type OutboundHttpNextOptions,
} from "./types.js";

/** Defines one named outbound middleware with stable numeric ordering. */
export function defineOutboundHttpMiddleware(
  name: string,
  options: DefineOutboundHttpMiddlewareOptions,
): OutboundHttpMiddleware {
  const normalizedName = name.trim();
  const priority = options.priority
    ?? outboundHttpMiddlewarePriorities.default;

  if (normalizedName.length === 0) {
    throw new TypeError("An outbound HTTP middleware name cannot be empty.");
  }

  if (!Number.isFinite(priority)) {
    throw new TypeError("An outbound HTTP middleware priority must be finite.");
  }

  return Object.freeze({
    name: normalizedName,
    priority,
    handler: options.handler,
  });
}

/** Stable priority ordering preserves client-before-request declaration ties. */
export function orderOutboundHttpMiddleware(
  middleware: readonly OutboundHttpMiddleware[],
): readonly OutboundHttpMiddleware[] {
  return middleware
    .map((definition, index) => ({ definition, index }))
    .sort((left, right) =>
      left.definition.priority - right.definition.priority
      || left.index - right.index)
    .map(({ definition }) => definition);
}

/** Runs the replayable outbound onion around one native fetch terminal. */
export function runOutboundHttpMiddleware(
  middleware: readonly OutboundHttpMiddleware[],
  context: OutboundHttpMiddlewareContext,
  terminal: (context: OutboundHttpMiddlewareContext) => Promise<Response>,
): Promise<Response> {
  const dispatch = (
    index: number,
    current: OutboundHttpMiddlewareContext,
  ): Promise<Response> => {
    const definition = middleware[index];

    if (definition === undefined) {
      return terminal(current);
    }

    return definition.handler(current, (options: OutboundHttpNextOptions = {}) =>
      dispatch(index + 1, {
        ...current,
        ...(options.request === undefined
          ? {}
          : { request: options.request }),
        ...(options.attempt === undefined
          ? {}
          : { attempt: options.attempt }),
      }));
  };

  return dispatch(0, context);
}
