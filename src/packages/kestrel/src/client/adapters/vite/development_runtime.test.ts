import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";

import { ViteDevelopmentRuntime } from "./development_runtime.js";

describe("ViteDevelopmentRuntime", () => {
  it("resolves conventional and customized clients against its own root", () => {
    const runtime = new ViteDevelopmentRuntime({
      root: "/workspace",
      configFile: "/workspace/vite.development.config.ts",
    });

    expect(runtime.entry({ root: "src/client" })).toEqual({
      runtime,
      entry: {
        htmlPath: "/workspace/src/client/index.html",
        templateModulePath: "/src/main.tsx",
        developmentModulePath: "/src/client/src/main.tsx",
      },
    });
    expect(runtime.entry({
      root: "tools/client",
      html: "shell.html",
      module: "browser/entry.tsx",
    })).toEqual({
      runtime,
      entry: {
        htmlPath: "/workspace/tools/client/shell.html",
        templateModulePath: "/browser/entry.tsx",
        developmentModulePath: "/tools/client/browser/entry.tsx",
      },
    });
    expect(() => runtime.entry({ root: "../outside" })).toThrowError(
      "client root must be a relative path",
    );
    expect(() => runtime.entry({
      root: "src/client",
      html: "templates/../../../outside.html",
    })).toThrowError("client HTML must be a relative path");
  });

  it("shares one Vite server, transforms client entries and closes once", async () => {
    const close = vi.fn(async () => {});
    const transformIndexHtml = vi.fn(
      async (_url: string, source: string) => `transformed:${source}`,
    );
    const createServer = vi.fn(async () => ({
      close,
      middlewares: vi.fn(),
      transformIndexHtml,
    }) as unknown as ViteDevServer);
    const readHtml = vi.fn(async () =>
      '<script type="module" src="/src/main.tsx"></script>'
    );
    const first = createFastifyScope();
    const second = createFastifyScope();
    const runtime = new ViteDevelopmentRuntime(
      {
        root: "/workspace",
        configFile: "/workspace/vite.development.config.ts",
      },
      {
        createServer,
        readHtml: readHtml as never,
      },
    );

    await runtime.mount(first.server);
    await runtime.mount(second.server);
    const document = await runtime.transformHtml("/admin", {
      htmlPath: "/workspace/secondary/index.html",
      templateModulePath: "/src/main.tsx",
      developmentModulePath: "/src/kestrel/secondary/client/src/main.tsx",
    });

    expect(createServer).toHaveBeenCalledOnce();
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      root: "/workspace",
      configFile: "/workspace/vite.development.config.ts",
      appType: "custom",
      server: expect.objectContaining({ middlewareMode: true }),
    }));
    expect(first.use).toHaveBeenCalledOnce();
    expect(second.use).toHaveBeenCalledOnce();
    expect(document).toContain(
      'src="/src/kestrel/secondary/client/src/main.tsx"',
    );

    // Every Fastify scope owns a hook, while the shared runtime closes once.
    await first.runPreClose();
    await second.runPreClose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an HTML template that no longer contains its declared entry", async () => {
    const runtime = new ViteDevelopmentRuntime(
      {
        root: "/workspace",
        configFile: "/workspace/vite.development.config.ts",
      },
      {
        createServer: async () => ({
          close: vi.fn(),
          middlewares: vi.fn(),
          transformIndexHtml: vi.fn(),
        }) as unknown as ViteDevServer,
        readHtml: vi.fn(async () => "<main></main>") as never,
      },
    );
    const scope = createFastifyScope();

    await runtime.mount(scope.server);

    await expect(runtime.transformHtml("/", {
      htmlPath: "/workspace/client/index.html",
      templateModulePath: "/src/main.tsx",
      developmentModulePath: "/src/client/src/main.tsx",
    })).rejects.toThrowError(
      "does not reference /src/main.tsx",
    );
  });
});

function createFastifyScope(): {
  server: FastifyInstance;
  use: ReturnType<typeof vi.fn>;
  runPreClose: () => Promise<void>;
} {
  const hooks: Array<() => Promise<void>> = [];
  const use = vi.fn();
  const server = {
    server: {},
    register: vi.fn(async () => {}),
    use,
    addHook: vi.fn((name: string, hook: () => Promise<void>) => {
      if (name === "preClose") {
        hooks.push(hook);
      }
    }),
  } as unknown as FastifyInstance;

  return {
    server,
    use,
    runPreClose: async () => {
      await Promise.all(hooks.map(async (hook) => hook()));
    },
  };
}
