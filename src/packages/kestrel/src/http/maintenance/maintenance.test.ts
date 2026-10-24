import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../../actions/index.js";
import { App } from "../../app/index.js";
import { AuthorizationDeniedError } from "../../authorization/errors.js";
import { configure, createConfigurationApi } from "../../configuration/index.js";
import {
  createHttpHardeningProfile,
  defineActionHttpController,
  defineHttpAccessPolicy,
  defineHttpController,
  defineHttpMiddleware,
  get,
  httpConfigBase,
  httpHardeningConfigBase,
  httpMaintenanceConfigSchema,
  httpRuntimeDependency,
  HttpRuntimeProvider,
  post,
  type HttpRuntimeOptions,
} from "../index.js";

const apps = new Set<App<Record<string, never>>>();

afterEach(async () => {
  // App disposal owns both the runtime drain and all execution resources.
  await Promise.all([...apps].map((app) => app.dispose()));
  apps.clear();
});

function createRuntime(
  maintenance?: z.input<typeof httpMaintenanceConfigSchema>,
  options: HttpRuntimeOptions = {},
) {
  const app = new App({});
  apps.add(app);
  app.container.registerValue("applicationLogger", pino({ enabled: false }));
  const handler = vi.fn(() => "business");
  const actionHandler = vi.fn(() => "action");
  const middleware = vi.fn(async () => { throw new AuthorizationDeniedError(); });
  const extensionHook = vi.fn(async () => {});
  const action = defineAction({
    name: "test.maintenance",
    input: z.object({ value: z.string() }),
    output: z.string(),
    handler: actionHandler,
  });
  app.catalog.contribute({
    test: {
      controllers: {
        http: {
          business: defineHttpController({ route: get("/business"), handler }),
          action: defineActionHttpController(action, post("/action")),
          protected: defineHttpController({
            route: get("/protected"),
            access: defineHttpAccessPolicy("test.denied", [
              defineHttpMiddleware("test.deny", { handler: middleware }),
            ]),
            handler,
          }),
        },
      },
    },
  }, { kind: "application" });
  app.httpExtensions.register({
    mount({ server }) {
      // Nested extension hooks must never execute for rejected requests.
      server.register(async (nested) => {
        nested.addHook("onRequest", extensionHook);
        nested.get("/extension", handler);
      });
    },
  });
  const config = httpConfigBase.schema.parse({
    fastifyLogs: false,
    maintenance,
    clientGeneration: {
      audiences: { audiences: ["public"], defaultAudiences: ["public"] },
      generators: [{
        name: "public",
        audiences: ["public"],
        factoryName: "createClient",
        outputFile: "/unused/client.ts",
        catalogImportPath: "./catalog.js",
        runtimeImportPath: "@kestreljs/framework/http/client",
      }],
    },
  });
  app.register(new HttpRuntimeProvider(config, options));
  const runtime = app.container.resolve(httpRuntimeDependency);
  const createExecutionScope = vi.spyOn(app, "createExecutionScope");

  return { runtime, config, handler, actionHandler, middleware, extensionHook, createExecutionScope };
}

