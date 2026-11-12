import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App } from "../../../app/index.js";
import { dep } from "../../../di/index.js";
import { ClientProvider } from "../../provider.js";
import { ViteClientAdapter } from "./adapter.js";
import { viteClient } from "./definition.js";
import type {
  ViteClientDevelopmentOptions,
  ViteDevelopmentRuntime,
} from "./development_runtime.js";

const client = {
  basePath: "/",
  assetBasePath: "/_client_assets/",
};

describe("ViteClientAdapter", () => {
  it.each([true, false])("separates source and compiled paths for devMode=%s", async (devMode) => {
    const register = vi.fn();
    const server = { register, addHook: vi.fn(), vite: { ready: vi.fn() } } as unknown as FastifyInstance;
    await new ViteClientAdapter({ projectRoot: "/workspace", sourceRoot: "src/client", distDir: "dist/client", devMode }).setup(server, client);
    expect(register).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      root: devMode ? "/workspace/src/client" : "/workspace",
      distDir: "/workspace/dist/client/index.html",
      dev: devMode,
    }));
  });

  it("serves a compiled client without its source directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-compiled-client-"));
    const output = join(root, "output");
    const server = Fastify();
    const app = new App({});
    try {
      await mkdir(output);
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "compiled-client", type: "module" }));
      await writeFile(join(output, "vite.config.json"), JSON.stringify({
        root: join(root, "missing-source"), base: "/_client_assets/",
        build: { assetsDir: "assets", outDir: output },
        fastify: { outDirs: { client: output }, entryPaths: {} },
      }));
      await writeFile(join(output, "index.html"), '<html><body>Compiled client</body></html>');
      await writeFile(join(output, "symbol.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      app.register(new ClientProvider(viteClient({
        projectRoot: root, sourceRoot: "missing-source", distDir: output, devMode: false,
      })));
      for (const extension of app.httpExtensions.definitions) {
        await extension.mount({ app, server });
      }
      expect((await server.inject("/")).body).toContain("Compiled client");
      const asset = await server.inject("/_client_assets/symbol.svg");
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("image/svg+xml");
    } finally {
      await server.close();
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("configures Vite and closes its development server", async () => {
    const close = vi.fn(async () => {});
    const addHook = vi.fn();
    const register = vi.fn();
    const server = {
      addHook,
      register,
      vite: {
        devServer: { close },
        ready: vi.fn(async () => {}),
      },
    } as unknown as FastifyInstance;
    const adapter = new ViteClientAdapter({
      devMode: true,
      projectRoot: "/workspace/client",
      distDir: "dist/client",
    });

    await adapter.setup(server, client);

    expect(register).toHaveBeenCalledWith(expect.any(Function), {
      root: "/workspace/client",
      dev: true,
      spa: true,
      distDir: "dist/client",
    });
    expect(addHook).toHaveBeenCalledWith("preClose", expect.any(Function));

    // Execute the lifecycle hook without starting an HTTP listener.
    const preCloseHook = addHook.mock.calls[0]?.[1] as
      | (() => Promise<void>)
      | undefined;

    await preCloseHook?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not install HMR cleanup in production mode", async () => {
    const addHook = vi.fn();
    const server = {
      addHook,
      register: vi.fn(),
      vite: { ready: vi.fn(async () => {}) },
    } as unknown as FastifyInstance;
    const adapter = new ViteClientAdapter({
      devMode: false,
      projectRoot: "/workspace/client",
      distDir: "dist/client",
    });

    await adapter.setup(server, client);

    expect(addHook).not.toHaveBeenCalled();
  });

  it.each(["direct entry", "dependency descriptor"])("renders with a shared runtime supplied as a %s", async (source) => {
    const app = new App({});
    const server = Fastify();
    const mount = vi.fn<ViteDevelopmentRuntime["mount"]>(async () => {});
    const transformHtml = vi.fn<ViteDevelopmentRuntime["transformHtml"]>(async () => "<html>shared</html>");
    const development: ViteClientDevelopmentOptions = {
      runtime: { mount, transformHtml } as unknown as ViteDevelopmentRuntime,
      entry: {
        htmlPath: "/workspace/client/index.html",
        templateModulePath: "/src/main.tsx",
        developmentModulePath: "/src/client/src/main.tsx",
      },
    };
    const dependency = dep<ViteClientDevelopmentOptions>("sharedDevelopment");
    const resolveEntry = vi.fn(() => development);
    app.container.registerFactory(dependency.id, resolveEntry, { lifetime: "singleton" });
    app.register(new ClientProvider(viteClient(source === "direct entry" ? development : dependency, {
      devMode: true,
      projectRoot: "/workspace/client",
      distDir: "dist/client",
    }), { basePath: "/app", assetBasePath: "/app/assets/" }));

    try {
      // Composition must leave the development dependency lazy until HTTP mounting.
      expect(resolveEntry).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled();
      for (const extension of app.httpExtensions.definitions) {
        await extension.mount({ app, server });
      }
      const response = await server.inject("/app/debates?sort=new");

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toBe("<html>shared</html>");
      expect(mount).toHaveBeenCalledExactlyOnceWith(expect.anything(), "/app/assets/");
      expect(transformHtml).toHaveBeenCalledExactlyOnceWith("/app/debates?sort=new", development.entry);
      expect(resolveEntry).toHaveBeenCalledTimes(source === "direct entry" ? 0 : 1);
    } finally {
      await server.close();
      await app.dispose();
    }
  });
});
