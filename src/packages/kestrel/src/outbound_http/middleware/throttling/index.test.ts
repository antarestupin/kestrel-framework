import { describe, expect, it, vi } from "vitest";

import {
  defineRateLimit,
  MemoryRateLimitAdapter,
  seconds,
  ThrottlingManager,
  type Awaitable,
  type Throttling,
  type ThrottlingDefinition,
  type ThrottlingRunContext,
  type ThrottlingRunOptions,
} from "../../../throttling/index.js";
import {
  createOutboundHttpClient,
  defineOutboundHttpMiddleware,
  OutboundHttpAbortedError,
  OutboundHttpTimeoutError,
  OutboundHttpTransportError,
} from "../../index.js";
import { throttleRequests, type ThrottleOutboundHttpOptions } from "./index.js";

const definition = defineRateLimit({ id: "partner", requests: 10, per: seconds(1) });

function createProbe() {
  const reportFeedback = vi.fn<ThrottlingRunContext["reportFeedback"]>();
  const run = vi.fn();
  const throttling: Throttling = {
    acquire: vi.fn(), close: vi.fn(), inspect: vi.fn(),
    async run<Value>(
      policy: ThrottlingDefinition,
      optionsOrHandler: ThrottlingRunOptions | ((context: ThrottlingRunContext) => Awaitable<Value>),
      handler?: (context: ThrottlingRunContext) => Awaitable<Value>,
    ): Promise<Value> {
      const operation = typeof optionsOrHandler === "function" ? optionsOrHandler : handler;
      if (operation === undefined) throw new Error("An operation is required.");
      run(policy, typeof optionsOrHandler === "function" ? {} : optionsOrHandler, operation);
      return operation({ reportFeedback, reportActualCost: vi.fn() });
    },
  };
  return { throttling, run, reportFeedback };
}

