import { pinoLogger } from "@kestreljs/framework/log";
import { expect, it, vi } from "vitest";
import { App } from "@kestreljs/framework/app";
import { HttpRuntimeProvider, httpRuntimeDependency } from "@kestreljs/framework/http";
import { LoggerProvider } from "@kestreljs/framework/log";
import { appCatalog } from "../app_catalog.js";
import { appConfig } from "../app_config.js";
import { StudioProvider } from "./studio_provider.js";

it("serves application explorers and packaged Studio assets while keeping the database lazy", async () => {
  const config = {
    ...appConfig,
    studio: {
      ...appConfig.studio,
      enabled: true,
      drizzleStudioUrl: "https://local.drizzle.studio?port=4984",
    },
  };
  const app = new App(config, { catalog: appCatalog });
  const query = vi.fn(async () => ({ rows: [] }));
  const database = vi.fn(() => ({ pool: { query } }));
  // Only the schema endpoint may resolve this application-owned service.
  app.container.registerFactory("databaseClient", database, { lifetime: "singleton" });
  app.register(new LoggerProvider(config.logger, pinoLogger()));
  app.register(new HttpRuntimeProvider(config.http));
  app.register(new StudioProvider(config.studio, config.core));
  const runtime = app.container.resolve(httpRuntimeDependency);

  try {
    const manifest = await runtime.server.inject("/_studio/api/manifest");
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "actions-documentation" }),
        expect.objectContaining({ id: "controllers" }),
        expect.objectContaining({
          id: "database",
          links: expect.arrayContaining([
            expect.objectContaining({ href: config.studio.drizzleStudioUrl }),
          ]),
        }),
      ]),
    );
    const document = await runtime.server.inject("/_studio");
    expect(document.statusCode).toBe(200);
    const entry = document.body.match(/src="([^"]+\.js)"/)?.[1];
    expect(entry).toBeDefined();
    expect((await runtime.server.inject(entry!)).statusCode).toBe(200);
    const actions = await runtime.server.inject(
      "/_studio/api/extensions/actions-documentation/actions",
    );
    expect(actions.statusCode).toBe(200);
    expect(actions.json().actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "example.greet" })]),
    );
    expect(database).not.toHaveBeenCalled();

    const layout = await runtime.server.inject("/_studio/api/extensions/database/schema");
    expect(layout.statusCode).toBe(200);
    expect(layout.json()).toEqual({ schemas: [] });
    expect(database).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    expect((await runtime.server.inject("/api/greet?name=Sam")).json()).toEqual({
      message: "Hello, Sam!",
    });
  } finally {
    try {
      await runtime.stop();
    } finally {
      await app.dispose();
    }
  }
});

it("does not expose Studio routes when disabled", async () => {
  const app = new App(appConfig);
  app.register(new LoggerProvider(appConfig.logger, pinoLogger()));
  app.register(new HttpRuntimeProvider(appConfig.http));
  app.register(new StudioProvider({ ...appConfig.studio, enabled: false }, appConfig.core));
  const runtime = app.container.resolve(httpRuntimeDependency);
  try {
    expect((await runtime.server.inject("/_studio/api/manifest")).statusCode).toBe(404);
    expect(app.container.hasRegistration("studio")).toBe(false);
  } finally {
    try {
      await runtime.stop();
    } finally {
      await app.dispose();
    }
  }
});
