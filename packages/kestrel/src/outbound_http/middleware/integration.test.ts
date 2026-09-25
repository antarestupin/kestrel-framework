import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { Cache, CacheRememberOptions, CacheWriteOptions, TagAwareCache } from "../../cache/index.js";
import {
  defineRateLimit,
  seconds,
  type Throttling,
  type ThrottlingRunContext,
} from "../../throttling/index.js";
import {
  cacheResponse,
  cacheResponses,
  createOutboundHttpClient,
  json,
  retryRequests,
  throttleRequests,
} from "../index.js";

// These calls are checked by tsc, without executing intentionally invalid usage.
function checkCachePolicyTypes(cache: Cache, tagged: TagAwareCache) {
  const taggedPolicy = { key: "key", tags: ["group"] };
  // @ts-expect-error Middleware cannot reintroduce tags on a basic cache.
  cacheResponse({ cache, ...taggedPolicy });
  // @ts-expect-error Dynamic policies also require the stronger capability.
  cacheResponses({ cache, policy: () => taggedPolicy });
  cacheResponse({ cache: tagged, ...taggedPolicy });
  cacheResponses({ cache: tagged, policy: () => taggedPolicy });
}
void checkCachePolicyTypes;

describe("outbound HTTP capability middleware", () => {
  it("rejects unsupported tag policies before calling the source", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ value: 42 }));
    const cache: Cache = new MemoryCache();
    const client = createOutboundHttpClient({
      name: "partner", baseUrl: "https://partner.example", fetch: fetchImplementation,
      // @ts-expect-error Exercise the runtime boundary for untyped consumers.
      middleware: [cacheResponse({ cache, key: "key", tags: ["group"] })],
    });
    await expect(client.get("/resource")).rejects.toThrow("TagAwareCache");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("retries each network attempt through throttling and caches only the success", async () => {
    const cache = new MemoryCache();
    const feedback: unknown[] = [];
    let throttlingRuns = 0;
    const throttling = createThrottling(async (handler) => {
      throttlingRuns += 1;

      return handler({
        reportActualCost: () => {},
        reportFeedback: (value) => feedback.push(value),
      });
    });
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ value: 42 }));
    const client = createOutboundHttpClient({
      name: "partner",
      baseUrl: "https://partner.example",
      fetch: fetchImplementation as typeof globalThis.fetch,
      middleware: [
        retryRequests({
          initialDelayMs: 0,
          jitterRatio: 0,
          sleep: async () => {},
        }),
        throttleRequests({
          throttling,
          definition: defineRateLimit({
            id: "partner-api",
            requests: 10,
            per: seconds(1),
          }),
        }),
      ],
    });
    const requestOptions = {
      response: json(z.object({ value: z.number() })),
      middleware: [cacheResponse({
        cache,
        key: "resource:42",
        ttlSeconds: 60,
      })],
    };

    await expect(client.get("/resources/42", requestOptions))
      .resolves.toEqual({ value: 42 });
    await expect(client.get("/resources/42", requestOptions))
      .resolves.toEqual({ value: 42 });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(throttlingRuns).toBe(2);
    expect(feedback).toContainEqual({ kind: "transient" });
    expect(cache.keys()).toEqual(["outbound-http:partner:resource:42"]);
  });

  it("does not retry unsafe methods unless their method is explicitly enabled", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response("busy", { status: 503 })) as typeof globalThis.fetch;
    const client = createOutboundHttpClient({
      name: "partner",
      baseUrl: "https://partner.example",
      fetch: fetchImplementation,
      middleware: [retryRequests({
        maxAttempts: 3,
        initialDelayMs: 0,
        jitterRatio: 0,
        sleep: async () => {},
      })],
    });

    await expect(client.post("/commands", { json: { command: "run" } }))
      .rejects.toMatchObject({ status: 503 });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});

class MemoryCache implements Cache {
  private readonly values = new Map<string, unknown>();

  public async get<Value>(key: string): Promise<Value | undefined> {
    return this.values.get(key) as Value | undefined;
  }

  public async set<Value>(
    key: string,
    value: Value,
    _options?: CacheWriteOptions,
  ): Promise<void> {
    this.values.set(key, value);
  }

  public async remember<Value>(
    key: string,
    loader: () => Promise<Value>,
    _options?: CacheRememberOptions,
  ): Promise<Value> {
    const existing = await this.get<Value>(key);

    if (existing !== undefined) return existing;

    const value = await loader();
    await this.set(key, value);

    return value;
  }

  public async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

function createThrottling(
  run: <Value>(
    handler: (context: ThrottlingRunContext) => Promise<Value>,
  ) => Promise<Value>,
): Throttling {
  return {
    acquire: vi.fn(),
    close: vi.fn(),
    inspect: vi.fn(),
    run: (async (...args: unknown[]) => {
      const handler = args.at(-1) as (
        context: ThrottlingRunContext,
      ) => Promise<unknown>;

      return run(handler);
    }) as Throttling["run"],
  };
}
