import {
  OutboundHttpAbortedError,
  OutboundHttpTimeoutError,
  OutboundHttpTransportError,
} from "../../errors.js";
import { defineOutboundHttpMiddleware, parseRetryAfter } from "../../middleware.js";
import {
  outboundHttpMiddlewarePriorities,
  type OutboundHttpMiddleware,
} from "../../types.js";

export interface RetryOutboundHttpOptions {
  readonly maxAttempts?: number;
  readonly methods?: readonly string[];
  readonly statuses?: readonly number[];
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly priority?: number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

const defaultMethods = Object.freeze(["DELETE", "GET", "HEAD", "OPTIONS", "PUT"]);
const defaultStatuses = Object.freeze([408, 425, 429, 500, 502, 503, 504]);

/** Replays safe outbound attempts with bounded exponential backoff. */
export function retryRequests(
  options: RetryOutboundHttpOptions = {},
): OutboundHttpMiddleware {
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const methods = new Set((options.methods ?? defaultMethods).map(normalizeMethod));
  const statuses = new Set(options.statuses ?? defaultStatuses);
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? sleepWithSignal;

  validateOptions(maxAttempts, initialDelayMs, maxDelayMs, jitterRatio);

  return defineOutboundHttpMiddleware("outbound-http.retry", {
    priority: options.priority ?? outboundHttpMiddlewarePriorities.retry,
    handler: async (context, next) => {
      if (!methods.has(context.request.method)) return next();

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        context.request.signal.throwIfAborted();
        let response: Response;

        try {
          // Cloning the untouched template gives every attempt a fresh body.
          response = await next({
            request: context.request.clone(),
            attempt,
          });
        } catch (error: unknown) {
          if (context.request.signal.aborted || attempt === maxAttempts || !isRetryableError(error)) throw error;

          await sleep(
            jitteredDelay(initialDelayMs, maxDelayMs, attempt, jitterRatio, random),
            context.request.signal,
          );
          continue;
        }

        if (attempt === maxAttempts || !statuses.has(response.status)) {
          return response;
        }

        const delayMs = retryAfterDelay(response)
          ?? jitteredDelay(initialDelayMs, maxDelayMs, attempt, jitterRatio, random);

        // Request disposal immediately even when the source cannot finish cancelling yet.
        void response.body?.cancel().catch(() => {});
        await sleep(Math.min(maxDelayMs, delayMs), context.request.signal);
      }

      throw new Error("Outbound HTTP retry loop completed unexpectedly.");
    },
  });
}

function isRetryableError(error: unknown): boolean {
  return error instanceof OutboundHttpTimeoutError
    || error instanceof OutboundHttpTransportError;
}

function retryAfterDelay(response: Response): number | undefined {
  const nowMs = Date.now();
  const instant = parseRetryAfter(response.headers.get("retry-after"), nowMs);
  return instant === undefined ? undefined : Math.max(0, instant - nowMs);
}

function jitteredDelay(
  initialDelayMs: number,
  maxDelayMs: number,
  attempt: number,
  jitterRatio: number,
  random: () => number,
): number {
  const base = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
  const factor = 1 + (random() * 2 - 1) * jitterRatio;

  // The configured maximum bounds jittered transport failures as well as HTTP responses.
  return Math.min(maxDelayMs, Math.max(0, base * factor));
}

function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(getAbortReason(signal));

  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      clearTimeout(timeout);
      resolve();
    };
    const abort = () => {
      signal.removeEventListener("abort", abort);
      clearTimeout(timeout);
      reject(getAbortReason(signal));
    };
    // Native timers clamp larger delays to one millisecond. Keep one logical
    // monotonic deadline while rearming bounded intervals under the same signal.
    const expiresAt = performance.now() + delayMs;
    let timeout: ReturnType<typeof setTimeout>;
    const wake = () => {
      const remaining = expiresAt - performance.now();
      if (remaining > 0) {
        timeout = setTimeout(wake, Math.min(remaining, 2_147_483_647));
        timeout.unref();
      } else {
        finish();
      }
    };
    // Preserve an asynchronous timer turn even for an explicitly zero delay.
    timeout = setTimeout(wake, Math.min(delayMs, 2_147_483_647));
    timeout.unref();
    signal.addEventListener("abort", abort, { once: true });
  });
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new OutboundHttpAbortedError("retry backoff", { cause: signal.reason });
}

function normalizeMethod(value: string): string {
  const normalized = value.trim().toUpperCase();

  if (normalized.length === 0) {
    throw new TypeError("A retryable HTTP method cannot be empty.");
  }

  return normalized;
}

function validateOptions(
  maxAttempts: number,
  initialDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
): void {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("Retry maxAttempts must be a positive integer.");
  }

  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0
    || !Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new TypeError("Retry delays must be finite and maxDelayMs must cover initialDelayMs.");
  }

  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new TypeError("Retry jitterRatio must be between zero and one.");
  }
}
