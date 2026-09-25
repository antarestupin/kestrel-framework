import type { FastifyInstance } from "fastify";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ViteDevelopmentRuntime } from "../../../client/index.js";
import { ViteStudioClientAdapter } from "./adapter.js";
import { Studio } from "../../studio.js";

describe("ViteStudioClientAdapter", () => {
  it("closes the Vite development server before Fastify drains connections", async () => {
    const close = vi.fn(async () => {});
    const addHook = vi.fn();
    const server = {
      addHook,
      register: vi.fn(),
      vite: {
        devServer: { close },
        ready: vi.fn(async () => {}),
      },
    } as unknown as FastifyInstance;
    const adapter = new ViteStudioClientAdapter({ dev: true });

    await adapter.setup(server, new Studio());

    expect(addHook).toHaveBeenCalledWith(
      "preClose",
      expect.any(Function),
    );

    // Execute the registered lifecycle hook without opening an HTTP port.
    const preCloseHook = addHook.mock.calls[0]?.[1] as
      | (() => Promise<void>)
      | undefined;

    expect(preCloseHook).toBeDefined();
    await preCloseHook?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not register development cleanup for production assets", async () => {
    const addHook = vi.fn();
    const server = {
      addHook,
      register: vi.fn(),
      vite: {
        ready: vi.fn(async () => {}),
      },
    } as unknown as FastifyInstance;
    const adapter = new ViteStudioClientAdapter({ dev: false });

    await adapter.setup(server, new Studio());

    expect(addHook).not.toHaveBeenCalled();
  });

  it("injects an optional runtime-to-editor source path mapping", async () => {
    const register = vi.fn();
    const server = {
      addHook: vi.fn(),
      register,
      vite: {
        ready: vi.fn(async () => {}),
      },
    } as unknown as FastifyInstance;
    const adapter = new ViteStudioClientAdapter({
      dev: false,
      sourcePathMapping: {
        runtimeRoot: "/workspace/agora",
        editorRoot: "/Users/developer/Projects/agora",
      },
    });

    await adapter.setup(server, new Studio({ basePath: "/studio" }));

    const viteOptions = register.mock.calls[0]?.[1] as {
      createHtmlFunction(source: string): () => unknown;
    };
    const render = viteOptions.createHtmlFunction(
      '<div id="root" data-studio-config="__STUDIO_CLIENT_CONFIG__"></div>',
    );
    const reply = {
      type: vi.fn().mockReturnThis(),
      send: vi.fn((document: string) => document),
    };
    const document = render.call(reply) as string;

    const encodedConfig = document.match(/data-studio-config="([^"]+)"/u)?.[1];

    expect(encodedConfig).toBeDefined();
    expect(JSON.parse(decodeURIComponent(encodedConfig ?? ""))).toEqual({
      basePath: "/studio",
      sourcePathMapping: {
        runtimeRoot: "/workspace/agora",
        editorRoot: "/Users/developer/Projects/agora",
      },
    });
    expect(document).not.toContain("<script>window.");
  });

  it("injects configuration into shared development HTML", async () => {
    const runtime = {
      mount: vi.fn(async () => {}),
      transformHtml: vi.fn(async () =>
        '<div data-studio-config="__STUDIO_CLIENT_CONFIG__"></div>'
      ),
    } as unknown as ViteDevelopmentRuntime;
    const server = { register: vi.fn() } as unknown as FastifyInstance;
    const adapter = new ViteStudioClientAdapter({
      dev: true,
      development: {
        runtime,
        entry: {
          htmlPath: "/workspace/studio/index.html",
          templateModulePath: "/src/main.tsx",
          developmentModulePath: "/src/kestrel/studio/client/src/main.tsx",
        },
      },
    });

    const render = await adapter.setup(
      server,
      new Studio({ basePath: "/studio" }),
    );
    const reply = {
      request: { url: "/studio" },
      type: vi.fn().mockReturnThis(),
      send: vi.fn((document: string) => document),
    };
    const document = await render(reply as never) as string;
    const encodedConfig = document.match(
      /data-studio-config="([^"]+)"/u,
    )?.[1];

    expect(JSON.parse(decodeURIComponent(encodedConfig ?? ""))).toEqual({
      basePath: "/studio",
    });
    expect(server.register).not.toHaveBeenCalled();
  });
});
