import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  createOutboundHttpClient,
  createOutboundFetch,
  defineOutboundHttpMiddleware,
  json,
  OutboundHttpDecodeError,
  OutboundHttpResponseError,
  OutboundHttpTimeoutError,
  type OutboundHttpInstrumentationEvent,
} from "./index.js";

describe("outbound HTTP client", () => {
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
