import Fastify, {
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App } from "../app/index.js";
import { setExecutionLogEnabledDependency } from "../log/index.js";
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
    async (
      server: FastifyInstance,
      _studio: Studio,
    ): Promise<StudioClientRender> => {
      // This hook models Vite's encapsulated development middleware.
      server.addHook("onRequest", async (request, reply) => {
        reply.header("x-studio-scope", "active");

        if (request.url.startsWith(STUDIO_ASSET_BASE_PATH)) {
          return reply
            .type("application/javascript")
            .send("export const studioAsset = true;");
        }
      });

      return (reply: FastifyReply) => reply
        .type("text/html")
        .send("<main>Studio test client</main>");
    },
  );
}

describe("StudioProvider", () => {
  it("mounts its client and configured extensions when enabled", async () => {
    const server = Fastify();
    const app = new App({ name: "test" });
    const client = new TestStudioClientAdapter();
    const setExecutionLogEnabled = vi.fn();

    app.container.registerFactory(
      setExecutionLogEnabledDependency.id,
      () => setExecutionLogEnabled,
      { lifetime: "scoped" },
    );

    app.register(new StudioProvider({
      enabled: true,
      devMode: false,
      basePath: "/tools",
    }, {
      extensions: [
        defineActionsDocumentationExtension([{
          name: "example.run",
          description: "Run the example.",
          middleware: [],
        }]),
      ],
      client,
    }));

    for (const extension of app.httpExtensions.definitions) {
      await extension.mount({ app, server });
    }
    await app.start();

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
    expect(manifestResponse.headers["x-studio-scope"]).toBe("active");
    expect(manifestResponse.json()).toMatchObject({ basePath: "/tools" });
    expect(actionsResponse.json()).toEqual({
      actions: [{
        name: "example.run",
        description: "Run the example.",
        middleware: [],
      }],
    });
    expect(client.setup).toHaveBeenCalledOnce();
    expect(missingApiResponse.statusCode).toBe(404);
    expect(missingApiResponse.json()).toEqual({
      error: "Studio API route not found.",
    });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.body).toContain("studioAsset");
    expect(setExecutionLogEnabled).toHaveBeenCalled();
    expect(setExecutionLogEnabled.mock.calls.every(
      ([enabled]) => enabled === false,
    )).toBe(true);

    await server.close();
    await app.dispose();
  });

  it("does not register Studio when disabled", async () => {
    const app = new App({ name: "test" });
    const client = new TestStudioClientAdapter();

    app.register(new StudioProvider({
      enabled: false,
      devMode: false,
      basePath: "/_studio",
    }, { client }));

    expect(app.container.hasRegistration("studio")).toBe(false);
    expect(app.httpExtensions.definitions).toEqual([]);
    expect(client.setup).not.toHaveBeenCalled();

    await app.dispose();
  });
});
