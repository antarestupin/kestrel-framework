import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { ViteDevelopmentRuntime } from "../../../client/index.js";
import { Atlas } from "../../atlas.js";
import type { AtlasClientConfig } from "../../client_config.js";
import { ViteAtlasClientAdapter } from "./adapter.js";

describe("ViteAtlasClientAdapter", () => {
  it("embeds inert client configuration without an inline script", async () => {
    const register = vi.fn();
    const server = {
      addHook: vi.fn(),
      register,
      vite: { ready: vi.fn(async () => {}) },
    } as unknown as FastifyInstance;
    const config: AtlasClientConfig = {
      basePath: "/atlas",
      title: "Atlas",
      authentication: {
        loginPath: "/atlas/login",
        passwordSignInUrl: "/api/authentication/password/sign-in",
        signOutUrl: "/api/authentication/sign-out",
      },
    };
    const adapter = new ViteAtlasClientAdapter({ dev: false });

    await adapter.setup(
      server,
      new Atlas({ basePath: "/atlas", resources: [] }),
      config,
    );

    const viteOptions = register.mock.calls[0]?.[1] as {
      createHtmlFunction(source: string): () => unknown;
    };
    const render = viteOptions.createHtmlFunction(
      '<div id="root" data-atlas-config="__ATLAS_CLIENT_CONFIG__"></div>',
    );
    const reply = {
      type: vi.fn().mockReturnThis(),
      send: vi.fn((document: string) => document),
    };
    const document = render.call(reply) as string;
    const encodedConfig = document.match(
      /data-atlas-config="([^"]+)"/u,
    )?.[1];

    expect(encodedConfig).toBeDefined();
    expect(JSON.parse(decodeURIComponent(encodedConfig ?? ""))).toEqual(config);
    expect(document).not.toContain("<script>window.");
  });

  it("injects configuration into shared development HTML", async () => {
    const runtime = {
      mount: vi.fn(async () => {}),
      transformHtml: vi.fn(async () =>
        '<div data-atlas-config="__ATLAS_CLIENT_CONFIG__"></div>'
      ),
    } as unknown as ViteDevelopmentRuntime;
    const server = { register: vi.fn() } as unknown as FastifyInstance;
    const config: AtlasClientConfig = {
      basePath: "/admin",
      title: "Administration",
    };
    const adapter = new ViteAtlasClientAdapter({
      dev: true,
      development: {
        runtime,
        entry: {
          htmlPath: "/workspace/atlas/index.html",
          templateModulePath: "/src/main.tsx",
          developmentModulePath: "/src/kestrel/atlas/client/src/main.tsx",
        },
      },
    });

    const render = await adapter.setup(
      server,
      new Atlas({ basePath: "/admin", resources: [] }),
      config,
    );
    const reply = {
      request: { url: "/admin" },
      type: vi.fn().mockReturnThis(),
      send: vi.fn((document: string) => document),
    };
    const document = await render(reply as never) as string;
    const encodedConfig = document.match(
      /data-atlas-config="([^"]+)"/u,
    )?.[1];

    expect(JSON.parse(decodeURIComponent(encodedConfig ?? ""))).toEqual(config);
    expect(server.register).not.toHaveBeenCalled();
  });
});
