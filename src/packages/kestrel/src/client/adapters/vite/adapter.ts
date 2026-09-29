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
  readonly projectRoot: string;
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
    _client: WebClient,
  ): Promise<WebClientRender> {
    if (this.options.devMode && this.options.development !== undefined) {
      const { runtime, entry } = this.options.development;

      await runtime.mount(server);

      return async ({ request, reply }) => {
        const document = await runtime.transformHtml(
          request.url,
          entry,
        );

        return reply.type("text/html").send(document);
      };
    }

    await server.register(fastifyVite, {
      root: this.options.projectRoot,
      dev: this.options.devMode,
      spa: true,
      distDir: this.options.distDir,
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
