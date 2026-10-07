import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createPaginationInputSchema, defineAction } from "../actions/index.js";
import { App } from "../app/index.js";
import { AuthorizationDeniedError } from "../authorization/errors.js";
import {
  anonymousHttpAccess,
  defineHttpAccessPolicy,
  type HttpAccessPolicy,
} from "./access.js";
import { defineActionHttpController, defineHttpController } from "./controller.js";
import { HttpControllerManager } from "./controller_manager.js";
import type { HttpConfig } from "./configuration.js";
import { httpRuntimeDependency } from "./dependencies.js";
import { defineHttpMiddleware } from "./middleware.js";
import { defineModelListActionHttpController } from "./model_list_controller.js";
import { HttpRuntimeProvider } from "./provider.js";
import { get } from "./route.js";

const servers = new Set<FastifyInstance>();
const apps = new Set<App<Record<string, never>>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  await Promise.all([...apps].map((app) => app.dispose()));
  servers.clear();
  apps.clear();
});

// A denial makes accidental middleware merging or bypass observable over HTTP.
const deniedAccess = defineHttpAccessPolicy("test.denied", [
  defineHttpMiddleware("test.deny", {
    handler: () => { throw new AuthorizationDeniedError(); },
  }),
]);

function createController(
  kind: string,
  handler: () => string,
  access?: HttpAccessPolicy,
) {
  const options = access === undefined ? {} : { access };

  if (kind === "standalone") {
    return defineHttpController({ route: get("/policy"), ...options, handler });
  }
  if (kind === "model list") {
    const action = defineAction({
      name: "test.list",
      input: z.object({ pagination: createPaginationInputSchema() }),
      output: z.string(),
      handler,
    });
    return defineModelListActionHttpController(action, "/policy", options);
  }
  const action = defineAction({
    name: "test.action",
    input: z.object({}),
    output: z.string(),
    handler,
  });
  return defineActionHttpController(action, get("/policy"), options);
}

function createApp() {
  const app = new App({});
  apps.add(app);
  return app;
}

function createServer() {
  const server = Fastify();
  servers.add(server);
  return server;
}

describe.each(["standalone", "action", "model list"])("%s default HTTP access", (kind) => {
  it.each([
    { defaultAccess: undefined, access: undefined, status: 200 },
    { defaultAccess: deniedAccess, access: undefined, status: 403 },
    { defaultAccess: deniedAccess, access: anonymousHttpAccess, status: 200 },
    { defaultAccess: anonymousHttpAccess, access: deniedAccess, status: 403 },
  ])("returns $status for default=$defaultAccess.name and override=$access.name", async ({ defaultAccess, access, status }) => {
    const app = createApp();
    const server = createServer();
    const handler = vi.fn(() => "allowed");
    const manager = new HttpControllerManager(
      app,
      server,
      defaultAccess === undefined ? {} : { defaultAccess },
    );
    manager.register(createController(kind, handler, access));
    await app.start();

    const response = await server.inject("/policy");
    expect(response.statusCode).toBe(status);
    expect(handler).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  it("resolves a shared definition independently for each registration", async () => {
    const app = createApp();
    const publicServer = createServer();
    const privateServer = createServer();
    const controller = createController(kind, () => "allowed");
    new HttpControllerManager(app, privateServer, {
      defaultAccess: deniedAccess,
    }).register(controller);
    new HttpControllerManager(app, publicServer).register(controller);
    await app.start();

    expect((await privateServer.inject("/policy")).statusCode).toBe(403);
    expect((await publicServer.inject("/policy")).statusCode).toBe(200);
    expect(controller.access).toBeUndefined();
  });
});

describe("HttpRuntimeProvider default access", () => {
  it.each([undefined, deniedAccess])("forwards the runtime default to catalog routes and extensions (%s)", async (defaultAccess) => {
    const app = createApp();
    // A silent logger avoids allocating a transport while exercising real composition.
    app.container.registerValue("applicationLogger", pino({ enabled: false }));
    app.catalog.contribute({
      test: {
        controllers: {
          http: { inherited: createController("action", () => "allowed") },
        },
      },
    }, { kind: "application" });
    const mounted = vi.fn();
    app.httpExtensions.register({
      mount: ({ server, defaultAccess: inherited }) => {
        mounted(inherited);
        new HttpControllerManager(
          app,
          server,
          inherited === undefined ? {} : { defaultAccess: inherited },
        ).register(defineHttpController({
          route: get("/extension"),
          handler: () => "extension",
        }));
      },
    });
    app.register(new HttpRuntimeProvider({
      host: "127.0.0.1",
      port: 0,
      fastifyLogs: false,
      executionIdHeader: "x-execution-id",
    } as HttpConfig, defaultAccess === undefined ? {} : { defaultAccess }));
    const runtime = app.container.resolve(httpRuntimeDependency);
    servers.add(runtime.server);

    const status = defaultAccess === undefined ? 200 : 403;
    expect((await runtime.server.inject("/policy")).statusCode).toBe(status);
    expect((await runtime.server.inject("/extension")).statusCode).toBe(status);
    expect(mounted).toHaveBeenCalledWith(defaultAccess ?? anonymousHttpAccess);
  });
});