describe("outbound HTTP throttling", () => {
  it("resolves dynamic admission settings and keeps the attempt's cancellation signal", async () => {
    const { throttling, run, reportFeedback } = createProbe();
    const selectDefinition = vi.fn<Exclude<ThrottleOutboundHttpOptions["definition"], ThrottlingDefinition>>(() => definition);
    const selectOptions = vi.fn(() => ({ rateKey: "tenant", estimatedCost: { requests: 2 }, maxWaitMs: 20 }));
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createOutboundHttpClient({
      name: "partner", baseUrl: "https://partner.example", fetch,
      middleware: [throttleRequests({ throttling, definition: selectDefinition, acquire: selectOptions, priority: 700 })],
    });

    const response = await client.get("/resource/:id", { path: { id: 15 } });
    expect(response.status).toBe(204);
    const context = selectDefinition.mock.calls[0]![0];
    expect(context).toMatchObject({ client: "partner", route: "/resource/:id", attempt: 1 });
    expect(selectOptions).toHaveBeenCalledExactlyOnceWith(context);
    expect(run).toHaveBeenCalledExactlyOnceWith(definition, {
      rateKey: "tenant", estimatedCost: { requests: 2 }, maxWaitMs: 20, signal: context.request.signal,
    }, expect.any(Function));
    expect(reportFeedback).not.toHaveBeenCalled();
  });

  it.each([
    { retryAfter: undefined, expected: undefined },
    { retryAfter: "", expected: undefined },
    { retryAfter: "2", expected: new Date("2026-01-01T00:00:02.000Z") },
    { retryAfter: "Thu, 01 Jan 2026 00:00:05 GMT", expected: new Date("2026-01-01T00:00:05.000Z") },
    { retryAfter: "malformed", expected: undefined },
  ])("classifies a 429 with Retry-After $retryAfter", async ({ retryAfter, expected }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const { throttling, reportFeedback } = createProbe();
      const client = createOutboundHttpClient({
        name: "partner", baseUrl: "https://partner.example",
        fetch: async () => new Response("limited", {
          status: 429, ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
        }),
        middleware: [throttleRequests({ throttling, definition })],
      });

      await expect(client.get("/resource")).rejects.toMatchObject({ status: 429, body: "limited" });
      expect(reportFeedback).toHaveBeenCalledExactlyOnceWith({
        kind: "throttled", ...(expected === undefined ? {} : { retryAt: expected }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a 429 when Retry-After exceeds the range of a Date", async () => {
    const throttling = new ThrottlingManager(new MemoryRateLimitAdapter(), { namespace: "outbound-test" });
    try {
      const client = createOutboundHttpClient({
        name: "partner", baseUrl: "https://partner.example",
        fetch: async () => new Response("limited", { status: 429, headers: { "retry-after": "9999999999999999" } }),
        middleware: [throttleRequests({ throttling, definition })],
      });

      // Unrepresentable feedback must not replace the remote HTTP error.
      await expect(client.get("/resource")).rejects.toMatchObject({
        name: "OutboundHttpResponseError", status: 429, body: "limited",
      });
    } finally {
      await throttling.close();
    }
  });

  it.each([
    { status: 403, kind: "permanent" },
    { status: 503, kind: "transient" },
  ])("reports $status as $kind without changing the error", async ({ status, kind }) => {
    const { throttling, reportFeedback } = createProbe();
    const client = createOutboundHttpClient({
      name: "partner", baseUrl: "https://partner.example",
      fetch: async () => new Response("failed", { status }),
      middleware: [throttleRequests({ throttling, definition })],
    });
    await expect(client.get("/resource")).rejects.toMatchObject({ status, body: "failed" });
    expect(reportFeedback).toHaveBeenCalledExactlyOnceWith({ kind });
  });

  it.each([
    { error: new OutboundHttpTimeoutError("operation", 20), kind: "timeout" },
    { error: new OutboundHttpTransportError("operation"), kind: "transient" },
    { error: new OutboundHttpAbortedError("operation"), kind: undefined },
    { error: new TypeError("invalid downstream options"), kind: "permanent" },
  ])("classifies downstream $error.name without losing the original failure", async ({ error, kind }) => {
    const { throttling, reportFeedback } = createProbe();
    const client = createOutboundHttpClient({
      name: "partner", baseUrl: "https://partner.example", fetch: vi.fn(),
      middleware: [
        throttleRequests({ throttling, definition }),
        defineOutboundHttpMiddleware("downstream", { priority: 900, handler: async () => { throw error; } }),
      ],
    });

    await expect(client.get("/resource")).rejects.toBe(error);
    if (kind === undefined) expect(reportFeedback).not.toHaveBeenCalled();
    else expect(reportFeedback).toHaveBeenCalledExactlyOnceWith({ kind });
  });

  it("cancels a queued admission on request expiry even with an explicit admission signal", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const customSignal = new AbortController();
    const cancelled = vi.fn();
    const throttling: Throttling = {
      acquire: vi.fn(), close: vi.fn(), inspect: vi.fn(),
      async run(_definition, optionsOrHandler): Promise<never> {
        if (typeof optionsOrHandler === "function") throw new Error("Admission options are required.");
        const signal = optionsOrHandler.signal!;
        started.resolve(signal);
        // Model a queued admission that cannot complete until its owner cancels it.
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            cancelled();
            reject(signal.reason);
          }, { once: true });
        });
      },
    };
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createOutboundHttpClient({
      name: "partner", baseUrl: "https://partner.example", fetch,
      middleware: [throttleRequests({ throttling, definition, acquire: { signal: customSignal.signal } })],
    });

    vi.useFakeTimers();
    try {
      const result = expect(client.get("/resource", { timeoutMs: 20 })).rejects.toBeInstanceOf(OutboundHttpTimeoutError);
      const signal = await started.promise;
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      await result;
      expect(cancelled).toHaveBeenCalledOnce();
      expect(customSignal.signal.aborted).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      customSignal.abort();
      vi.useRealTimers();
    }
  });

  it("cancels queued admission when only the configured admission signal aborts", async () => {
    const custom = new AbortController();
    const owner = new AbortController();
    const reason = new Error("admission cancelled");
    const queued = Promise.withResolvers<never>();
    let admissionSignal: AbortSignal | undefined;
    const throttling: Throttling = {
      acquire: vi.fn(), close: vi.fn(), inspect: vi.fn(),
      async run(_definition, optionsOrHandler): Promise<never> {
        if (typeof optionsOrHandler === "function") throw new Error("Admission options are required.");
        admissionSignal = optionsOrHandler.signal;
        admissionSignal?.addEventListener("abort", () => queued.reject(admissionSignal?.reason), { once: true });
        return queued.promise;
      },
    };
    const next = vi.fn();
    const middleware = throttleRequests({ throttling, definition, acquire: { signal: custom.signal } });
    const request = new Request("https://partner.example/resource", { signal: owner.signal });
    const outcome = middleware.handler({
      request, client: "partner", operation: "GET resource", route: "/resource", attempt: 1, maxResponseBytes: 32,
    }, next);
    void outcome.catch(() => {});
    try {
      // Assert signal propagation before awaiting work that would otherwise stay queued.
      expect(admissionSignal?.aborted).toBe(false);
      custom.abort(reason);
      expect(admissionSignal?.aborted).toBe(true);
      await expect(outcome).rejects.toBe(reason);
      expect(request.signal.aborted).toBe(false);
      expect(next).not.toHaveBeenCalled();
    } finally {
      owner.abort();
      queued.reject(reason);
    }
  });
});
