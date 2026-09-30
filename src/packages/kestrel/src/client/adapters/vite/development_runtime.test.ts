import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";

import { ViteDevelopmentRuntime } from "./development_runtime.js";

describe("ViteDevelopmentRuntime", () => {
  it("keeps Node watch stable until a real configuration dependency changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-vite-watch-"));
    const dependency = join(root, "settings.mjs");
    const configFile = join(root, "vite.config.mts");
    const entry = join(root, "entry.mjs");
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    let output = "";
    try {
      await writeFile(dependency, "export const value = 1;");
      await writeFile(configFile, 'import { value } from "./settings.mjs"; export default { define: { value } };');
      // Resolve the runtime's actual Vite configuration without opening any HTTP or HMR listener.
      await writeFile(entry, `
        import { ViteDevelopmentRuntime } from ${JSON.stringify(new URL("./development_runtime.ts", import.meta.url).href)};
        import { resolveConfig } from ${JSON.stringify(import.meta.resolve("vite"))};
        const runtime = new ViteDevelopmentRuntime(${JSON.stringify({ root, configFile })}, {
          createServer: async (config) => {
            const resolved = await resolveConfig(config, "serve");
            console.log("READY:" + resolved.define.value);
            return { middlewares() {}, async close() {} };
          },
        });
        await runtime.mount({ server: {}, async register() {}, use() {}, addHook() {} });
        setInterval(() => {}, 1000);
      `);
      child = spawn(process.execPath, ["--watch", "--watch-preserve-output", "--import", "tsx", entry], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      closed = new Promise((resolve) => child!.once("close", resolve));
      child.stdout!.on("data", (chunk) => { output += chunk; });
      child.stderr!.on("data", (chunk) => { output += chunk; });
      await vi.waitFor(() => expect(output).toContain("READY:1"), { timeout: 5_000 });
      await delay(800);
      expect(output.match(/READY:/gu), output).toHaveLength(1);
      expect(output).not.toContain("deprecated");

      // Native loading must retain watching of modules imported by the configuration.
      await writeFile(dependency, "export const value = 2;");
      await vi.waitFor(() => expect(output).toContain("READY:2"), { timeout: 5_000 });
      await delay(800);
      expect(output.match(/READY:/gu), output).toHaveLength(2);
    } finally {
      child?.kill("SIGINT");
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

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
      configLoader: "native",
      appType: "custom",
      server: expect.objectContaining({ middlewareMode: true, ws: { server: first.server.server } }),
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
