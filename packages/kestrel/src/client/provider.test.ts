import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import type { WebClientAdapter } from "./client.js";
import { ClientProvider } from "./provider.js";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("ClientProvider", () => {
  it("renders client routes while preserving excluded JSON boundaries", async () => {
    const setup = vi.fn<WebClientAdapter["setup"]>(async () =>
      ({ request, reply }) => reply.type("text/html").send(request.url)
    );
    const app = new App({});

    app.register(new ClientProvider({
      adapter: { setup },
      excludedPaths: ["/api"],
    }));
    const server = await mountExtensions(app);

    expect((await server.inject("/")).body).toBe("/");
    expect((await server.inject("/spaces/example")).body)
      .toBe("/spaces/example");
    expect((await server.inject("/api/known")).json())
      .toEqual({ status: "known" });

    const apiMiss = await server.inject("/api/missing");

    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.json()).toEqual({ error: "API route not found." });
    expect((await server.inject("/_client_assets/missing.js")).statusCode)
      .toBe(404);
    expect(setup).toHaveBeenCalledWith(
      expect.anything(),
      {
        basePath: "/",
        assetBasePath: "/_client_assets/",
      },
    );
  });

  it("supports a non-root client boundary", async () => {
    const app = new App({});

    app.register(new ClientProvider({
      adapter: {
        setup: async () => ({ reply }) => reply.send("client"),
      },
      basePath: "/app",
      assetBasePath: "/_app_assets/",
    }));
    const server = await mountExtensions(app);

    expect((await server.inject("/app")).body).toBe("client");
    expect((await server.inject("/app/")).body).toBe("client");
    expect((await server.inject("/app/page")).body).toBe("client");
    expect((await server.inject("/outside")).statusCode).toBe(404);
  });

  it("rejects ambiguous client paths", () => {
    const adapter: WebClientAdapter = {
      setup: async () => () => undefined,
    };

    expect(() => new ClientProvider({ adapter, basePath: "app" }))
      .toThrow("client base path");
    expect(() => new ClientProvider({ adapter, assetBasePath: "/" }))
      .toThrow("client asset base path");
    expect(() => new ClientProvider({ adapter, excludedPaths: ["/api/"] }))
      .toThrow("excluded client path");
  });
});

async function mountExtensions(app: App<{}>): Promise<FastifyInstance> {
  const server = Fastify();
  servers.push(server);

  for (const extension of app.httpExtensions.definitions) {
    server.register(async (scope) => {
      await extension.mount({ app, server: scope });
    });
  }

  // Concrete application routes remain more specific than excluded fallbacks.
  server.get("/api/known", async () => ({ status: "known" }));

  await server.ready();
  return server;
}
