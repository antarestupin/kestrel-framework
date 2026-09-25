import {
  type Throttling,
  type ThrottlingDefinition,
  type ThrottlingFeedback,
  type ThrottlingRunOptions,
} from "../../../throttling/index.js";
import {
  OutboundHttpAbortedError,
  OutboundHttpTimeoutError,
  OutboundHttpTransportError,
} from "../../errors.js";
import { defineOutboundHttpMiddleware } from "../../middleware.js";
import {
  outboundHttpMiddlewarePriorities,
  type OutboundHttpMiddleware,
  type OutboundHttpMiddlewareContext,
} from "../../types.js";

export interface ThrottleOutboundHttpOptions {
  readonly throttling: Throttling;
  readonly definition:
    | ThrottlingDefinition
    | ((context: OutboundHttpMiddlewareContext) => ThrottlingDefinition);
  readonly acquire?:
    | ThrottlingRunOptions
    | ((context: OutboundHttpMiddlewareContext) => ThrottlingRunOptions);
  readonly priority?: number;
}

/** Applies admission and classified dependency feedback to every attempt. */
export function throttleRequests(
  options: ThrottleOutboundHttpOptions,
): OutboundHttpMiddleware {
  return defineOutboundHttpMiddleware("outbound-http.throttling", {
    priority: options.priority ?? outboundHttpMiddlewarePriorities.throttling,
    handler: (context, next) => {
      const definition = typeof options.definition === "function"
        ? options.definition(context)
        : options.definition;
      const configuredAcquire = typeof options.acquire === "function"
        ? options.acquire(context)
        : options.acquire;
      const acquire = {
        ...configuredAcquire,
        signal: configuredAcquire?.signal ?? context.request.signal,
      };

      return options.throttling.run(definition, acquire, async (permit) => {
        try {
          const response = await next();
          const feedback = classifyResponse(response);

          if (feedback !== undefined) permit.reportFeedback(feedback);

          return response;
        } catch (error: unknown) {
          const feedback = classifyError(error);

          if (feedback !== undefined) permit.reportFeedback(feedback);

          throw error;
        }
      });
    },
  });
}

function classifyResponse(response: Response): ThrottlingFeedback | undefined {
  if (response.status === 429) {
    const retryAt = getRetryAt(response);

    return {
      kind: "throttled",
      ...(retryAt === undefined ? {} : { retryAt }),
    };
  }

  if ([408, 425, 500, 502, 503, 504].includes(response.status)) {
    return { kind: "transient" };
  }

  return response.ok ? undefined : { kind: "permanent" };
}

function classifyError(error: unknown): ThrottlingFeedback | undefined {
  if (error instanceof OutboundHttpTimeoutError) return { kind: "timeout" };
  if (error instanceof OutboundHttpTransportError) return { kind: "transient" };
  if (error instanceof OutboundHttpAbortedError) return undefined;

  return { kind: "permanent" };
}

function getRetryAt(response: Response): Date | undefined {
  const value = response.headers.get("retry-after")?.trim();

  if (value === undefined || value === "") return undefined;

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(Date.now() + seconds * 1_000);
  }

  const instant = Date.parse(value);

  return Number.isNaN(instant) ? undefined : new Date(instant);
}
