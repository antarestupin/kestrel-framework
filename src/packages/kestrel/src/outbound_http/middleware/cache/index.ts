import {
  isTagAwareCache,
  type Cache,
  type CacheRememberOptions,
  type TagAwareCache,
  type TagAwareCacheRememberOptions,
} from "../../../cache/index.js";
import { OutboundHttpResponseTooLargeError } from "../../errors.js";
import { defineOutboundHttpMiddleware } from "../../middleware.js";
import {
  outboundHttpMiddlewarePriorities,
  type OutboundHttpMiddleware,
  type OutboundHttpMiddlewareContext,
} from "../../types.js";

/** Tag options are available only when the supplied cache advertises them. */
export type OutboundHttpCachePolicy<CacheType extends Cache = Cache> = {
  readonly key: string;
  /** Response headers retained with the cached body. */
  readonly headers?: readonly string[];
} & (CacheType extends TagAwareCache ? TagAwareCacheRememberOptions : CacheRememberOptions);

export type CacheOutboundHttpOptions<CacheType extends Cache = Cache> =
  OutboundHttpCachePolicy<CacheType> & {
    readonly cache: CacheType;
    readonly methods?: readonly string[];
    readonly priority?: number;
  };

export interface CacheOutboundHttpResponsesOptions<CacheType extends Cache = Cache> {
  readonly cache: CacheType;
  readonly policy: (
    context: OutboundHttpMiddlewareContext,
  ) => OutboundHttpCachePolicy<CacheType> | undefined;
  readonly methods?: readonly string[];
  readonly priority?: number;
}

// Runtime composition verifies capabilities as TypeScript cannot validate a
// backend chosen through deployment configuration or untyped callers.
interface RuntimeCacheOptions {
  readonly cache: Cache;
  readonly policy: (
    context: OutboundHttpMiddlewareContext,
  ) => OutboundHttpCachePolicy<TagAwareCache> | undefined;
  readonly methods?: readonly string[];
  readonly priority?: number;
}

interface CachedHttpResponse {
  readonly schemaVersion: 1;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBase64: string;
}

class UncacheableResponse extends Error {
  public constructor(
    public readonly response: Response,
    public readonly owner: Request,
  ) {
    super("The outbound HTTP response is not cacheable.");
  }
}

const defaultMethods = Object.freeze(["GET", "HEAD"]);
const defaultHeaders = Object.freeze(["content-type"]);

/** Adds one fixed cache policy to a client or individual request. */
export function cacheResponse<CacheType extends Cache>(
  options: CacheOutboundHttpOptions<CacheType>,
): OutboundHttpMiddleware;
export function cacheResponse(
  options: Omit<CacheOutboundHttpOptions<TagAwareCache>, "cache"> & { cache: Cache },
): OutboundHttpMiddleware {
  const {
    cache,
    methods,
    priority,
    ...policy
  } = options;

  return createCacheMiddleware({
    cache,
    ...(methods === undefined ? {} : { methods }),
    ...(priority === undefined ? {} : { priority }),
    policy: () => policy,
  });
}

/** Selects cache behavior dynamically from stable request metadata. */
export function cacheResponses<CacheType extends Cache>(
  options: CacheOutboundHttpResponsesOptions<CacheType>,
): OutboundHttpMiddleware {
  return createCacheMiddleware(options);
}

function createCacheMiddleware(options: RuntimeCacheOptions): OutboundHttpMiddleware {
  const methods = new Set((options.methods ?? defaultMethods).map((method) =>
    method.trim().toUpperCase()));

  return defineOutboundHttpMiddleware("outbound-http.cache", {
    priority: options.priority ?? outboundHttpMiddlewarePriorities.cache,
    handler: async (context, next) => {
      if (!methods.has(context.request.method)) return next();

      const policy = options.policy(context);

      if (policy === undefined) return next();

      const key = composeCacheKey(context.client, policy.key);
      const cache = options.cache;
      if (policy.tags !== undefined && !isTagAwareCache(cache)) {
        throw new TypeError("Outbound HTTP cache tags require a TagAwareCache.");
      }

      try {
        const loader = async (): Promise<CachedHttpResponse> => {
          context.request.signal.throwIfAborted();
          const response = await next();
          // Error diagnostics are truncated by the client, never buffered by cache.
          if (!response.ok) throw new UncacheableResponse(response, context.request);
          const serialized = await serializeResponse(
            response,
            policy.headers ?? defaultHeaders,
          );

          context.request.signal.throwIfAborted();
          return serialized;
        };
        const writeOptions: CacheRememberOptions = {
          ...(policy.ttlSeconds === undefined ? {} : { ttlSeconds: policy.ttlSeconds }),
          ...(policy.lock === undefined ? {} : { lock: policy.lock }),
        };
        const cached = isTagAwareCache(cache)
          ? await cache.remember(key, loader, {
              ...writeOptions,
              ...(policy.tags === undefined ? {} : { tags: policy.tags }),
            })
          : await cache.remember(key, loader, writeOptions);

        return restoreResponse(cached, context);
      } catch (error: unknown) {
        if (error instanceof UncacheableResponse) {
          // A coalesced waiter cannot consume the load owner's one-shot error stream.
          return error.owner === context.request ? error.response : next();
        }

        throw error;
      }
    },
  });
}

async function serializeResponse(
  response: Response,
  retainedHeaderNames: readonly string[],
): Promise<CachedHttpResponse> {
  const headers: Record<string, string> = {};

  for (const name of retainedHeaderNames) {
    const value = response.headers.get(name);

    if (value !== null) headers[name.toLowerCase()] = value;
  }

  return {
    schemaVersion: 1,
    status: response.status,
    statusText: response.statusText,
    headers,
    bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
}

function restoreResponse(
  cached: CachedHttpResponse,
  context: OutboundHttpMiddlewareContext,
): Response {
  if (cached.schemaVersion !== 1) {
    throw new TypeError("Unsupported cached outbound HTTP response schema.");
  }

  context.request.signal.throwIfAborted();
  // Canonical base64 allows an exact size check before allocating decoded bytes.
  const encoded = cached.bodyBase64;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = encoded.length / 4 * 3 - padding;
  if (byteLength > context.maxResponseBytes) {
    throw new OutboundHttpResponseTooLargeError(context.operation, context.maxResponseBytes);
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new TypeError("Invalid cached outbound HTTP response body.");
  }

  return new Response(Buffer.from(encoded, "base64"), {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
}

function composeCacheKey(client: string, key: string): string {
  const normalized = key.trim();

  if (normalized.length === 0) {
    throw new TypeError("An outbound HTTP cache key cannot be empty.");
  }

  return `outbound-http:${client}:${normalized}`;
}
