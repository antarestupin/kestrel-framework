import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  createOutboundHttpClient,
  createOutboundFetch,
  defineOutboundHttpMiddleware,
  json,
  OutboundHttpAbortedError,
  OutboundHttpDecodeError,
  OutboundHttpResponseError,
  OutboundHttpTimeoutError,
  OutboundHttpTransportError,
  runOutboundHttpMiddleware,
  type OutboundHttpFetchOptions,
  type OutboundHttpInstrumentationEvent,
} from "./index.js";

describe("outbound HTTP client", () => {
  it.each([
    "/\\untrusted.example/collect",
    "\\\\untrusted.example/collect",
    "/\t/untrusted.example/collect",
  ])("rejects a structured route that resolves outside the configured origin (%j)", async (route) => {
    const headers = vi.fn(() => ({ authorization: "Bearer partner-token" }));
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createOutboundHttpClient({ name: "partner", baseUrl: "https://partner.example", headers, fetch });

    // The URL parser recognizes these network paths even though they do not start with //.
    await expect(client.get(route)).rejects.toThrow("relative to its client baseUrl");
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires explicit path parameters even when their names match inherited properties", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createOutboundHttpClient({ name: "partner", baseUrl: "https://partner.example", fetch });

    await expect(client.get("/resource/:constructor", { path: {} }))
      .rejects.toThrow('path parameter "constructor" is required');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([".", ".."])("rejects a path parameter that would navigate the URL (%j)", async (id) => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createOutboundHttpClient({ name: "partner", baseUrl: "https://partner.example", fetch });

    // Native URL parsing removes dot segments, including percent-encoded forms.
    await expect(client.get("/accounts/:id/profile", { path: { id } }))
      .rejects.toThrow('path parameter "id" cannot be a dot segment');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds structured requests and validates successful JSON responses", async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;

      expect(request.url).toBe("https://weather.example/forecast/Paris?day=1&day=2&units=metric");
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer token");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(await request.json()).toEqual({ detailed: true });

      return Response.json({ temperature: 19 });
    }) as typeof globalThis.fetch;
    const client = createOutboundHttpClient({
      name: "weather",
      baseUrl: "https://weather.example",
      fetch: fetchImplementation,
      headers: { authorization: "Bearer token" },
    });

    const forecast = await client.post("/forecast/:city", {
      path: { city: "Paris" },
      query: { day: [1, 2], units: "metric" },
      json: { detailed: true },
      response: json(z.object({ temperature: z.number() })),
    });

    expect(forecast).toEqual({ temperature: 19 });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("encodes path data and dated query values while preserving an explicit JSON media type", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      expect(request.url).toBe("https://partner.example/base/a%2Fb?on=2026-02-03T04%3A05%3A06.000Z&on=false");
      expect(request.headers.get("content-type")).toBe("application/vnd.partner+json");
      expect(await request.json()).toEqual({ active: true });
      return new Response(null, { status: 204 });
    });
    const client = createOutboundHttpClient({ name: "partner", baseUrl: new URL("https://partner.example/base/"), fetch });

    await expect(client.put(":id", {
      path: { id: "a/b" },
      query: { on: [new Date("2026-02-03T04:05:06.000Z"), null, false], omitted: undefined },
      headers: { "content-type": "application/vnd.partner+json" },
      json: { active: true },
    })).resolves.toMatchObject({ status: 204 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends the convenience methods without requiring option objects", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => new Response(null, {
      status: 204, headers: { "x-method": (input as Request).method },
    }));
    const client = createOutboundHttpClient({ name: "partner", baseUrl: "https://partner.example", fetch });

    for (const method of ["head", "post", "put", "patch", "delete"] as const) {
      const response = await client[method]("/resource");
      expect(response.headers.get("x-method")).toBe(method.toUpperCase());
    }
  });

  it("preserves low-level Request semantics and applies header overrides without changing its destination", async () => {
    const events: OutboundHttpInstrumentationEvent[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      expect(request.url).toBe("https://external.example/request");
      expect(request.method).toBe("POST");
      expect(await request.text()).toBe("original body");
      expect(Object.fromEntries(request.headers)).toMatchObject({
        "x-from-client": "client", "x-overlap": "input", "x-from-input": "input", "x-precedence": "call",
      });
      return new Response("forbidden", { status: 403 });
    });
    const client = createOutboundHttpClient({
      name: "partner", baseUrl: "https://partner.example", fetch,
      headers: () => ({ "x-from-client": "client", "x-overlap": "client", "x-precedence": "client" }),
      instrumentation: { record: (event) => events.push(event) },
    });
    const input = new Request("https://external.example/request", {
      method: "POST", body: "original body",
      headers: { "x-from-input": "input", "x-overlap": "input", "x-precedence": "input" },
    });

    const response = await client.fetch(input, { headers: { "x-precedence": "call" } });
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("forbidden");
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "failure", data: expect.objectContaining({ method: "POST", status: 403 }) }),
      expect.objectContaining({ type: "request", outcome: "failure", data: expect.objectContaining({ method: "POST", status: 403 }) }),
    ]);
  });

  it("observes an input Request's cancellation and preserves its reason", async () => {
    const abort = new AbortController();
    const reason = new Error("owner cancelled");
    const request = new Request("https://partner.example/resource", { signal: abort.signal });
    const fetch = vi.fn();
    const client = createOutboundHttpClient({ name: "partner", fetch });
    abort.abort(reason);

    await expect(client.fetch(request)).rejects.toMatchObject({ name: "OutboundHttpAbortedError", cause: reason });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the native fetch default when the client omits an implementation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const request = createOutboundFetch({ name: "partner" });
      await expect(request(new URL("https://partner.example/resource"))).resolves.toMatchObject({ status: 204 });
      expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: "https://partner.example/resource" }));
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([
    [" ", "path template cannot be empty"],
    ["/resource?secret=value", "must not be embedded"],
    ["/resource#fragment", "must not be embedded"],
    ["https://other.example/resource", "relative to its client baseUrl"],
    ["//other.example/resource", "relative to its client baseUrl"],
    ["https://partner.example/resource", "relative to its client baseUrl"],
    ["//partner.example/resource", "relative to its client baseUrl"],
    ["/resource/:id", 'path parameter "id" is required'],
  ])("rejects an invalid structured route (%j) before transport", async (route, message) => {
    const fetch = vi.fn();
    const client = createOutboundHttpClient({ name: "partner", baseUrl: "https://partner.example", fetch });

    await expect(client.get(route)).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unused parameters, ambiguous bodies, and relative URLs without a base", async () => {
    const fetch = vi.fn();
    const client = createOutboundHttpClient({ name: "partner", baseUrl: "https://partner.example", fetch });
    const raw = createOutboundFetch({ name: "partner", fetch });

    await expect(client.get("/resource", { path: { unused: 1 } })).rejects.toThrow('parameter "unused" does not exist');
    await expect(client.post("/resource", { body: "text", json: {} })).rejects.toThrow("cannot define both body and json");
    await expect(raw("/resource")).rejects.toThrow("requires a configured baseUrl");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each<{ options: OutboundHttpFetchOptions; message: string }>([
    { options: { operation: " " }, message: "operation cannot be empty" },
    { options: { method: " " }, message: "method cannot be empty" },
    { options: { route: " " }, message: "route cannot be empty" },
    { options: { timeoutMs: 0 }, message: "timeout must be positive and finite" },
    { options: { timeoutMs: Infinity }, message: "timeout must be positive and finite" },
  ])("rejects invalid invocation options $options before transport", async ({ options, message }) => {
    const fetch = vi.fn();
    const client = createOutboundHttpClient({ name: "partner", baseUrl: "https://partner.example", fetch });

    await expect(client.fetch("/resource", options)).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a client name and an HTTP(S) base URL", () => {
    expect(() => createOutboundHttpClient({ name: " " })).toThrow("client name cannot be empty");
    expect(() => createOutboundHttpClient({ name: "partner", baseUrl: "file:///resource" }))
      .toThrow("baseUrl must use HTTP or HTTPS");
  });

  it.each([
    new OutboundHttpTimeoutError("transport", 10),
    new OutboundHttpAbortedError("transport"),
    new OutboundHttpTransportError("transport"),
  ])("preserves an existing typed transport rejection ($name)", async (error) => {
    const client = createOutboundHttpClient({
      name: "partner", baseUrl: "https://partner.example", fetch: async () => { throw error; },
    });

    await expect(client.get("/resource")).rejects.toBe(error);
  });

  it("orders client and request middleware by stable numeric priority", async () => {
    const calls: string[] = [];
    const createMiddleware = (
      name: string,
      priority: number,
    ) => defineOutboundHttpMiddleware(name, {
      priority,
      handler: async (_context, next) => {
        calls.push(`${name}:before`);
        const response = await next();
        calls.push(`${name}:after`);

        return response;
      },
    });
    const client = createOutboundHttpClient({
      name: "ordered",
      baseUrl: "https://api.example",
      middleware: [
        createMiddleware("client-default", 500),
        createMiddleware("client-inner", 800),
      ],
      fetch: vi.fn(async () => {
        calls.push("fetch");

        return new Response(null, { status: 204 });
      }) as typeof globalThis.fetch,
    });

    await client.get("/resource", {
      middleware: [
        createMiddleware("request-outer", 100),
        createMiddleware("request-default", 500),
      ],
    });

    expect(calls).toEqual([
      "request-outer:before",
      "client-default:before",
      "request-default:before",
      "client-inner:before",
      "fetch",
      "client-inner:after",
      "request-default:after",
      "client-default:after",
      "request-outer:after",
    ]);
  });

  it("uses stable route templates for default observation identities", async () => {
    const events: OutboundHttpInstrumentationEvent[] = [];
    const client = createOutboundHttpClient({
      name: "weather",
      baseUrl: "https://weather.example",
      fetch: vi.fn(async () => Response.json({ temperature: 20 })) as (
        typeof globalThis.fetch
      ),
      instrumentation: { record: (event) => events.push(event) },
    });

    await client.get("/forecast/:city", {
      path: { city: "sensitive-city" },
      response: json(z.object({ temperature: z.number() })),
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({
        operation: "weather.GET./forecast/:city",
        route: "/forecast/:city",
        attempt: 1,
      }),
      expect.objectContaining({
        operation: "weather.GET./forecast/:city",
        route: "/forecast/:city",
        attempts: 1,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("sensitive-city");
  });

  it("does not infer concrete paths into low-level fetch observations", async () => {
    const events: OutboundHttpInstrumentationEvent[] = [];
    const outboundFetch = createOutboundFetch({
      name: "partner",
      fetch: vi.fn(async () => new Response(null, { status: 204 })) as (
        typeof globalThis.fetch
      ),
      instrumentation: { record: (event) => events.push(event) },
    });

    await outboundFetch("https://partner.example/users/sensitive-user-id");

    expect(events.at(-1)?.data).toMatchObject({
      operation: "partner.GET.request",
      route: "request",
    });
    expect(JSON.stringify(events)).not.toContain("sensitive-user-id");
  });

  it("exposes typed response and decoding failures", async () => {
    const responses = [
      Response.json({ error: "missing" }, { status: 404 }),
      Response.json({ temperature: "invalid" }),
    ];
    const client = createOutboundHttpClient({
      name: "weather",
      baseUrl: "https://weather.example",
      fetch: vi.fn(async () => responses.shift()!) as typeof globalThis.fetch,
    });

    await expect(client.get("/missing")).rejects.toMatchObject({
      name: "OutboundHttpResponseError",
      status: 404,
      body: { error: "missing" },
    } satisfies Partial<OutboundHttpResponseError>);
    await expect(client.get("/forecast", {
      response: json(z.object({ temperature: z.number() })),
    })).rejects.toBeInstanceOf(OutboundHttpDecodeError);
  });

  it("bounds the complete logical request with one deadline", async () => {
    const client = createOutboundHttpClient({
      name: "slow",
      baseUrl: "https://slow.example",
      fetch: vi.fn(async () => new Promise<Response>(() => {})) as (
        typeof globalThis.fetch
      ),
    });

    await expect(client.get("/resource", { timeoutMs: 5 }))
      .rejects.toBeInstanceOf(OutboundHttpTimeoutError);
  });
});

describe("outbound middleware helpers", () => {
  it("validates names and priorities at definition time", () => {
    const handler = async () => new Response(null, { status: 204 });
    expect(() => defineOutboundHttpMiddleware(" ", { handler })).toThrow("name cannot be empty");
    expect(() => defineOutboundHttpMiddleware("invalid", { handler, priority: Infinity })).toThrow("priority must be finite");
  });

  it("supports the standalone middleware runner and forwards replacement metadata", async () => {
    const initial = new Request("https://partner.example/first");
    const replacement = new Request("https://partner.example/second");
    const middleware = defineOutboundHttpMiddleware("replace", {
      handler: (_context, next) => next({ request: replacement, attempt: 2 }),
    });
    const response = new Response(null, { status: 204 });
    const terminal = vi.fn(async () => response);

    // Public callers of the runner can omit both the guard and deadline callbacks.
    await expect(runOutboundHttpMiddleware([middleware], {
      client: "partner", operation: "operation", route: "request", request: initial, attempt: 1, maxResponseBytes: 32,
    }, terminal)).resolves.toBe(response);
    expect(terminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      request: expect.objectContaining({ url: replacement.url }), attempt: 2, maxResponseBytes: 32,
    }));
  });

  it.each(["owner", "replacement"] as const)(
    "propagates %s cancellation to a replacement request in the standalone runner",
    async (source) => {
      const owner = new AbortController();
      const replacement = new AbortController();
      const initial = new Request("https://partner.example/first", { signal: owner.signal });
      const replacementRequest = new Request("https://partner.example/second", { signal: replacement.signal });
      const middleware = defineOutboundHttpMiddleware("replace", {
        handler: (_context, next) => next({ request: replacementRequest }),
      });
      const reason = new Error("cancel downstream work");
      const terminal = vi.fn(async ({ request }: { request: Request }) => {
        // Abort after dispatch so each signal must independently cancel active work.
        expect(request.signal.aborted).toBe(false);
        (source === "owner" ? owner : replacement).abort(reason);
        request.signal.throwIfAborted();
        return new Response(null, { status: 204 });
      });

      await expect(runOutboundHttpMiddleware([middleware], {
        client: "partner", operation: "operation", route: "request", request: initial, attempt: 1, maxResponseBytes: 32,
      }, terminal)).rejects.toBe(reason);
      expect(terminal).toHaveBeenCalledOnce();
    },
  );
});
