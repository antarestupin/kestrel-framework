import type { FastifyInstance } from "fastify";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ViteClientAdapter } from "./adapter.js";
import type { ViteDevelopmentRuntime } from "./development_runtime.js";

const client = {
  basePath: "/",
  assetBasePath: "/_client_assets/",
};

describe("ViteClientAdapter", () => {
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

  it("renders through an injected shared development runtime", async () => {
    const mount = vi.fn(async () => {});
    const transformHtml = vi.fn(async () => "<html>shared</html>");
    const runtime = {
      mount,
      transformHtml,
    } as unknown as ViteDevelopmentRuntime;
    const server = {
      register: vi.fn(),
    } as unknown as FastifyInstance;
    const adapter = new ViteClientAdapter({
      devMode: true,
      projectRoot: "/workspace/client",
      distDir: "dist/client",
      development: {
        runtime,
        entry: {
          htmlPath: "/workspace/client/index.html",
          templateModulePath: "/src/main.tsx",
          developmentModulePath: "/src/client/src/main.tsx",
        },
      },
    });

    const render = await adapter.setup(server, client);
    const reply = {
      type: vi.fn().mockReturnThis(),
      send: vi.fn((document: string) => document),
    };
    const document = await render({
      request: { url: "/debates" },
      reply,
    } as never);

    expect(mount).toHaveBeenCalledWith(server);
    expect(transformHtml).toHaveBeenCalledWith(
      "/debates",
      expect.objectContaining({
        developmentModulePath: "/src/client/src/main.tsx",
      }),
    );
    expect(document).toBe("<html>shared</html>");
    expect(server.register).not.toHaveBeenCalled();
  });
});
