import { defineStudioClientAdapter } from "./index.js";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { anonymousHttpAccess, defineHttpAccessPolicy, defineHttpController, defineHttpMiddleware, get } from "../http/index.js";
import { setExecutionLogEnabledDependency } from "../log/index.js";
import { AsyncLocalObserverContext, NoopObservationRecorder, ScopedObserver, type ObservationEvent } from "../observability/index.js";
import { defineActionsDocumentationExtension } from "./extensions/actions/index.js";
import {
  STUDIO_ASSET_BASE_PATH,
  type Studio,
  type StudioClientAdapter,
  type StudioClientRender,
  StudioProvider,
} from "./index.js";

/** Supplies deterministic Studio assets without starting Vite. */
class TestStudioClientAdapter implements StudioClientAdapter {
  public readonly setup = vi.fn(
    async (server: FastifyInstance, _studio: Studio): Promise<StudioClientRender> => {
      // This hook models Vite's encapsulated development middleware.
      server.addHook("onRequest", async (request, reply) => {
        reply.header("x-studio-scope", "active");

        if (request.url.startsWith(STUDIO_ASSET_BASE_PATH)) {
          return reply.type("application/javascript").send("export const studioAsset = true;");
        }
      });

      return (reply: FastifyReply) =>
        reply.type("text/html").send("<main>Studio test client</main>");
    },
  );
}

