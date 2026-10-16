import type { Logger } from "pino";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App, ApplicationShutdown, type RuntimeApp } from "../app/index.js";
import type { HttpConfig } from "./configuration.js";
import type { HttpHardeningProfile } from "./hardening/index.js";
import { HttpRuntime } from "./runtime.js";

const shutdowns = new Set<ApplicationShutdown>();
const runtimes = new Set<HttpRuntime<Record<string, never>>>();

afterEach(async () => {
  await Promise.all([...runtimes].map((runtime) => runtime.stop()));
  runtimes.clear();
  for (const shutdown of shutdowns) shutdown.finish();
  shutdowns.clear();
});

describe("HttpRuntime", () => {
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
