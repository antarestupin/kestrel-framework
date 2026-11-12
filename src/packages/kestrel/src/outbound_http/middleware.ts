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
  protectResponse: (response: Response) => Response = (response) => response,
  check: () => void = () => {},
): Promise<Response> {
  const dispatch = async (
    index: number,
    current: OutboundHttpMiddlewareContext,
  ): Promise<Response> => {
    check();
    const definition = middleware[index];

    if (definition === undefined) {
      return protectResponse(await terminal(current));
    }

    return protectResponse(await definition.handler(current, (options: OutboundHttpNextOptions = {}) =>
      dispatch(index + 1, {
        ...current,
        ...(options.request === undefined
          ? {}
          : { request: new Request(options.request, {
              // Request replacement must not detach downstream work from its owner.
              signal: AbortSignal.any([current.request.signal, options.request.signal]),
            }) }),
        ...(options.attempt === undefined
          ? {}
          : { attempt: options.attempt }),
      })));
  };

  return dispatch(0, context);
}

/** Parses Retry-After as decimal delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  if (/^\d+$/u.test(header)) {
    const timestamp = nowMs + Number(header) * 1_000;
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  // Date.parse also accepts bare signed numbers and other non-HTTP formats.
  if (!/^[a-z]{3,9}[, ]/iu.test(header) || !/\d{2}:\d{2}:\d{2}/u.test(header)) return undefined;
  const timestamp = Date.parse(header.includes(",") ? header : `${header} GMT`);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}
