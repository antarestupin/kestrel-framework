import { resolve } from "node:path";
import fastifyVite from "@fastify/vite";
import type { FastifyInstance } from "fastify";

import type {
  WebClient,
  WebClientAdapter,
  WebClientRender,
} from "../../client.js";
import type { ViteClientDevelopmentOptions } from "./development_runtime.js";

export interface ViteClientAdapterOptions {
  readonly devMode: boolean;
  /** Stable application root; legacy callers may omit sourceRoot to retain existing resolution. */
  readonly projectRoot: string;
  /** Vite source/config directory, relative to projectRoot or absolute. Never loaded in production. */
  readonly sourceRoot?: string;
  /** Compiled output directory, resolved against projectRoot when sourceRoot is supplied. */
  readonly distDir: string;
  /** Reuses an application-composed Vite server instead of creating one. */
  readonly development?: ViteClientDevelopmentOptions;
}

/** Delivers any Vite-built SPA without depending on its component framework. */
export class ViteClientAdapter implements WebClientAdapter {
  public constructor(
    private readonly options: ViteClientAdapterOptions,
  ) {}

  public async setup(
    server: FastifyInstance,
    client: WebClient,
  ): Promise<WebClientRender> {
    if (this.options.devMode && this.options.development !== undefined) {
      const { runtime, entry } = this.options.development;

      await runtime.mount(server, client.assetBasePath);

      return async ({ request, reply }) => {
        const document = await runtime.transformHtml(
          request.url,
          entry,
        );

        return reply.type("text/html").send(document);
      };
    }

    await server.register(fastifyVite, {
      // An explicit source root decouples Vite configuration from deployment assets.
      root: this.options.devMode && this.options.sourceRoot !== undefined
        ? resolve(this.options.projectRoot, this.options.sourceRoot)
        : this.options.projectRoot,
      dev: this.options.devMode,
      spa: true,
      distDir: this.options.sourceRoot === undefined
        ? this.options.distDir
        // @fastify/vite resolves absolute hints through their parent directory.
        : resolve(this.options.projectRoot, this.options.distDir, "index.html"),
    });
    await server.vite.ready();

    if (this.options.devMode) {
      server.addHook("preClose", async () => {
        // Close HMR WebSockets before Fastify drains upgraded connections.
        await server.vite.devServer?.close();
      });
    }

    return ({ reply }) => reply.html();
  }
}
