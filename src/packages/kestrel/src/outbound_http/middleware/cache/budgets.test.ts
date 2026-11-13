import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CachePool, TagAwareCachePool } from "../../../cache/cache_pool.js";
import { MemoryCacheAdapter } from "../../../cache/adapters/memory/index.js";
import type { CacheInstrumentation } from "../../../cache/observations.js";
import {
  cacheResponse, cacheResponses, createOutboundHttpClient, defineOutboundHttpMiddleware, text,
  OutboundHttpAbortedError, OutboundHttpResponseTooLargeError, OutboundHttpTimeoutError,
} from "../../index.js";

function setup(fetch: typeof globalThis.fetch, instrumentation?: CacheInstrumentation) {
  const adapter = new MemoryCacheAdapter({ maxEntries: 10, maxSizeBytes: 1_000_000, maxEntrySizeBytes: 1_000_000 });
  const cache = new CachePool(adapter, {
    namespace: "test", defaultTtlSeconds: 60, maxTtlSeconds: 60, maxEntrySizeBytes: 1_000_000,
    ...(instrumentation === undefined ? {} : { instrumentation }),
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
    expect(remember.mock.lastCall?.[2]).toStrictEqual({});
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

  it("preserves absent 200 bodies and stores only present, normalized header names", async () => {
    const fetch = vi.fn(async () => new Response(null, { headers: { etag: '"revision"', "x-private": "ignored" } }));
    const { cache } = setup(fetch);
    const http = createOutboundHttpClient({
      name: "cached", baseUrl: "https://api.example", fetch,
      middleware: [cacheResponse({ cache, key: "body", headers: ["ETag", "X-Missing"] })],
    });

    for (let request = 0; request < 2; request += 1) {
      const response = await http.get("/empty");
      expect(response.body).toBeNull();
      expect([...response.headers]).toEqual([["etag", '"revision"']]);
    }
    expect(await cache.get("outbound-http:cached:body")).toStrictEqual({
      schemaVersion: 1, status: 200, statusText: "", headers: { etag: '"revision"' },
      bodyBase64: "", bodyAbsent: true,
    });
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

  it("applies the current call's budget to a cache hit", async () => {
    const fetch = vi.fn(async () => new Response("abcde"));
    const { http } = setup(fetch);
    await expect(http.get("/body", { maxResponseBytes: 5, response: text() })).resolves.toBe("abcde");
    await expect(http.get("/body", { maxResponseBytes: 4, response: text() }))
      .rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["YQ==", "a"],
    ["YWI=", "ab"],
    ["YWJj", "abc"],
  ])("uses the decoded byte length for cached base64 %s", async (bodyBase64, expected) => {
    const { cache } = setup(vi.fn());
    const middleware = cacheResponse({ cache, key: "body" });
    const context = {
      client: "cached", operation: "read", route: "/body", attempt: 1,
      request: new Request("https://api.example/body"),
    };
    await cache.set("outbound-http:cached:body", {
      schemaVersion: 1, status: 200, statusText: "OK", headers: {}, bodyBase64,
    });
    const next = vi.fn();

    // Call the middleware directly so the client's downstream budget cannot mask a late check.
    const response = await middleware.handler({ ...context, maxResponseBytes: expected.length }, next);
    await expect(response.text()).resolves.toBe(expected);

    const decode = vi.spyOn(Buffer, "from");
    try {
      await expect(middleware.handler({ ...context, maxResponseBytes: expected.length - 1 }, next))
        .rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
      expect(decode).not.toHaveBeenCalledWith(bodyBase64, "base64");
    } finally {
      decode.mockRestore();
    }
    expect(next).not.toHaveBeenCalled();
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
    const rejected = vi.fn();
    void http.get("/slow", { timeoutMs: 5, response: text() }).catch(rejected);
    await vi.advanceTimersByTimeAsync(5);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.any(OutboundHttpTimeoutError));
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

  it("does not retry an aborted waiter when its shared load returns a one-shot error", async () => {
    const released = Promise.withResolvers<Response>();
    const coalesced = vi.fn();
    const { cache } = setup(vi.fn(), { record(event) {
      if (event.type === "access" && event.data.result === "local-coalesced") coalesced();
    } });
    const middleware = cacheResponse({ cache, key: "body" });
    const ownerNext = vi.fn(() => released.promise);
    const waiterNext = vi.fn(async () => new Response(null));
    const abort = new AbortController();
    const reason = new Error("waiter stopped");
    const metadata = { client: "cached", operation: "read", route: "/body", attempt: 1, maxResponseBytes: 8 };
    const first = middleware.handler({ ...metadata, request: new Request("https://api.example/body") }, ownerNext);
    const second = middleware.handler({
      ...metadata, request: new Request("https://api.example/body", { signal: abort.signal }),
    }, waiterNext);
    const waiter = expect(second).rejects.toBe(reason);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ownerNext).toHaveBeenCalledOnce();
      expect(coalesced).toHaveBeenCalledOnce();
      abort.abort(reason);
      released.resolve(new Response(null, { status: 503 }));
      await expect(first).resolves.toMatchObject({ status: 503 });
      await waiter;
      expect(waiterNext).not.toHaveBeenCalled();
    } finally {
      abort.abort(reason);
      released.resolve(new Response(null, { status: 503 }));
      await Promise.allSettled([first, waiter]);
    }
  });

  it.each(["cancellation", "replacement cancellation", "response limit"] as const)(
    "isolates the load owner's %s from an active cache waiter",
    async (failure) => {
      const released = Promise.withResolvers<Response>();
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockImplementation(async () => new Response("peer body"));
      const coalesced = vi.fn();
      const { http, cache } = setup(fetch, { record(event) {
        if (event.type === "access" && event.data.result === "local-coalesced") coalesced();
      } });
      const owner = new AbortController();
      const ownerBoundary = failure === "replacement cancellation"
        ? { middleware: [defineOutboundHttpMiddleware("owner-only-signal", {
            handler: ({ request }, next) => next({
              request: new Request(request, { signal: owner.signal }),
            }),
          })] }
        : { signal: owner.signal };
      if (failure === "replacement cancellation") {
        // A fetch implementation observes the attempt signal independently of the cache's owner signal.
        fetch.mockImplementationOnce((input) => {
          const request = input as Request;
          return Promise.race([released.promise, new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          })]);
        });
      } else fetch.mockImplementationOnce(() => released.promise);
      const first = http.get("/body", { response: text(), maxResponseBytes: 3, ...ownerBoundary });
      const firstRejection = vi.fn();
      void first.catch(firstRejection);
      let peer: Promise<string> | undefined;
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fetch).toHaveBeenCalledOnce();
        peer = http.get("/body", { response: text() });
        void peer.catch(() => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
        // This assertion proves that the second request was sharing the first loader.
        expect(coalesced).toHaveBeenCalledOnce();
        if (failure === "response limit") released.resolve(new Response("oversized owner body"));
        else owner.abort();
        // The injected fetch and cache settle within this turn when the correct signal is forwarded.
        await nextTurn();
        expect(firstRejection).toHaveBeenCalledExactlyOnceWith(expect.any(failure === "response limit"
          ? OutboundHttpResponseTooLargeError : OutboundHttpAbortedError));
        await expect(Promise.race([peer, nextTurn().then(() => { throw new Error("The cache waiter did not settle."); })]))
          .resolves.toBe("peer body");
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(await cache.get("outbound-http:cached:body")).toBeUndefined();
      } finally {
        owner.abort();
        released.resolve(new Response(null, { status: 204 }));
        await nextTurn();
      }
    },
  );

  it("keeps one-shot cache failures separate when middleware replays the same request", async () => {
    const release = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => {
        await release.promise;
        return new Response("first", { status: 503 });
      })
      .mockImplementation(async () => new Response("second", { status: 503 }));
    const coalesced = vi.fn();
    const { http } = setup(fetch, { record(event) {
      if (event.type === "access" && event.data.result === "local-coalesced") coalesced();
    } });
    const replay = defineOutboundHttpMiddleware("replay-before-cache", {
      priority: 50,
      handler: async (_context, next) => {
        // Both continuations keep the same native Request, but each owns its response.
        const [first, second] = await Promise.all([next(), next()]);
        const responses = await Promise.all([first.text(), second.text()]);
        return new Response(responses.join(", "));
      },
    });
    const pending = http.fetch("/body", { middleware: [replay] });
    void pending.catch(() => {});
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(coalesced).toHaveBeenCalledOnce();
      release.resolve();
      const response = await pending;
      await expect(response.text()).resolves.toBe("first, second");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it("stops waiting for a blocked cache read and refuses a late load", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("late"));
    const { http, adapter } = setup(fetch);
    const read = Promise.withResolvers<undefined>();
    const original = adapter.get.bind(adapter);
    const spy = vi.spyOn(adapter, "get").mockImplementationOnce(() => read.promise);
    try {
      const rejected = vi.fn();
      void http.get("/body", { timeoutMs: 5, response: text() }).catch(rejected);
      await vi.advanceTimersByTimeAsync(5);
      expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.any(OutboundHttpTimeoutError));
      read.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(await original("test:outbound-http:cached:body")).toBeUndefined();
    } finally {
      read.resolve(undefined);
      spy.mockRestore();
    }
  });

  it("bounds waiting for cache storage without claiming to cancel the backend", async () => {
    vi.useFakeTimers();
    const { http, adapter } = setup(async () => new Response("complete"));
    const write = Promise.withResolvers<void>();
    const spy = vi.spyOn(adapter, "set").mockImplementationOnce(() => write.promise);
    try {
      const rejected = vi.fn();
      void http.get("/body", { timeoutMs: 5, response: text() }).catch(rejected);
      await vi.advanceTimersByTimeAsync(5);
      expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.any(OutboundHttpTimeoutError));
      expect(spy).toHaveBeenCalledOnce();
      write.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      write.resolve();
      spy.mockRestore();
    }
  });

  it.each(["!!!!", "YQ"])("rejects malformed cached base64 %s", async (bodyBase64) => {
    const { cache, http } = setup(async () => new Response("unused"));
    await cache.set("outbound-http:cached:body", {
      schemaVersion: 1, status: 200, statusText: "OK", headers: {}, bodyBase64,
    });
    await expect(http.get("/body", { response: text() })).rejects.toThrow("Invalid cached");
  });

  it.each(["before-load", "before-store", "before-restore"] as const)(
    "stops the cache path if a request aborts %s",
    async (phase) => {
      const { cache, adapter } = setup(vi.fn());
      const abort = new AbortController();
      const failure = new Error("cache request cancelled");
      const context = {
        client: "cached", operation: "read", route: "/body", attempt: 1, maxResponseBytes: 8,
        request: new Request("https://api.example/body", { signal: abort.signal }),
      };
      const write = vi.spyOn(adapter, "set");
      const next = vi.fn(async () => {
        if (phase === "before-store") abort.abort(failure);
        return new Response("complete");
      });
      if (phase === "before-restore") {
        await cache.set("outbound-http:cached:body", {
          schemaVersion: 1, status: 200, statusText: "", headers: {}, bodyBase64: "YQ==",
        });
        write.mockClear();
        const get = adapter.get.bind(adapter);
        vi.spyOn(adapter, "get").mockImplementationOnce(async (key) => {
          const result = await get(key);
          abort.abort(failure);
          return result;
        });
      }
      if (phase === "before-load") abort.abort(failure);

      // Exercise the middleware independently of the client's deadline guard.
      await expect(cacheResponse({ cache, key: "body" }).handler(context, next)).rejects.toBe(failure);
      expect(next).toHaveBeenCalledTimes(phase === "before-store" ? 1 : 0);
      expect(write).not.toHaveBeenCalled();
    },
  );
});
