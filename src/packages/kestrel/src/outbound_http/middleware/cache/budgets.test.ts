import { afterEach, describe, expect, it, vi } from "vitest";
import { CachePool, TagAwareCachePool } from "../../../cache/cache_pool.js";
import { MemoryCacheAdapter } from "../../../cache/adapters/memory/index.js";
import {
  cacheResponse, cacheResponses, createOutboundHttpClient, text,
  OutboundHttpAbortedError, OutboundHttpResponseTooLargeError, OutboundHttpTimeoutError,
} from "../../index.js";

function setup(fetch: typeof globalThis.fetch) {
  const adapter = new MemoryCacheAdapter({ maxEntries: 10, maxSizeBytes: 1_000_000, maxEntrySizeBytes: 1_000_000 });
  const cache = new CachePool(adapter, {
    namespace: "test", defaultTtlSeconds: 60, maxTtlSeconds: 60, maxEntrySizeBytes: 1_000_000,
  });
  const http = createOutboundHttpClient({
    name: "cached", baseUrl: "https://api.example", fetch,
    middleware: [cacheResponse({ cache, key: "body" })],
  });
  return { cache, http, adapter };
}

afterEach(() => vi.useRealTimers());

describe("outbound response cache budgets", () => {
  it("skips unselected requests and forwards lock, expiry, and tag policy to a tagged cache", async () => {
    const adapter = new MemoryCacheAdapter({ maxEntries: 10, maxSizeBytes: 1_000_000, maxEntrySizeBytes: 1_000_000 });
    const cache = new TagAwareCachePool(adapter, {
      namespace: "test", defaultTtlSeconds: 60, maxTtlSeconds: 60, maxEntrySizeBytes: 1_000_000,
    });
    const remember = vi.spyOn(cache, "remember");
    const select = vi.fn((route: string) => {
      if (route === "/tagged") return { key: " selected ", tags: ["group"], ttlSeconds: 10, lock: false, headers: ["etag"] };
      return route === "/untagged" ? { key: "untagged" } : undefined;
    });
    const fetch = vi.fn(async () => new Response("payload", { headers: { etag: '"revision"', "set-cookie": "private=value" } }));
    const client = createOutboundHttpClient({
      name: "partner", baseUrl: "https://partner.example", fetch,
      middleware: [cacheResponses({ cache, policy: ({ route }) => select(route) })],
    });

    await expect(client.post("/tagged", { response: text() })).resolves.toBe("payload");
    expect(select).not.toHaveBeenCalled();
    await expect(client.get("/uncached", { response: text() })).resolves.toBe("payload");
    expect(select).toHaveBeenCalledExactlyOnceWith("/uncached");
    expect(remember).not.toHaveBeenCalled();

    for (let request = 0; request < 2; request += 1) {
      const response = await client.get("/tagged");
      expect(response.headers.get("etag")).toBe('"revision"');
      expect(response.headers.has("set-cookie")).toBe(false);
      await expect(response.text()).resolves.toBe("payload");
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(remember).toHaveBeenLastCalledWith("outbound-http:partner:selected", expect.any(Function), {
      ttlSeconds: 10, lock: false, tags: ["group"],
    });
    await expect(cache.invalidateAllTags(["group"])).resolves.toBe(1);
    await expect(client.get("/tagged", { response: text() })).resolves.toBe("payload");
    expect(fetch).toHaveBeenCalledTimes(4);

    // A tag-aware backend also accepts ordinary policies without tag metadata.
    await expect(client.get("/untagged", { response: text() })).resolves.toBe("payload");
    expect(remember).toHaveBeenLastCalledWith("outbound-http:partner:untagged", expect.any(Function), {});
  });

  it("normalizes explicit fixed methods and honors a custom cache priority", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => new Response((input as Request).method === "HEAD" ? null : "payload"));
    const { cache } = setup(fetch);
    const middleware = cacheResponse({ cache, key: "fixed", methods: [" head "], priority: 250 });
    const client = createOutboundHttpClient({ name: "partner", baseUrl: "https://partner.example", fetch, middleware: [middleware] });

    expect(middleware.priority).toBe(250);
    await expect(client.get("/resource", { response: text() })).resolves.toBe("payload");
    expect(await cache.get("outbound-http:partner:fixed")).toBeUndefined();
    await expect(client.head("/resource")).resolves.toMatchObject({ body: null });
    await expect(client.head("/resource")).resolves.toMatchObject({ body: null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a blank cache key and an unsupported entry version before fetching", async () => {
    const fetch = vi.fn(async () => new Response("unused"));
    const { cache, http } = setup(fetch);
    const blank = createOutboundHttpClient({
      name: "blank", baseUrl: "https://api.example", fetch,
      middleware: [cacheResponse({ cache, key: "  " })],
    });
    await expect(blank.get("/resource")).rejects.toThrow("cache key cannot be empty");

    await cache.set("outbound-http:cached:body", {
      schemaVersion: 2, status: 200, statusText: "OK", headers: {}, bodyBase64: "",
    });
    await expect(http.get("/body")).rejects.toThrow("Unsupported cached outbound HTTP response schema");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([204, 205])("caches successful %s responses without constructing a body", async (status) => {
    const fetch = vi.fn(async () => new Response(null, { status, headers: { "content-type": "text/plain" } }));
    const { http } = setup(fetch);

    // A successful cache miss and its hit both preserve the bodyless status.
    for (let request = 0; request < 2; request += 1) {
      const response = await http.get("/empty");
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(response.body).toBeNull();
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves the lack of a body on cached HEAD responses", async () => {
    const fetch = vi.fn(async () => new Response(null, { headers: { "content-type": "text/plain" } }));
    const { http } = setup(fetch);

    for (let request = 0; request < 2; request += 1) {
      const response = await http.head("/metadata");
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([204, 205])("loads existing bodyless %s entries without the presence marker", async (status) => {
    const fetch = vi.fn(async () => new Response("unexpected"));
    const { cache, http } = setup(fetch);
    await cache.set("outbound-http:cached:body", {
      schemaVersion: 1, status, statusText: "", headers: {}, bodyBase64: "",
    });

    const response = await http.get("/empty");
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores legacy HEAD entries without creating a response stream", async () => {
    const fetch = vi.fn(async () => new Response("unexpected"));
    const { cache, http } = setup(fetch);
    await cache.set("outbound-http:cached:body", {
      schemaVersion: 1, status: 200, statusText: "OK", headers: { etag: '"revision"' }, bodyBase64: "",
    });

    const response = await http.head("/metadata");
    expect(response.body).toBeNull();
    expect(response.headers.get("etag")).toBe('"revision"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized misses before admission and cancels the body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array(5)), cancel });
    const { cache, http } = setup(async () => new Response(body));
    await expect(http.get("/large", { maxResponseBytes: 4, response: text() }))
      .rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
    expect(await cache.get("outbound-http:cached:body")).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("checks a hit against the current call's limit before decoding base64", async () => {
    const fetch = vi.fn(async () => new Response("abcde"));
    const { http } = setup(fetch);
    await expect(http.get("/body", { maxResponseBytes: 5, response: text() })).resolves.toBe("abcde");
    await expect(http.get("/body", { maxResponseBytes: 4, response: text() }))
      .rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("handles a large valid cache entry without recursive base64 validation", async () => {
    const body = "x".repeat(100_000);
    const { http } = setup(async () => new Response(body));
    await expect(http.get("/body", { response: text() })).resolves.toBe(body);
    await expect(http.get("/body", { response: text() })).resolves.toBe(body);
  });

  it.each([200, 500])("bounds stalled %s bodies and does not cache partial content", async (status) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const { cache, http } = setup(async () => new Response(stream, { status }));
    const assertion = expect(http.get("/slow", { timeoutMs: 5, response: text() }))
      .rejects.toBeInstanceOf(OutboundHttpTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(await cache.get("outbound-http:cached:body")).toBeUndefined();
  });

  it("truncates oversized error diagnostics without serializing the full error", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("too large")), cancel });
    const { cache, http } = setup(async () => new Response(stream, { status: 503 }));
    await expect(http.get("/error", { maxResponseBytes: 3, maxErrorBodyBytes: 4 }))
      .rejects.toMatchObject({ name: "OutboundHttpResponseError", body: { truncated: true, text: "too" } });
    expect(await cache.get("outbound-http:cached:body")).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("gives coalesced callers their own one-shot HTTP error bodies", async () => {
    const released = Promise.withResolvers<void>();
    const fetch = vi.fn(async () => { await released.promise; return new Response("failure", { status: 503 }); });
    const { http, cache } = setup(fetch);
    const results = Promise.all([
      expect(http.get("/error", { maxErrorBodyBytes: 3 })).rejects.toMatchObject({ body: { truncated: true, text: "fai" } }),
      expect(http.get("/error", { maxErrorBodyBytes: 5 })).rejects.toMatchObject({ body: { truncated: true, text: "failu" } }),
    ]);
    released.resolve();
    await results;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await cache.get("outbound-http:cached:body")).toBeUndefined();
  });

  it("allows a coalesced caller to cancel without aborting the load owner", async () => {
    const released = Promise.withResolvers<Response>();
    const fetch = vi.fn(() => released.promise);
    const { http } = setup(fetch);
    const abort = new AbortController();
    const first = http.get("/body", { response: text() });
    const second = expect(http.get("/body", { response: text(), signal: abort.signal }))
      .rejects.toBeInstanceOf(OutboundHttpAbortedError);
    abort.abort();
    await second;
    released.resolve(new Response("complete"));
    await expect(first).resolves.toBe("complete");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops waiting for a blocked cache read and refuses a late load", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("late"));
    const { http, adapter } = setup(fetch);
    const read = Promise.withResolvers<undefined>();
    const original = adapter.get.bind(adapter);
    const spy = vi.spyOn(adapter, "get").mockImplementationOnce(() => read.promise);
    try {
      const assertion = expect(http.get("/body", { timeoutMs: 5, response: text() }))
        .rejects.toBeInstanceOf(OutboundHttpTimeoutError);
      await vi.advanceTimersByTimeAsync(5);
      await assertion;
      read.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(await original("test:outbound-http:cached:body")).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("bounds waiting for cache storage without claiming to cancel the backend", async () => {
    vi.useFakeTimers();
    const { http, adapter } = setup(async () => new Response("complete"));
    const write = Promise.withResolvers<void>();
    const spy = vi.spyOn(adapter, "set").mockImplementationOnce(() => write.promise);
    try {
      const assertion = expect(http.get("/body", { timeoutMs: 5, response: text() }))
        .rejects.toBeInstanceOf(OutboundHttpTimeoutError);
      await vi.advanceTimersByTimeAsync(5);
      await assertion;
      expect(spy).toHaveBeenCalledOnce();
      write.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects malformed cached bodies", async () => {
    const { cache, http } = setup(async () => new Response("unused"));
    await cache.set("outbound-http:cached:body", {
      schemaVersion: 1, status: 200, statusText: "OK", headers: {}, bodyBase64: "!!!!",
    });
    await expect(http.get("/body", { response: text() })).rejects.toThrow("Invalid cached");
  });
});
