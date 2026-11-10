import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";

import { OutboundHttpDeadline } from "./deadline.js";
import { OutboundHttpBodies } from "./body.js";
import { OutboundHttpAbortedError, OutboundHttpResponseTooLargeError, OutboundHttpTimeoutError, OutboundHttpTransportError } from "./errors.js";
import { createOutboundHttpClient } from "./client.js";
import { defineOutboundHttpMiddleware } from "./middleware.js";
import { retryRequests, type RetryOutboundHttpOptions } from "./middleware/retry/index.js";
import type { OutboundHttpMiddlewareContext, OutboundHttpNext } from "./types.js";

const context = (method = "GET", signal?: AbortSignal): OutboundHttpMiddlewareContext => ({
  client: "contract", operation: "request", route: "/item", attempt: 1, maxResponseBytes: 128,
  request: new Request("https://partner.test/item", { method, ...(signal === undefined ? {} : { signal }) }),
});
const emptyResponse = (status = 200, headers?: HeadersInit) => new Response(null, { status, ...(headers === undefined ? {} : { headers }) });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("outbound retry contracts", () => {
  for (const method of ["DELETE", "GET", "HEAD", "OPTIONS", "PUT"]) {
    it(`retries ${method} by default`, async () => {
      const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(emptyResponse(503)).mockResolvedValueOnce(emptyResponse());
      const sleep = vi.fn(async (_delay: number, _signal: AbortSignal) => {});
      const result = await retryRequests({ sleep, random: () => 0.5 }).handler(context(method), next);
      expect(result.status).toBe(200);
      expect(next).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(100, expect.any(AbortSignal));
    });
  }
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    it(`retries the default transient status ${status}`, async () => {
      const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(emptyResponse(status)).mockResolvedValueOnce(emptyResponse());
      expect((await retryRequests({ sleep: async () => {} }).handler(context(), next)).status).toBe(200);
      expect(next).toHaveBeenCalledTimes(2);
    });
  }
  it("returns the last response after exactly three default attempts", async () => {
    const next = vi.fn<OutboundHttpNext>().mockImplementation(async () => emptyResponse(503));
    const sleep = vi.fn(async (_delay: number, _signal: AbortSignal) => {});
    expect((await retryRequests({ sleep, random: () => 0.5 }).handler(context(), next)).status).toBe(503);
    expect(next.mock.calls.map(([options]) => options?.attempt)).toEqual([1, 2, 3]);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([100, 200]);
  });
  it("normalizes explicitly enabled methods and replays fresh body clones", async () => {
    const ctx = { ...context("POST"), request: new Request("https://partner.test/item", { method: "POST", body: "original" }) };
    const bodies: string[] = [];
    const next: OutboundHttpNext = vi.fn(async (options) => {
      bodies.push(await options!.request!.text());
      return emptyResponse(bodies.length === 1 ? 503 : 200);
    });
    expect((await retryRequests({ methods: [" post "], sleep: async () => {} }).handler(ctx, next)).status).toBe(200);
    expect(bodies).toEqual(["original", "original"]);
    expect(ctx.request.bodyUsed).toBe(false);
    await ctx.request.body?.cancel();
  });
  it("uses explicit statuses and does not retry ordinary HTTP errors", async () => {
    for (const status of [400, 401, 404, 409]) {
      const next = vi.fn<OutboundHttpNext>().mockResolvedValue(emptyResponse(status));
      expect((await retryRequests().handler(context(), next)).status).toBe(status);
      expect(next).toHaveBeenCalledOnce();
    }
    const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(emptyResponse(409)).mockResolvedValueOnce(emptyResponse());
    expect((await retryRequests({ statuses: [409], sleep: async () => {} }).handler(context(), next)).status).toBe(200);
    expect(next).toHaveBeenCalledTimes(2);
  });
  for (const failure of [new OutboundHttpTransportError("transport"), new OutboundHttpTimeoutError("attempt", 1)]) {
    it(`retries ${failure.name} and preserves the last error`, async () => {
      const next = vi.fn<OutboundHttpNext>().mockRejectedValue(failure);
      const sleep = vi.fn(async (_delay: number, _signal: AbortSignal) => {});
      await expect(retryRequests({ maxAttempts: 2, sleep }).handler(context(), next)).rejects.toBe(failure);
      expect(next).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledOnce();
    });
  }
  it("does not retry arbitrary failures or cancellation", async () => {
    for (const failure of [new Error("application failure"), new OutboundHttpAbortedError("cancelled")]) {
      const next = vi.fn<OutboundHttpNext>().mockRejectedValue(failure);
      const sleep = vi.fn(async (_delay: number, _signal: AbortSignal) => {});
      await expect(retryRequests({ sleep }).handler(context(), next)).rejects.toBe(failure);
      expect(next).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    }
  });
  for (const [label, header, delay] of [
    ["seconds", " 2 ", 2_000], ["zero", "0", 0], ["future date", "Thu, 01 Jan 2026 00:00:03 GMT", 3_000],
    ["past date", "Wed, 31 Dec 2025 23:59:59 GMT", 0], ["negative seconds", "-1", 0], ["invalid", "nonsense", 100], ["empty", "", 100],
  ] as const) {
    it(`handles Retry-After ${label}`, async () => {
      vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const sleep = vi.fn(async (_delay: number, _signal: AbortSignal) => {});
      const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(emptyResponse(503, { "retry-after": header })).mockResolvedValueOnce(emptyResponse());
      await retryRequests({ sleep, random: () => 0.5 }).handler(context(), next);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(delay, expect.any(AbortSignal));
    });
  }
  it("caps Retry-After independently of its source", async () => {
    const sleep = vi.fn(async (_delay: number, _signal: AbortSignal) => {});
    const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(emptyResponse(503, { "retry-after": "999" })).mockResolvedValueOnce(emptyResponse());
    await retryRequests({ maxDelayMs: 250, sleep }).handler(context(), next);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(250, expect.any(AbortSignal));
  });
  it("interprets zero Retry-After as a delay independently of the wall clock", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const sleep = vi.fn(async (_delay: number, _signal: AbortSignal) => {});
    const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(emptyResponse(503, { "retry-after": "0" })).mockResolvedValueOnce(emptyResponse());
    await retryRequests({ sleep }).handler(context(), next);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(0, expect.any(AbortSignal));
  });
  for (const [random, factor] of [[0, 0.8], [1, 1.2]] as const) {
    it(`applies default jitter at random endpoint ${random}`, async () => {
      const sleep = vi.fn(async (_delay: number, _signal: AbortSignal) => {});
      const next = vi.fn<OutboundHttpNext>().mockImplementation(async () => emptyResponse(503));
      await retryRequests({ maxAttempts: 4, maxDelayMs: 250, random: () => random, sleep }).handler(context(), next);
      expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([100 * factor, 200 * factor, Math.min(250, 250 * factor)]);
    });
  }
  it("caps jittered transport-error backoff at the configured maximum", async () => {
    const failure = new OutboundHttpTransportError("transport");
    const next = vi.fn<OutboundHttpNext>().mockRejectedValue(failure);
    const sleep = vi.fn(async (_delay: number, _signal: AbortSignal) => {});
    await expect(retryRequests({ maxAttempts: 4, maxDelayMs: 250, random: () => 1, sleep }).handler(context(), next)).rejects.toBe(failure);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([120, 240, 250]);
  });
  it("cancels every discarded response before sleeping", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { status: 503 });
    const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(response).mockResolvedValueOnce(emptyResponse());
    await retryRequests({ sleep: async () => { expect(cancel).toHaveBeenCalledOnce(); } }).handler(context(), next);
    expect(response.body?.locked).toBe(false);
  });
  it("uses real cancellable backoff and clears its timer on abort", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const next = vi.fn<OutboundHttpNext>().mockImplementation(async () => emptyResponse(503));
    const operation = retryRequests({ jitterRatio: 0 }).handler(context("GET", abort.signal), next);
    const failure = new Error("caller stopped");
    const result = expect(operation).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(next).toHaveBeenCalledOnce();
    abort.abort(failure);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears real backoff timers after success and supports zero delay", async () => {
    vi.useFakeTimers();
    const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(emptyResponse(503)).mockResolvedValueOnce(emptyResponse());
    const operation = retryRequests({ initialDelayMs: 0, jitterRatio: 0 }).handler(context(), next);
    await vi.advanceTimersByTimeAsync(0);
    expect((await operation).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("removes a successful backoff's cancellation listener", async () => {
    vi.useFakeTimers();
    const ctx = context();
    const previous = getEventListeners(ctx.request.signal, "abort").length;
    const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(emptyResponse(503)).mockResolvedValueOnce(emptyResponse());
    const operation = retryRequests({ jitterRatio: 0 }).handler(ctx, next);
    await vi.advanceTimersByTimeAsync(100);
    await operation;
    expect(getEventListeners(ctx.request.signal, "abort")).toHaveLength(previous);
  });
  it("does not overflow a retry backoff beyond a single Node timer interval", async () => {
    vi.useFakeTimers();
    const next = vi.fn<OutboundHttpNext>().mockResolvedValueOnce(emptyResponse(503)).mockResolvedValueOnce(emptyResponse());
    const operation = retryRequests({ initialDelayMs: 2_147_483_650, maxDelayMs: 2_147_483_650, jitterRatio: 0 }).handler(context(), next);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(next).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_147_483_646);
      expect(next).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3);
      // Assert the exact logical deadline before cleanup drains any remaining timer.
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      await vi.runAllTimersAsync();
      await operation;
    }
    expect(next).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a rearmed long backoff without retaining timers", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const next = vi.fn<OutboundHttpNext>().mockImplementation(async () => emptyResponse(503));
    const operation = retryRequests({ initialDelayMs: 2_147_483_650, maxDelayMs: 2_147_483_650, jitterRatio: 0 }).handler(context("GET", abort.signal), next);
    const failure = new Error("cancel long delay");
    const outcome = expect(operation).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    abort.abort(failure);
    await outcome;
    expect(next).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("refuses an already aborted attempt without invoking downstream code", async () => {
    const abort = new AbortController(); abort.abort("cancelled");
    const next = vi.fn<OutboundHttpNext>();
    await expect(retryRequests().handler(context("GET", abort.signal), next)).rejects.toBe("cancelled");
    expect(next).not.toHaveBeenCalled();
  });
  it("places default retry before per-attempt middleware", async () => {
    const attempts: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(emptyResponse(503)).mockResolvedValueOnce(emptyResponse());
    const client = createOutboundHttpClient({ name: "ordered-retry", baseUrl: "https://partner.test", fetch,
      middleware: [retryRequests({ sleep: async () => {} }), defineOutboundHttpMiddleware("attempt", {
        priority: 300, handler: async (ctx, next) => { attempts.push(ctx.attempt); return next(); },
      })],
    });
    await client.get("/item");
    expect(attempts).toEqual([1, 2]);
  });
  it("accepts one attempt and the full jitter boundary", async () => {
    const next = vi.fn<OutboundHttpNext>().mockResolvedValue(emptyResponse(503));
    const sleep = vi.fn(async () => {});
    await retryRequests({ maxAttempts: 1, jitterRatio: 1, sleep }).handler(context(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
  it("preserves a non-Error cancellation cause during backoff", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const operation = retryRequests().handler(context("GET", abort.signal), async () => emptyResponse(503));
    const outcome = expect(operation).rejects.toMatchObject({ cause: "caller stopped" });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort("caller stopped");
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("observes cancellation that occurs before backoff is registered", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const failure = new Error("cancelled after response");
    let outcome: PromiseSettledResult<Response> | undefined;
    const operation = retryRequests().handler(context("GET", abort.signal), async () => {
      abort.abort(failure);
      return emptyResponse(503);
    });
    void operation.then(
      (value) => { outcome = { status: "fulfilled", value }; },
      (reason: unknown) => { outcome = { status: "rejected", reason }; },
    );
    try {
      // Cancellation must settle without waiting for the retry delay to elapse.
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toEqual({ status: "rejected", reason: failure });
      expect(vi.getTimerCount()).toBe(0);
    } finally { await vi.runAllTimersAsync(); }
  });
  for (const options of [
    { maxAttempts: 0 }, { maxAttempts: -1 }, { maxAttempts: 1.5 }, { initialDelayMs: -1 }, { initialDelayMs: Infinity },
    { maxDelayMs: Infinity }, { maxDelayMs: 99 }, { jitterRatio: -0.1 }, { jitterRatio: 1.1 }, { jitterRatio: NaN }, { methods: [" "] },
  ] satisfies RetryOutboundHttpOptions[]) {
    it(`rejects invalid retry configuration ${JSON.stringify(options)}`, () => {
      expect(() => retryRequests(options)).toThrow(TypeError);
    });
  }
});

describe("outbound deadline and body contracts", () => {
  it("removes the deadline cancellation observer on close", () => {
    const deadline = new OutboundHttpDeadline("closed-observer", undefined, undefined);
    deadline.close();
    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
  });
  it("does not allocate a timer without a timeout budget", async () => {
    vi.useFakeTimers();
    const deadline = new OutboundHttpDeadline("unlimited", undefined, undefined);
    try {
      await expect(deadline.run(async () => "done")).resolves.toBe("done");
      expect(vi.getTimerCount()).toBe(0);
    } finally { deadline.close(); }
  });
  it("preserves caller cancellation and prevents operation side effects", async () => {
    const abort = new AbortController(); abort.abort("caller reason");
    const deadline = new OutboundHttpDeadline("cancelled", undefined, abort.signal);
    const operation = vi.fn(async () => "unexpected");
    try {
      await expect(deadline.run(operation)).rejects.toMatchObject({ cause: "caller reason" });
      expect(operation).not.toHaveBeenCalled();
    } finally { deadline.close(); }
  });
  it("checks the deadline again after synchronous operation work", async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const deadline = new OutboundHttpDeadline("synchronous", 10, undefined);
    try {
      await expect(deadline.run(async () => { now.mockReturnValue(10); return "overdue"; })).rejects.toBeInstanceOf(OutboundHttpTimeoutError);
    } finally { deadline.close(); }
  });
  it("propagates an ordinary stream read error without converting it to a size violation", async () => {
    const failure = new Error("source failed");
    const deadline = new OutboundHttpDeadline("read", undefined, undefined);
    const bodies = new OutboundHttpBodies("read", deadline, 16, 4);
    const original = new Response(new ReadableStream({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 }));
    try {
      let outcome: PromiseSettledResult<string> | undefined;
      void bodies.protect(original).text().then(
        (value) => { outcome = { status: "fulfilled", value }; },
        (reason: unknown) => { outcome = { status: "rejected", reason }; },
      );
      // This controlled source fails synchronously; a missing catch must fail an
      // outcome assertion rather than wait for the generic test timeout.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toEqual({ status: "rejected", reason: failure });
      expect(() => bodies.check()).not.toThrow();
      expect(original.body?.locked).toBe(false);
    } finally { bodies.close(); deadline.close(); }
  });
  it("shares truncation state across wrappers of a protected stream", async () => {
    const deadline = new OutboundHttpDeadline("shared", undefined, undefined);
    const bodies = new OutboundHttpBodies("shared", deadline, 16, 4);
    try {
      const response = bodies.protect(new Response("12345", { status: 500 }));
      const wrapped = bodies.protect(new Response(response.body, { status: 500 }));
      expect(await wrapped.text()).toBe("1234");
      expect(bodies.truncated(wrapped)).toBe(true);
      expect(bodies.truncated(response)).toBe(true);
    } finally { bodies.close(); deadline.close(); }
  });
  it("keeps the overall size limit when error truncation is disabled", async () => {
    const deadline = new OutboundHttpDeadline("overall", undefined, undefined);
    const bodies = new OutboundHttpBodies("overall", deadline, 4, undefined);
    try {
      await expect(bodies.protect(new Response("12345", { status: 500 })).text()).rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
      expect(() => bodies.check()).toThrow(OutboundHttpResponseTooLargeError);
    } finally { bodies.close(); deadline.close(); }
  });
  it("does not eagerly pull an unconsumed protected body", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => { controller.enqueue(new Uint8Array([1])); });
    const deadline = new OutboundHttpDeadline("lazy", undefined, undefined);
    const bodies = new OutboundHttpBodies("lazy", deadline, 16, undefined);
    try {
      bodies.protect(new Response(new ReadableStream({ pull }, { highWaterMark: 0 })));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pull).not.toHaveBeenCalled();
    } finally { bodies.close(); deadline.close(); }
  });
  it("cancels and unlocks the source after truncating an error body", async () => {
    const cancel = vi.fn();
    const original = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("12345")); }, cancel,
    }, { highWaterMark: 0 }), { status: 500 });
    const deadline = new OutboundHttpDeadline("truncation-cleanup", undefined, undefined);
    const bodies = new OutboundHttpBodies("truncation-cleanup", deadline, 16, 4);
    try {
      expect(await bodies.protect(original).text()).toBe("1234");
      expect(cancel).toHaveBeenCalledOnce();
      expect(original.body?.locked).toBe(false);
    } finally { bodies.close(); deadline.close(); }
  });
  it("releases a consumed body's cancellation observer", async () => {
    const deadline = new OutboundHttpDeadline("body-observer", undefined, undefined);
    const bodies = new OutboundHttpBodies("body-observer", deadline, 16, undefined);
    const previous = getEventListeners(deadline.signal, "abort").length;
    try {
      expect(await bodies.protect(new Response("done")).text()).toBe("done");
      expect(getEventListeners(deadline.signal, "abort")).toHaveLength(previous);
    } finally { bodies.close(); deadline.close(); }
  });
  for (const state of ["aborted", "closed"] as const) {
    it(`rejects a fresh body after its owner is ${state}`, async () => {
      const abort = new AbortController();
      const deadline = new OutboundHttpDeadline("late", undefined, abort.signal);
      const bodies = new OutboundHttpBodies("late", deadline, 16, undefined);
      try {
        if (state === "aborted") abort.abort("stopped");
        else bodies.close();
        await expect(bodies.protect(new Response("late")).text()).rejects.toBeInstanceOf(Error);
      } finally { bodies.close(); deadline.close(); }
    });
  }
  it("keeps long deadlines beyond Node's single-timer range", async () => {
    vi.useFakeTimers();
    const deadline = new OutboundHttpDeadline("long", 2_147_483_650, undefined);
    try {
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(deadline.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(3);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.error()).toBeInstanceOf(OutboundHttpTimeoutError);
    } finally { deadline.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects an overdue synchronous operation and clears on close", async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const deadline = new OutboundHttpDeadline("sync", 10, undefined);
    try {
      now.mockReturnValue(10);
      expect(() => deadline.check()).toThrow(OutboundHttpTimeoutError);
    } finally { deadline.close(); }
    expect(vi.getTimerCount()).toBe(0);
    const closed = new OutboundHttpDeadline("closed", undefined, undefined);
    closed.close();
    await expect(closed.run(async () => "late")).rejects.toThrow(Error);
  });
  it("retains transport metadata and protects wrappers of the same body only once", async () => {
    const deadline = new OutboundHttpDeadline("metadata", undefined, undefined);
    const bodies = new OutboundHttpBodies("metadata", deadline, 16, 4);
    const response = new Response("data", { headers: { "x-test": "retained" }, statusText: "fine" });
    Object.defineProperties(response, { url: { value: "https://partner.test/final" }, redirected: { value: true } });
    try {
      const protectedResponse = bodies.protect(response);
      expect(protectedResponse).toMatchObject({ url: response.url, redirected: true, type: response.type, statusText: "fine" });
      expect(protectedResponse.headers.get("x-test")).toBe("retained");
      expect(bodies.protect(protectedResponse)).toBe(protectedResponse);
      const wrapper = new Response(protectedResponse.body);
      expect(bodies.protect(wrapper)).toBe(wrapper);
      expect(await wrapper.text()).toBe("data");
    } finally { bodies.close(); deadline.close(); }
  });
  for (const length of [4, 5]) {
    it(`marks error response truncation only beyond the exact byte boundary ${length}`, async () => {
      const deadline = new OutboundHttpDeadline("truncate", undefined, undefined);
      const bodies = new OutboundHttpBodies("truncate", deadline, 16, 4);
      try {
        const response = bodies.protect(new Response("x".repeat(length), { status: 500 }));
        expect(await response.text()).toBe("xxxx");
        expect(bodies.truncated(response)).toBe(length > 4);
        expect(bodies.truncated(emptyResponse())).toBe(false);
      } finally { bodies.close(); deadline.close(); }
    });
  }
});
