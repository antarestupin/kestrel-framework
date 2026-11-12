import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  bytes, createOutboundHttpClient, defineOutboundHttpMiddleware, json, nativeResponse, text,
  OutboundHttpAbortedError, OutboundHttpDecodeError, OutboundHttpResponseError,
  OutboundHttpResponseTooLargeError, OutboundHttpTimeoutError, OutboundHttpTransportError,
  type OutboundHttpInstrumentationEvent,
} from "./index.js";

const baseUrl = "https://partner.example";

function observedClient(fetch: typeof globalThis.fetch, monotonicNow?: () => number) {
  const events: OutboundHttpInstrumentationEvent[] = [];
  const client = createOutboundHttpClient({
    name: "partner", baseUrl, fetch,
    instrumentation: { record: (event) => events.push(event) },
    ...(monotonicNow === undefined ? {} : { monotonicNow }),
  });
  return { client, events };
}

describe("outbound diagnostics", () => {
  it("records exact attempt and request metadata and elapsed time", async () => {
    const clock = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20)
      .mockReturnValueOnce(32).mockReturnValueOnce(45);
    const { client, events } = observedClient(async () => new Response(null, { status: 204 }), clock);
    await client.get("/accounts/:id", { path: { id: "private" } });

    const data = { client: "partner", operation: "partner.GET./accounts/:id", route: "/accounts/:id",
      method: "GET", status: 204, result: "response" };
    expect(events).toStrictEqual([
      { type: "attempt", outcome: "success", durationMs: 12, data: { ...data, attempt: 1 } },
      { type: "request", outcome: "success", durationMs: 35, data: { ...data, attempts: 1 } },
    ]);
  });

  it("uses the default clock only when diagnostics are enabled", async () => {
    let tick = 50;
    const now = vi.spyOn(performance, "now").mockImplementation(() => tick);
    const fetch = async () => { tick += 12; return new Response(null, { status: 204 }); };
    try {
      const { client, events } = observedClient(fetch);
      await client.get("/health");
      expect(events.map(({ durationMs }) => durationMs)).toEqual([12, 12]);
      const unusedClock = vi.fn(() => 100);
      await createOutboundHttpClient({ name: "quiet", baseUrl, fetch, monotonicNow: unusedClock }).get("/health");
      expect(unusedClock).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it.each([
    { samples: [undefined, 20, 30, 40], expected: [10, 0] },
    { samples: [50, 40, 30, 20], expected: [0, 0] },
    { samples: [10, 20, undefined, undefined], expected: [0, 0] },
  ])("clamps missing or backward clock samples ($samples)", async ({ samples, expected }) => {
    const readings = [...samples];
    const clock = () => {
      const sample = readings.shift();
      if (sample === undefined) throw new Error("diagnostic clock unavailable");
      return sample;
    };
    const { client, events } = observedClient(async () => new Response(null, { status: 204 }), clock);
    await expect(client.get("/health")).resolves.toMatchObject({ status: 204 });
    expect(events.map(({ durationMs }) => durationMs)).toEqual(expected);
  });

  it.each([
    [new OutboundHttpTimeoutError("attempt", 5), "timeout"],
    [new OutboundHttpAbortedError("attempt"), "aborted"],
    [new OutboundHttpTransportError("attempt"), "network-error"],
    [new Error("native network failure"), "network-error"],
  ] as const)("observes a failed attempt as %s with %s feedback", async (failure, result) => {
    const { client, events } = observedClient(async () => { throw failure; }, () => 0);
    const call = client.get("/resource");
    if (failure.constructor === Error) {
      await expect(call).rejects.toMatchObject({ name: "OutboundHttpTransportError", cause: failure });
    } else {
      await expect(call).rejects.toBe(failure);
    }

    const data = { client: "partner", operation: "partner.GET./resource", route: "/resource", method: "GET", result };
    expect(events).toStrictEqual([
      { type: "attempt", outcome: "failure", durationMs: 0, data: { ...data, attempt: 1 } },
      { type: "request", outcome: "failure", durationMs: 0, data: { ...data, attempts: 1 } },
    ]);
  });

  it("keeps the received status in observations when decoding fails", async () => {
    const cause = new Error("invalid application response");
    const { client, events } = observedClient(async () => new Response("data", { status: 201 }), () => 0);
    await expect(client.get("/create", { response: { description: "custom", decode: () => { throw cause; } } }))
      .rejects.toMatchObject({ name: "OutboundHttpDecodeError", decoder: "custom", cause });
    expect(events.map(({ type, outcome, data }) => ({ type, outcome, result: data.result, status: data.status })))
      .toStrictEqual([
        { type: "attempt", outcome: "success", result: "response", status: 201 },
        { type: "request", outcome: "failure", result: "error", status: 201 },
      ]);
  });

  it("preserves the abort cause supplied by a replacement request", async () => {
    const controller = new AbortController();
    const cause = new Error("middleware cancellation");
    const { client, events } = observedClient(async (input) => {
      (input as Request).signal.throwIfAborted();
      return new Response(null, { status: 204 });
    });
    const replace = defineOutboundHttpMiddleware("replace", { handler: async ({ request }, next) => {
      const replacement = new Request(request, { signal: controller.signal });
      controller.abort(cause);
      return next({ request: replacement });
    } });
    await expect(client.get("/health", { middleware: [replace] }))
      .rejects.toMatchObject({ name: "OutboundHttpAbortedError", cause });
    expect(events.map(({ data }) => data.result)).toEqual(["aborted", "aborted"]);
  });

  it("validates standalone client and per-call budgets before sending a request", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const options = { name: "partner", baseUrl, fetch };
    expect(() => createOutboundHttpClient({ ...options, timeoutMs: Infinity })).toThrow("positive and finite");
    const client = createOutboundHttpClient(options);
    await expect(client.get("/health", { maxResponseBytes: 0 })).rejects.toThrow("positive safe integer");
    await expect(client.get("/health", { maxErrorBodyBytes: 0 })).rejects.toThrow("positive safe integer");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a fetch implementation when the runtime has no default", () => {
    vi.stubGlobal("fetch", undefined);
    try {
      expect(() => createOutboundHttpClient({ name: "missing", baseUrl }))
        .toThrow("An outbound HTTP fetch implementation is required.");
    } finally { vi.unstubAllGlobals(); }
  });

  it("exposes the decoder descriptions and transfers the native body to its owner", async () => {
    expect([json(z.string()), text(), bytes()].map(({ description }) => description)).toEqual(["JSON", "text", "binary"]);
    const decoder = nativeResponse();
    expect(decoder).toMatchObject({ description: "native", lifetime: "stream" });
    const response = new Response("owned");
    await expect(decoder.decode(response, { signal: new AbortController().signal })).resolves.toBe(response);
    await expect(response.text()).resolves.toBe("owned");
  });

  it("retains exact diagnostic messages for typed failures", () => {
    const failures = [
      [new OutboundHttpTimeoutError("health", 5), "OutboundHttpTimeoutError", 'Outbound HTTP operation "health" exceeded its 5ms deadline.'],
      [new OutboundHttpAbortedError("health"), "OutboundHttpAbortedError", 'Outbound HTTP operation "health" was aborted.'],
      [new OutboundHttpTransportError("health"), "OutboundHttpTransportError", 'Outbound HTTP operation "health" failed before receiving a response.'],
      [new OutboundHttpResponseError("health", 503, "busy", "retry"), "OutboundHttpResponseError", 'Outbound HTTP operation "health" failed with status 503.'],
      [new OutboundHttpDecodeError("health", "JSON"), "OutboundHttpDecodeError", 'Outbound HTTP operation "health" returned an invalid JSON response.'],
      [new OutboundHttpResponseTooLargeError("health", 2), "OutboundHttpResponseTooLargeError", 'Outbound HTTP operation "health" exceeded its 2 byte response limit.'],
    ] as const;
    for (const [error, name, message] of failures) expect(error).toMatchObject({ name, message });
  });
});