describe("HTTP maintenance admission", () => {
  it.each([undefined, { enabled: false, html: "<h1>Unused</h1>" }])(
    "preserves normal routing when disabled (%s)",
    async (maintenance) => {
      const { runtime, handler, extensionHook } = createRuntime(maintenance);
      const response = await runtime.server.inject("/business");

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("business");
      expect(response.headers["retry-after"]).toBeUndefined();
      expect((await runtime.server.inject("/extension")).statusCode).toBe(200);
      expect((await runtime.server.inject("/missing")).statusCode).toBe(404);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(extensionHook).toHaveBeenCalledOnce();
    },
  );

  it("serves an autonomous HTML page directly with temporary failure headers", async () => {
    const { runtime, handler, createExecutionScope } = createRuntime({
      enabled: true,
      retryAfterSeconds: 120,
    });
    const response = await runtime.server.inject({
      url: "/business?returnTo=%3Cscript%3E",
      headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toBe("Accept");
    expect(response.headers["retry-after"]).toBe("120");
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain("<!doctype html>");
    expect(response.body).toContain("We'll be back soon");
    expect(response.body).not.toMatch(/<script|<link|<img|returnTo/u);
    expect(handler).not.toHaveBeenCalled();
    expect(createExecutionScope).not.toHaveBeenCalled();
  });

  it("serves trusted custom HTML verbatim without applying it to JSON responses", async () => {
    const html = "<!doctype html><html lang=\"en\"><title>Offline</title><h1>Upgrading</h1></html>";
    const { runtime } = createRuntime({ enabled: true, html });
    const page = await runtime.server.inject({ url: "/business", headers: { accept: "text/html" } });
    const api = await runtime.server.inject("/api/items");

    expect(page.statusCode).toBe(503);
    expect(page.body).toBe(html);
    expect(page.headers["retry-after"]).toBeUndefined();
    expect(api.statusCode).toBe(503);
    expect(api.json()).toEqual({
      statusCode: 503,
      error: "Service Unavailable",
      message: "The site is temporarily unavailable for maintenance. Please try again later.",
    });
  });

  it.each([
    { accept: undefined, html: false },
    { accept: "*/*", html: false },
    { accept: "application/json", html: false },
    { accept: "text/*", html: false },
    { accept: "text/html", html: true },
    { accept: "TEXT/HTML;Q=1", html: true },
    { accept: "text/html,*/*", html: true },
    { accept: "text/html;q=0,*/*;q=1", html: false },
    { accept: "text/html;q=0.5,application/json", html: false },
    { accept: "text/html,application/json", html: false },
    { accept: "text/html,application/json;q=0.5", html: true },
    { accept: "text/html;q=0.5,application/json;q=0,*/*;q=1", html: true },
    { accept: "text/html;q=0.5,application/*;q=0.8", html: false },
    { accept: "text/html;q=invalid", html: false },
    { accept: "text/html;q=2", html: false },
  ])("selects html=$html for Accept=$accept", async ({ accept, html }) => {
    const { runtime } = createRuntime({ enabled: true });
    const response = await runtime.server.inject({
      url: "/business",
      headers: accept === undefined ? {} : { accept },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain(html ? "text/html" : "application/json");
  });

  it.each(["/api", "/api/items?search=test", "/rpc", "/rpc/items"])(
    "forces JSON on the configured API path %s even when HTML is requested",
    async (url) => {
      const { runtime } = createRuntime({ enabled: true, apiPathPrefixes: ["/api", "/rpc/"] });
      const response = await runtime.server.inject({ url, headers: { accept: "text/html" } });

      expect(response.statusCode).toBe(503);
      expect(response.headers["content-type"]).toContain("application/json");
    },
  );

  it("matches API prefixes on segment boundaries and allows configuring the root", async () => {
    const { runtime } = createRuntime({ enabled: true });
    const { runtime: apiOnly } = createRuntime({ enabled: true, apiPathPrefixes: ["/"] });

    expect((await runtime.server.inject({ url: "/apiary", headers: { accept: "text/html" } }))
      .headers["content-type"]).toContain("text/html");
    expect((await apiOnly.server.inject({ url: "/business", headers: { accept: "text/html" } }))
      .headers["content-type"]).toContain("application/json");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
    "returns JSON before parsing a malformed %s body",
    async (method) => {
      const { runtime, actionHandler, createExecutionScope } = createRuntime({ enabled: true });
      const response = await runtime.server.inject({
        method,
        url: "/action",
        headers: { accept: "text/html", "content-type": "application/json" },
        payload: "{invalid-json",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("Service Unavailable");
      expect(actionHandler).not.toHaveBeenCalled();
      expect(createExecutionScope).not.toHaveBeenCalled();
    },
  );

  it.each(["/business", "/extension", "/missing", "/protected"])(
    "blocks the entire HTTP surface before request execution (%s)",
    async (url) => {
      const { runtime, handler, middleware, extensionHook, createExecutionScope } = createRuntime({ enabled: true });

      expect((await runtime.server.inject(url)).statusCode).toBe(503);
      expect(handler).not.toHaveBeenCalled();
      expect(middleware).not.toHaveBeenCalled();
      expect(extensionHook).not.toHaveBeenCalled();
      expect(createExecutionScope).not.toHaveBeenCalled();
    },
  );

  it.each(["/business", "/missing", "/api/items"])("keeps HEAD bodyless on %s", async (url) => {
    const { runtime } = createRuntime({ enabled: true, retryAfterSeconds: 0 });
    const response = await runtime.server.inject({ method: "HEAD", url, headers: { accept: "text/html" } });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("");
    expect(response.headers["retry-after"]).toBe("0");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("allows exact path exceptions with optional method restrictions and query strings", async () => {
    const { runtime, handler, extensionHook } = createRuntime({
      enabled: true,
      exceptions: [
        { path: "/business", methods: ["GET"] },
        { path: "/extension" },
        { path: "/missing", methods: ["GET"] },
      ],
    });
    const allowed = await runtime.server.inject("/business?probe=1");

    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["retry-after"]).toBeUndefined();
    expect(allowed.headers["cache-control"]).toBeUndefined();
    expect((await runtime.server.inject("/extension")).statusCode).toBe(200);
    expect((await runtime.server.inject("/missing")).statusCode).toBe(404);
    expect((await runtime.server.inject({ method: "HEAD", url: "/business" })).statusCode).toBe(503);
    expect((await runtime.server.inject({ method: "POST", url: "/business" })).statusCode).toBe(503);
    for (const url of ["/business/", "/business/child", "/Business", "/%62usiness"]) {
      expect((await runtime.server.inject(url)).statusCode).toBe(503);
    }
    expect(handler).toHaveBeenCalledTimes(2);
    expect(extensionHook).toHaveBeenCalledOnce();
  });

  it("retains access policies on excepted routes", async () => {
    const { runtime, handler, middleware } = createRuntime({
      enabled: true,
      exceptions: [{ path: "/protected" }],
    });

    expect((await runtime.server.inject("/protected")).statusCode).toBe(403);
    expect(middleware).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it("snapshots admission at construction rather than reading mutated config", async () => {
    const { runtime, config } = createRuntime({
      enabled: true,
      exceptions: [{ path: "/business", methods: ["GET"] }],
    });
    config.maintenance.enabled = false;
    config.maintenance.exceptions[0]?.methods?.push("POST");
    config.maintenance.exceptions.push({ path: "/extension" });

    expect((await runtime.server.inject("/business")).statusCode).toBe(200);
    expect((await runtime.server.inject({ method: "POST", url: "/business" })).statusCode).toBe(503);
    expect((await runtime.server.inject("/extension")).statusCode).toBe(503);
  });

  it("preserves hardening headers and host admission during maintenance", async () => {
    const profile = createHttpHardeningProfile(httpHardeningConfigBase.schema.parse({
      enabled: true,
      publicOrigins: ["https://app.example"],
      proxy: { mode: "direct" },
    }));
    const { runtime } = createRuntime({ enabled: true }, { profile });
    const response = await runtime.server.inject({
      url: "/business",
      headers: { host: "app.example", accept: "text/html" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect((await runtime.server.inject({ url: "/business", headers: { host: "attacker.example" } }))
      .statusCode).toBe(421);
  });
});

describe("HTTP maintenance configuration", () => {
  it.each([
    { retryAfterSeconds: -1 },
    { retryAfterSeconds: 1.5 },
    { html: " " },
    { enabled: "true" },
    { exceptions: [{ path: "https://app.example/health" }] },
    { exceptions: [{ path: "/health?probe=1" }] },
    { exceptions: [{ path: "/health/*" }] },
    { exceptions: [{ path: "/health", methods: [] }] },
    { exceptions: [{ path: "/health", methods: ["get"] }] },
    { apiPathPrefixes: ["//api"] },
  ])("rejects malformed settings %s", (settings) => {
    expect(httpMaintenanceConfigSchema.safeParse(settings).success).toBe(false);
  });

  it("supports schema-derived environment overrides while defaulting to disabled", () => {
    const { defineConfig, resolveConfig } = createConfigurationApi({
      environments: ["test"],
      defaultEnvironment: "test",
      environmentOverrides: { prefix: "APP_CONFIG" },
    });
    // Reuse the real base to verify omitted defaults and nested override discovery.
    const { config } = createRuntime();
    const { maintenance: _maintenance, ...base } = config;
    const definition = defineConfig({ http: configure(httpConfigBase, base) });

    expect(resolveConfig(definition, { env: {} }).http.maintenance).toEqual({
      enabled: false, apiPathPrefixes: ["/api"], exceptions: [],
    });
    expect(resolveConfig(definition, {
      env: {
        APP_CONFIG__HTTP__MAINTENANCE__ENABLED: "true",
        APP_CONFIG__HTTP__MAINTENANCE__RETRY_AFTER_SECONDS: "60",
      },
    }).http.maintenance).toEqual({
      enabled: true, retryAfterSeconds: 60, apiPathPrefixes: ["/api"], exceptions: [],
    });
  });
});
