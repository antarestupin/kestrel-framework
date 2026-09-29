import { describe, expect, it, vi } from "vitest";

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
});
