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
import { defineOutboundHttpMiddleware, parseRetryAfter } from "../../middleware.js";
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
        // Admission may have a shorter caller-owned cancellation boundary as well.
        signal: configuredAcquire?.signal === undefined
          ? context.request.signal
          : AbortSignal.any([context.request.signal, configuredAcquire.signal]),
      };

      return options.throttling.run(definition, acquire, async (permit) => {
        try {
          const response = await next();
          const feedback = classifyResponse(response);

          if (feedback !== undefined) permit.reportFeedback(feedback);

          return response;
        } catch (error: unknown) {
          permit.reportFeedback(classifyError(error));
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

function classifyError(error: unknown): ThrottlingFeedback {
  if (error instanceof OutboundHttpTimeoutError) return { kind: "timeout" };
  if (error instanceof OutboundHttpTransportError) return { kind: "transient" };
  // A caller abandoning its own request provides no evidence about dependency health.
  if (error instanceof OutboundHttpAbortedError) return { kind: "cancelled" };

  return { kind: "permanent" };
}

function getRetryAt(response: Response): Date | undefined {
  const instant = parseRetryAfter(response.headers.get("retry-after"), Date.now());
  if (instant === undefined) return undefined;
  const retryAt = new Date(instant);
  // A large delay must still fit within the Date range used by the feedback API.
  return Number.isNaN(retryAt.getTime()) ? undefined : retryAt;
}
