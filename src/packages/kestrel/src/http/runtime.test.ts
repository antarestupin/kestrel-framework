import { createServer } from "node:http";
import pino, { type Logger } from "pino";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App, ApplicationShutdown, type RuntimeApp } from "../app/index.js";
import type { HttpConfig } from "./configuration.js";
import { httpRuntimeDependency } from "./dependencies.js";
import type { HttpHardeningProfile } from "./hardening/index.js";
import { HttpRuntimeProvider } from "./provider.js";
import { HttpRuntime, type HttpRuntimeServerOptions } from "./runtime.js";

const shutdowns = new Set<ApplicationShutdown>();
const runtimes = new Set<HttpRuntime<Record<string, never>>>();

afterEach(async () => {
  await Promise.all([...runtimes].map((runtime) => runtime.stop()));
  runtimes.clear();
  for (const shutdown of shutdowns) shutdown.finish();
  shutdowns.clear();
});

describe("HttpRuntime", () => {
  it("uses the application logger as the parent when Fastify logging is enabled", async () => {
    const app = new App({});
    const logger = pino({ level: "silent" });
    app.container.registerValue("applicationLogger", logger);
    const runtime = new HttpRuntime(app, { ...config, fastifyLogs: true });
    try {
      runtime.server.get("/bindings", (request) => (request.log as Logger).bindings());
      const response = await runtime.server.inject("/bindings");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ workload: "http" });
    } finally {
      await app.dispose();
    }
  });

  it("bounds a non-cooperative HTTP handler and keeps its shared dependencies alive", async () => {
    const app = new App({}, { shutdown: { timeoutMs: 40, drainMs: 10 } });
    const logger = { child: () => logger };
    app.container.registerValue("applicationLogger", logger);
    const close = vi.fn();
    app.container.registerValue("resource", {}, { dispose: close });
    const runtime = new HttpRuntime(app, config);
    const started = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    runtime.server.get("/blocked", async () => {
      const execution = await app.createExecutionScope();
      started.resolve();
      try { await blocked.promise; return "finished"; }
      finally { await execution.dispose(); }
    });
    const response = runtime.server.inject("/blocked").then((result) => result);
    try {
      await started.promise;
      await expect(app.dispose()).rejects.toThrow();
      expect(app.state).toBe("shutdownTimedOut");
      expect(close).not.toHaveBeenCalled();
    } finally {
      blocked.resolve();
      await response;
      await runtime.server.close().catch(() => undefined);
      await app.container.dispose();
    }
  });

  it.each([null, {}, { name: "", middleware: [] }])("rejects malformed default access before constructing the server (%s)", (defaultAccess) => {
    expect(() => new HttpRuntime(createRuntimeApp(), config, {
      defaultAccess: defaultAccess as never,
    })).toThrow("An HTTP controller requires a valid access policy.");
  });

  it("lets the selected hardening profile override generic server options", async () => {
    const install = vi.fn();
    const profile: HttpHardeningProfile = {
      server: { bodyLimit: 64 },
      install,
    };
    const runtime = new HttpRuntime(createRuntimeApp(), config, {
      profile,
      server: { bodyLimit: 128 },
    });

    runtimes.add(runtime);
    await runtime.server.ready();
    expect(runtime.server.initialConfig.bodyLimit).toBe(64);
    expect(install).toHaveBeenCalledOnce();
    expect(install.mock.calls[0]?.[0]).toBe(runtime.server);
  });

  it("rejects custom server factories with the hardening profile", () => {
    const profile: HttpHardeningProfile = {
      server: {},
      install: vi.fn(),
    };

    expect(() => new HttpRuntime(createRuntimeApp(), config, {
      profile,
      server: {
        serverFactory: () => {
          throw new Error("The incompatible factory must not run.");
        },
      },
    })).toThrow("does not support a custom server factory");
  });

  it("allows a custom server factory without hardening and starts without a callback", async () => {
    // Creating a server and injecting a request does not open a listener.
    const factory = vi.fn<NonNullable<HttpRuntimeServerOptions["serverFactory"]>>((handler) => createServer(handler));
    const runtime = new HttpRuntime(createRuntimeApp(), config, { server: { serverFactory: factory } });
    runtimes.add(runtime);
    runtime.server.get("/", () => "ok");
    expect((await runtime.server.inject("/")).body).toBe("ok");
    expect(factory).toHaveBeenCalledOnce();
    expect((runtime.server.log as Logger).isLevelEnabled?.("info") ?? false).toBe(false);
    const address = "http://127.0.0.1:8123";
    vi.spyOn(runtime.server, "listen").mockImplementation(() => Promise.resolve(address) as never);
    await expect(runtime.start()).resolves.toBe(address);
  });

  it("listens on the configured endpoint and awaits the startup callback", async () => {
    const address = "http://127.0.0.1:8123";
    const finish = Promise.withResolvers<void>();
    const onListening = vi.fn(() => finish.promise);
    const runtime = new HttpRuntime(createRuntimeApp(), { ...config, port: 8123 }, { onListening });
    runtimes.add(runtime);
    // Stub the listen boundary so this test never opens a network socket.
    const listen = vi.spyOn(runtime.server, "listen").mockImplementation(() => Promise.resolve(address) as never);
    const settled = vi.fn();
    const start = runtime.start();
    void start.then(settled, settled);
    try {
      await Promise.resolve();
      expect(listen).toHaveBeenCalledExactlyOnceWith({ host: "127.0.0.1", port: 8123 });
      expect(onListening).toHaveBeenCalledExactlyOnceWith(address);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
    }
    await expect(start).resolves.toBe(address);
  });

  it("closes the runtime when listening fails and shares the stop promise", async () => {
    const app = createRuntimeApp();
    const runtime = new HttpRuntime(app, config);
    runtimes.add(runtime);
    await runtime.server.ready();
    const failure = new Error("listen failed");
    vi.spyOn(runtime.server, "listen").mockImplementation(() => Promise.reject(failure) as never);
    const close = vi.spyOn(runtime.server, "close");
    const wait = vi.spyOn(app.shutdown, "wait");

    await expect(runtime.run()).rejects.toBe(failure);
    // Even failed startup must close Fastify within the application's shared shutdown budget.
    expect(wait).toHaveBeenCalledExactlyOnceWith("HTTP drain", expect.any(Function));
    expect(close).toHaveBeenCalledOnce();
    expect(app.stop).toHaveBeenCalledOnce();
    const stop = runtime.stop();
    expect(stop).toBeInstanceOf(Promise);
    expect(runtime.stop()).toBe(stop);
    await stop;
    expect(close).toHaveBeenCalledOnce();
  });

  it("registers a shared HTTP runtime, the server CLI command and the application drain", async () => {
    const app = new App({});
    app.container.registerValue("applicationLogger", pino({ level: "silent" }));
    try {
      app.register(new HttpRuntimeProvider(config));
      const runtime = app.container.resolve(httpRuntimeDependency);
      expect(app.container.resolve(httpRuntimeDependency)).toBe(runtime);
      const { definition, path, source } = app.catalog.cliControllers.registrations[0]!;
      expect(path).toEqual(["http", "runServer"]);
      expect(source).toMatchObject({ kind: "provider", provider: "HttpRuntimeProvider" });
      expect(definition).toMatchObject({
        command: "run server", description: "Run the HTTP server.", runtime: "server", runningMode: "standard",
        dependencies: { runtime: httpRuntimeDependency }, workloads: ["http"], observe: false,
      });
      if (definition.source !== "standalone") throw new Error("Expected the HTTP server command.");
      const run = vi.spyOn(runtime, "run").mockResolvedValue(undefined);
      await definition.handler({ deps: { runtime } } as never);
      expect(run).toHaveBeenCalledOnce();
      const close = vi.spyOn(runtime.server, "close");
      await app.dispose();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await app.dispose();
    }
  });
});

const config = {
  host: "127.0.0.1",
  port: 0,
  fastifyLogs: false,
  executionIdHeader: "x-execution-id",
} as HttpConfig;

function createRuntimeApp(): RuntimeApp<Record<string, never>> {
  // The runtime only needs the logger's child-binding surface in this fixture.
  const logger = { child: () => logger } as unknown as Logger;

  const shutdown = new ApplicationShutdown();
  shutdowns.add(shutdown);
  return {
    shutdown,
    catalog: {
      httpControllers: { definitions: [] },
    },
    container: {
      resolve: () => logger,
    },
    createExecutionScope: vi.fn(),
    httpExtensions: { definitions: [] },
    runInObservationContext: vi.fn(),
    start: vi.fn(async () => {}),
    state: "composing",
    stop: vi.fn(async () => {}),
  } as unknown as RuntimeApp<Record<string, never>>;
}
