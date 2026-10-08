import { describe, expect, it, vi } from "vitest";

import { configure, createConfigurationApi } from "../configuration/index.js";
import { outboundHttpConfigBase } from "./configuration.js";
import { text } from "./response.js";
import { OutboundHttpResponseTooLargeError } from "./errors.js";
import { App } from "../app/index.js";
import { AsyncLocalObserverContext, type Observer } from "../observability/index.js";
import { outboundHttpClientFactoryDependency } from "./dependencies.js";
import { OutboundHttpProvider } from "./provider.js";

describe("OutboundHttpProvider", () => {
  it("automatically records through the observer active for the execution", async () => {
    const observerContext = new AsyncLocalObserverContext();
    const observer = { record: vi.fn() } as unknown as Observer;
    const app = new App({ name: "test" });

    app.container.registerValue("observerContext", observerContext);
    app.register(new OutboundHttpProvider());

    const factory = app.container.resolve(outboundHttpClientFactoryDependency);
    const client = factory.create({
      name: "partner",
      baseUrl: "https://partner.example",
      fetch: vi.fn(async () => new Response(null, { status: 204 })) as (
        typeof globalThis.fetch
      ),
    });

    await observerContext.run(observer, () => client.get("/health"));

    expect(observer.record).toHaveBeenCalledTimes(2);
    expect(observer.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "http.client.attempt" }),
      expect.objectContaining({
        client: "partner",
        operation: "partner.GET./health",
      }),
      expect.objectContaining({ outcome: "success" }),
    );
    expect(observer.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "http.client.request" }),
      expect.objectContaining({ attempts: 1 }),
      expect.objectContaining({ outcome: "success" }),
    );
    await app.dispose();
  });

  it("keeps standalone factory use functional without observations", async () => {
    const app = new App({ name: "test" }).register(
      new OutboundHttpProvider(),
    );
    const factory = app.container.resolve(outboundHttpClientFactoryDependency);
    const client = factory.create({
      name: "partner",
      baseUrl: "https://partner.example",
      fetch: vi.fn(async () => new Response(null, { status: 204 })) as (
        typeof globalThis.fetch
      ),
    });

    await expect(client.get("/health")).resolves.toBeInstanceOf(Response);
    await app.dispose();
  });
  it("applies resolved configuration with call > client > provider precedence", async () => {
    const configuration = createConfigurationApi({
      environments: ["test"], defaultEnvironment: "test", environmentOverrides: { prefix: "TEST_CONFIG" },
    });
    const config = configuration.resolveConfig(configuration.defineConfig({
      outbound: configure(outboundHttpConfigBase, {}),
    }), { env: { TEST_CONFIG__OUTBOUND__MAX_RESPONSE_BYTES: "2" } });
    const app = new App({}).register(new OutboundHttpProvider(config.outbound));
    try {
      const factory = app.container.resolve(outboundHttpClientFactoryDependency);
      const options = { name: "limits", baseUrl: "https://example.test", fetch: async () => new Response("abc") };
      await expect(factory.create(options).get("/", { response: text() }))
        .rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
      const overridden = factory.create({ ...options, maxResponseBytes: 3 });
      await expect(overridden.get("/", { response: text() })).resolves.toBe("abc");
      await expect(overridden.get("/", { response: text(), maxResponseBytes: 1 }))
        .rejects.toBeInstanceOf(OutboundHttpResponseTooLargeError);
      await expect(factory.create(options).get("/", { response: text(), maxResponseBytes: 3 })).resolves.toBe("abc");
    } finally {
      await app.dispose();
    }
  });

  it("inherits independent error limits when a client overrides response bytes", async () => {
    const app = new App({}).register(new OutboundHttpProvider({ maxErrorBodyBytes: 2 }));
    try {
      const client = app.container.resolve(outboundHttpClientFactoryDependency).create({
        name: "errors", baseUrl: "https://example.test", maxResponseBytes: 10,
        fetch: async () => new Response("error", { status: 400 }),
      });
      await expect(client.get("/")).rejects.toMatchObject({ body: { truncated: true, text: "er" } });
      await expect(client.get("/", { maxErrorBodyBytes: 3 })).rejects.toMatchObject({ body: { truncated: true, text: "err" } });
    } finally {
      await app.dispose();
    }
  });

  it.each([
    { clientTimeout: undefined, callTimeout: undefined, expected: 5 },
    { clientTimeout: 10, callTimeout: undefined, expected: 10 },
    { clientTimeout: 10, callTimeout: 15, expected: 15 },
  ])("keeps timeout inheritance through body decoding ($expected ms)", async ({ clientTimeout, callTimeout, expected }) => {
    vi.useFakeTimers();
    const app = new App({}).register(new OutboundHttpProvider({ timeoutMs: 5 }));
    const cancel = vi.fn();
    try {
      const client = app.container.resolve(outboundHttpClientFactoryDependency).create({
        name: "timeouts", baseUrl: "https://example.test",
        ...(clientTimeout === undefined ? {} : { timeoutMs: clientTimeout }),
        fetch: async () => new Response(new ReadableStream({ cancel })),
      });
      const assertion = expect(client.get("/", {
        response: text(), ...(callTimeout === undefined ? {} : { timeoutMs: callTimeout }),
      })).rejects.toMatchObject({ name: "OutboundHttpTimeoutError", timeoutMs: expected });
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await app.dispose();
      vi.useRealTimers();
    }
  });

  it.each([0, -1, Infinity, NaN])("rejects invalid provider defaults (%s)", (value) => {
    expect(() => new OutboundHttpProvider({ timeoutMs: value })).toThrow();
    expect(() => new OutboundHttpProvider({ maxResponseBytes: value })).toThrow();
    expect(() => new OutboundHttpProvider({ maxErrorBodyBytes: value })).toThrow();
  });

});
