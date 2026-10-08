import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createOutboundHttpClient, defineOutboundHttpMiddleware, json, nativeResponse,
  OutboundHttpAbortedError, OutboundHttpDecodeError, OutboundHttpResponseTooLargeError,
  OutboundHttpTimeoutError, retryRequests, text, bytes,
  type OutboundHttpClientOptions, type OutboundHttpInstrumentationEvent,
} from "./index.js";

// Each fixture owns its stream and exposes disposal without creating a server.
function source(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel,
  }, { highWaterMark: 0 });
  return {
    response: new Response(stream, { status }), cancel, stream,
    send(value: string) { controller.enqueue(new TextEncoder().encode(value)); },
    end() { controller.close(); },
  };
}
function client(response: Response, options: Partial<OutboundHttpClientOptions> = {}) {
  return createOutboundHttpClient({
    name: "budgets", baseUrl: "https://api.example", fetch: async () => response, ...options,
  });
}

afterEach(() => vi.useRealTimers());

describe("outbound HTTP budgets", () => {
  it.each([200, 500])("keeps the deadline alive for a stalled %s body", async (status) => {
    vi.useFakeTimers();
    const body = source(status);
    const events: OutboundHttpInstrumentationEvent[] = [];
    const result = client(body.response, {
      timeoutMs: 5, instrumentation: { record: (event) => events.push(event) },
    }).get("/slow", { response: text() });
    const assertion = expect(result).rejects.toBeInstanceOf(OutboundHttpTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.stream.locked).toBe(false);
    expect(events.filter((event) => event.type === "request")).toEqual([
      expect.objectContaining({ outcome: "failure", data: expect.objectContaining({ result: "timeout" }) }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 500])("does not reset the deadline for trickling %s bodies", async (status) => {
    vi.useFakeTimers();
    const body = source(status);
    const assertion = expect(client(body.response).get("/trickle", {
      timeoutMs: 10, response: text(),
    })).rejects.toBeInstanceOf(OutboundHttpTimeoutError);
    await vi.advanceTimersByTimeAsync(4);
    body.send("a");
    await vi.advanceTimersByTimeAsync(4);
    body.send("b");
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it("bounds asynchronous schema validation after the body has completed", async () => {
    vi.useFakeTimers();
    const validation = Promise.withResolvers<boolean>();
    const assertion = expect(client(Response.json({ value: 1 })).get("/validation", {
      timeoutMs: 5,
      response: json(z.object({ value: z.number() }).refine(() => validation.promise)),
    })).rejects.toBeInstanceOf(OutboundHttpTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    validation.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards cancellation to custom decoders without requiring a timeout", async () => {
    const abort = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const body = source();
    const assertion = expect(client(body.response).get("/decode", {
      signal: abort.signal,
      response: {
        description: "cooperative",
        decode: async (_response, { signal }) => {
          started.resolve(signal);
          return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      },
    })).rejects.toBeInstanceOf(OutboundHttpAbortedError);
    const decoderSignal = await started.promise;
    abort.abort("execution ended");
    await assertion;
    expect(decoderSignal.aborted).toBe(true);
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.stream.locked).toBe(false);
  });

  it("rejects aborted preparation without contacting the transport", async () => {
    const abort = new AbortController();
    abort.abort();
    const fetch = vi.fn();
    await expect(client(new Response(null), { fetch }).get("/resource", { signal: abort.signal }))
      .rejects.toBeInstanceOf(OutboundHttpAbortedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a late response from a transport that ignores abort", async () => {
    vi.useFakeTimers();
    const late = Promise.withResolvers<Response>();
    const body = source();
    const assertion = expect(client(body.response, { fetch: () => late.promise })
      .get("/late", { timeoutMs: 5, response: text() })).rejects.toBeInstanceOf(OutboundHttpTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    late.resolve(body.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.stream.locked).toBe(false);
  });

  it.each([text(), bytes(), json(z.unknown())])("bounds standard $description decoding before buffering", async (response) => {
    const body = source();
    body.send("12345");
    const http = client(body.response, { maxResponseBytes: 4 });
    await expect(http.get("/large", { response })).rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.stream.locked).toBe(false);
  });

  it("counts bytes across chunks and ignores misleading content-length", async () => {
    const body = source();
    body.response.headers.set("content-length", "1");
    body.send("é");
    body.send("é");
    await expect(client(body.response).get("/large", {
      maxResponseBytes: 3, response: text(),
    })).rejects.toMatchObject({ name: "OutboundHttpResponseTooLargeError", maxResponseBytes: 3 });
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it("accepts the exact limit and allows per-call overrides", async () => {
    const body = source();
    body.send("ab");
    body.send("cd");
    body.end();
    await expect(client(body.response, { maxResponseBytes: 1 }).get("/exact", {
      maxResponseBytes: 4, response: text(),
    })).resolves.toBe("abcd");
    expect(body.stream.locked).toBe(false);
  });

  it("bounds custom decoders and middleware-produced responses", async () => {
    const body = source();
    body.send("12345");
    const http = client(new Response(null), {
      maxResponseBytes: 4,
      middleware: [defineOutboundHttpMiddleware("synthetic", { handler: async () => body.response })],
    });
    await expect(http.get("/custom", {
      response: { description: "custom", decode: (response) => response.arrayBuffer() },
    })).rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it.each([2, 10])("truncates error diagnostics at the smaller budget (%s bytes)", async (maxResponseBytes) => {
    const body = source(503);
    body.send("abcdefgh");
    await expect(client(body.response).get("/error", {
      maxResponseBytes, maxErrorBodyBytes: 4,
    })).rejects.toMatchObject({
      name: "OutboundHttpResponseError", status: 503,
      body: { truncated: true, text: "abcdefgh".slice(0, Math.min(4, maxResponseBytes)) },
    });
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.stream.locked).toBe(false);
  });

  it("preserves malformed error text and classifies malformed successful JSON", async () => {
    await expect(client(new Response("{", { status: 400, headers: { "content-type": "application/json" } }))
      .get("/error")).rejects.toMatchObject({ name: "OutboundHttpResponseError", body: "{" });
    await expect(client(new Response("{")).get("/invalid", { response: json(z.unknown()) }))
      .rejects.toBeInstanceOf(OutboundHttpDecodeError);
  });

  it("releases unread bodies when decoders fail or finish without consuming them", async () => {
    for (const failure of [false, true]) {
      const body = source();
      const result = client(body.response).get("/early", { response: {
        description: "early",
        decode: async () => { if (failure) throw new Error("invalid"); return 42; },
      } });
      if (failure) await expect(result).rejects.toBeInstanceOf(OutboundHttpDecodeError);
      else await expect(result).resolves.toBe(42);
      expect(body.cancel).toHaveBeenCalledOnce();
      expect(body.stream.locked).toBe(false);
    }
  });

  it("does not wait for a non-cooperative source cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array(10)), cancel });
    await expect(client(new Response(stream)).get("/large", { maxResponseBytes: 1, response: text() }))
      .rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it.each(["fetch", "implicit", "explicit"])("transfers %s streaming lifetime while preserving byte and cancellation limits", async (mode) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const body = source();
    const http = client(body.response, { timeoutMs: 5, maxResponseBytes: 4 });
    const response = mode === "fetch"
      ? await http.fetch("/stream", { signal: abort.signal })
      : await http.get("/stream", { signal: abort.signal, ...(mode === "explicit" ? { response: nativeResponse() } : {}) });
    await vi.advanceTimersByTimeAsync(10);
    expect(body.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const reading = expect(response.text()).rejects.toBeInstanceOf(OutboundHttpAbortedError);
    abort.abort();
    await reading;
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it("enforces stream byte limits after returning the native response", async () => {
    const body = source();
    const response = await client(body.response).get("/stream", { maxResponseBytes: 2 });
    body.send("abc");
    await expect(response.text()).rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it("shares the deadline between retries, backoff and final decoding", async () => {
    vi.useFakeTimers();
    const first = source(503);
    const second = source();
    const fetch = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const http = client(first.response, { fetch, middleware: [retryRequests({ initialDelayMs: 4, jitterRatio: 0 })] });
    const assertion = expect(http.get("/retry", { timeoutMs: 5, response: text() }))
      .rejects.toBeInstanceOf(OutboundHttpTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start another attempt after expiration even if injected backoff ignores abort", async () => {
    vi.useFakeTimers();
    const backoff = Promise.withResolvers<void>();
    const fetch = vi.fn(async () => new Response("busy", { status: 503 }));
    const http = client(new Response(null), { fetch, middleware: [retryRequests({ sleep: () => backoff.promise })] });
    const assertion = expect(http.get("/retry", { timeoutMs: 5, response: text() }))
      .rejects.toBeInstanceOf(OutboundHttpTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    backoff.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("propagates the execution signal through middleware request replacement", async () => {
    const abort = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const body = source();
    const http = client(body.response, {
      middleware: [defineOutboundHttpMiddleware("replace", {
        handler: (_context, next) => next({ request: new Request("https://replacement.example") }),
      })],
      fetch: async (input) => { started.resolve((input as Request).signal); return body.response; },
    });
    const assertion = expect(http.get("/body", { signal: abort.signal, response: text() }))
      .rejects.toBeInstanceOf(OutboundHttpAbortedError);
    const signal = await started.promise;
    abort.abort();
    await assertion;
    expect(signal.aborted).toBe(true);
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it("covers asynchronous headers and permits a per-call deadline override", async () => {
    vi.useFakeTimers();
    const headers = Promise.withResolvers<HeadersInit>();
    const fetch = vi.fn(async () => new Response("ok"));
    const http = client(new Response(null), { fetch, timeoutMs: 5, headers: () => headers.promise });
    const result = http.get("/headers", { timeoutMs: 10, response: text() });
    await vi.advanceTimersByTimeAsync(6);
    expect(fetch).not.toHaveBeenCalled();
    headers.resolve({});
    await expect(result).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a delayed header factory and prevents its late transport call", async () => {
    vi.useFakeTimers();
    const headers = Promise.withResolvers<HeadersInit>();
    const fetch = vi.fn();
    const assertion = expect(client(new Response(null), { fetch, headers: () => headers.promise })
      .get("/headers", { timeoutMs: 5 })).rejects.toBeInstanceOf(OutboundHttpTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    headers.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves transport metadata and streaming middleware composition", async () => {
    const body = source();
    Object.defineProperty(body.response, "url", { value: "https://api.example/final" });
    Object.defineProperty(body.response, "redirected", { value: true });
    const direct = await client(body.response).fetch("/stream");
    expect(direct.url).toBe("https://api.example/final");
    expect(direct.redirected).toBe(true);
    await direct.body!.cancel();
    expect(body.stream.locked).toBe(false);

    const transformed = source();
    const http = client(transformed.response, { middleware: [defineOutboundHttpMiddleware("transform", {
      handler: async (_context, next) => {
        const response = await next();
        return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()));
      },
    })] });
    const response = await http.get("/stream");
    transformed.send("value");
    transformed.end();
    await expect(response.text()).resolves.toBe("value");
    expect(transformed.stream.locked).toBe(false);
  });

  it("does not let a custom decoder swallow a byte-budget violation", async () => {
    const body = source();
    body.send("oversized");
    await expect(client(body.response).get("/body", { maxResponseBytes: 1, response: {
      description: "fallback",
      decode: async (response) => { try { return await response.text(); } catch { return "ignored"; } },
    } })).rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
  });

  it("does not retry successful responses that exceed bytes or fail decoding", async () => {
    for (const oversized of [true, false]) {
      const fetch = vi.fn(async () => new Response(oversized ? "oversized" : "{"));
      const http = client(new Response(null), { fetch, middleware: [retryRequests()] });
      await expect(http.get("/body", { maxResponseBytes: 2, response: json(z.unknown()) }))
        .rejects.toBeInstanceOf(oversized ? OutboundHttpResponseTooLargeError : OutboundHttpDecodeError);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it.each([0, -1, Infinity, NaN, 1.5])("rejects invalid response budgets (%s) before fetching", async (limit) => {
    const fetch = vi.fn();
    const http = client(new Response(null), { fetch });
    expect(() => client(new Response(null), { maxResponseBytes: limit })).toThrow(TypeError);
    await expect(http.get("/invalid", { maxErrorBodyBytes: limit })).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