describe("StudioProvider", () => {
  it("serves the SPA at the root while keeping missing API and assets on their own routes", async () => {
    const server = Fastify();
    const app = new App({});
    const client = defineStudioClientAdapter({
      dependencies: {}, capabilities: {},
      create: () => ({ setup: async () => (reply) => reply.type("text/html").send("<main>Studio</main>") }),
    });
    app.register(new StudioProvider({ enabled: true, devMode: false, basePath: "/" }, client));
    try {
      for (const extension of app.httpExtensions.definitions) {
        await extension.mount({ app, server, defaultAccess: anonymousHttpAccess });
      }
      await app.start();
      expect((await server.inject("/")).body).toBe("<main>Studio</main>");
      expect((await server.inject("/logs/history")).body).toBe("<main>Studio</main>");
      expect((await server.inject("/api/manifest")).json()).toMatchObject({ basePath: "/", extensions: [] });
      for (const [path, message] of [["/api/missing", "Studio API route not found."],
        [`${STUDIO_ASSET_BASE_PATH}missing.js`, "Studio asset not found."]] as const) {
        const response = await server.inject(path);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: message });
      }
    } finally {
      await server.close();
      await app.dispose();
    }
  });

  it("mounts its client and configured extensions when enabled", async () => {
    const server = Fastify();
    const app = new App({ name: "test" });
    const client = new TestStudioClientAdapter();
    const setExecutionLogEnabled = vi.fn();
    onTestFinished(async () => {
      try { await server.close(); } finally { await app.dispose(); }
    });

    app.container.registerFactory(
      setExecutionLogEnabledDependency.id,
      () => setExecutionLogEnabled,
      { lifetime: "scoped" },
    );

    app.register(
      new StudioProvider(
        {
          enabled: true,
          devMode: false,
          basePath: "/tools",
        },
        defineStudioClientAdapter({ dependencies: {}, capabilities: {}, create: () => client }),
        {
          extensions: [
            defineActionsDocumentationExtension([
              {
                name: "example.run",
                description: "Run the example.",
                middleware: [],
              },
            ]),
          ],
        },
      ),
    );

    for (const extension of app.httpExtensions.definitions) {
      await extension.mount({ app, server });
    }
    await app.start();
    expect(app.container.resolve(dep<Studio>("studio")).basePath).toBe("/tools");
    expect(app.container.resolve(dep<StudioClientAdapter>("studioClientAdapter:/tools"))).toBe(client);
    for (const path of ["/tools", "/tools/"]) {
      expect((await server.inject(path)).body).toContain("Studio test client");
    }

    const pageResponse = await server.inject({
      method: "GET",
      url: "/tools/actions",
    });
    const manifestResponse = await server.inject({
      method: "GET",
      url: "/tools/api/manifest",
    });
    const actionsResponse = await server.inject({
      method: "GET",
      url: "/tools/api/extensions/actions-documentation/actions",
    });
    const missingApiResponse = await server.inject({
      method: "GET",
      url: "/tools/api/missing",
    });
    const assetResponse = await server.inject({
      method: "GET",
      url: `${STUDIO_ASSET_BASE_PATH}@vite/client`,
    });

    expect(pageResponse.statusCode).toBe(200);
    expect(pageResponse.body).toContain("Studio test client");
    const outside = await server.inject("/toolshed/actions");
    expect(outside.statusCode).toBe(404);
    expect(outside.headers["x-studio-scope"]).toBeUndefined();
    expect(manifestResponse.headers["x-studio-scope"]).toBe("active");
    expect(manifestResponse.json()).toMatchObject({ basePath: "/tools" });
    expect(actionsResponse.json()).toEqual({
      executionPath: "/tools/api/extensions/actions-documentation/actions/execute",
      actions: [
        {
          name: "example.run",
          description: "Run the example.",
          middleware: [],
          execution: { enabled: false, reason: expect.any(String) },
        },
      ],
    });
    expect(client.setup).toHaveBeenCalledOnce();
    expect(missingApiResponse.statusCode).toBe(404);
    expect(missingApiResponse.json()).toEqual({
      error: "Studio API route not found.",
    });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.body).toContain("studioAsset");
    expect(setExecutionLogEnabled).toHaveBeenCalled();
    expect(setExecutionLogEnabled.mock.calls.every(([enabled]) => enabled === false)).toBe(true);

    await server.close();
    await app.dispose();
  });

  it("applies inherited access to extension controllers while keeping technical observations off", async () => {
    const server = Fastify();
    const app = new App({});
    onTestFinished(async () => {
      try { await server.close(); } finally { await app.dispose(); }
    });
    const recorded: ObservationEvent[] = [];
    class Recorder extends NoopObservationRecorder {
      public override enqueue(event: ObservationEvent): void { recorded.push(event); }
    }
    const recorder = new Recorder();
    app.container.registerValue("observerContext", new AsyncLocalObserverContext());
    app.container.registerFactory("observer", ({ executionId }: { executionId: string }) =>
      new ScopedObserver(executionId, recorder), { lifetime: "scoped" });
    const inherited = vi.fn();
    const defaultAccess = defineHttpAccessPolicy("test.studio", [
      defineHttpMiddleware("test.studio.access", { handler: async (_context, next) => {
        inherited();
        return next();
      } }),
    ]);
    const client = defineStudioClientAdapter({
      dependencies: {}, capabilities: {},
      create: () => ({ setup: async () => (reply) => reply.send("Studio") }),
    });
    app.register(new StudioProvider({ enabled: true, devMode: false, basePath: "/dev" }, client, {
      extensions: [{
        id: "custom", title: "Custom", pages: [],
        defineHttpControllers({ basePath }) {
          return [defineHttpController({ route: get(`${basePath}/api/custom`), handler: () => ({ ok: true }) })];
        },
      }],
    }));

    for (const extension of app.httpExtensions.definitions) {
      await extension.mount({ app, server, defaultAccess });
    }
    await app.start();
    expect((await server.inject("/dev/api/custom")).json()).toEqual({ ok: true });
    expect(inherited).toHaveBeenCalledOnce();
    expect((await server.inject("/dev/api/manifest")).statusCode).toBe(200);
    expect(inherited).toHaveBeenCalledOnce();
    expect(recorded).toEqual([]);
  });

  it("does not register Studio when disabled", async () => {
    const app = new App({ name: "test" });
    const client = new TestStudioClientAdapter();

    app.register(
      new StudioProvider(
        {
          enabled: false,
          devMode: false,
          basePath: "/_studio",
        },
        defineStudioClientAdapter({ dependencies: {}, capabilities: {}, create: () => client }),
        {},
      ),
    );

    expect(app.container.hasRegistration("studio")).toBe(false);
    expect(app.httpExtensions.definitions).toEqual([]);
    expect(client.setup).not.toHaveBeenCalled();

    await app.dispose();
  });
});
