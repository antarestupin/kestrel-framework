import fastifyVite from "@fastify/vite";
import type {
  FastifyInstance,
  FastifyReply,
} from "fastify";
import { fileURLToPath } from "node:url";

import type {
  ViteClientDevelopmentOptions,
} from "../../../client/index.js";
import type { Atlas } from "../../atlas.js";
import type { AtlasClientConfig } from "../../client_config.js";

export type AtlasClientRender = (
  reply: FastifyReply,
) => Promise<unknown> | unknown;

/** Delivers an Atlas client without coupling the provider to Vite. */
export interface AtlasClientAdapter {
  setup(
    server: FastifyInstance,
    atlas: Atlas,
    clientConfig: AtlasClientConfig,
  ): Promise<AtlasClientRender>;
}

export interface ViteAtlasClientAdapterOptions {
  readonly dev?: boolean;
  readonly projectRoot?: string;
  /** Reuses a lower-level Vite runtime composed by the consuming app. */
  readonly development?: ViteClientDevelopmentOptions;
}

/** Delivers the React client through Vite development or production assets. */
export class ViteAtlasClientAdapter
implements AtlasClientAdapter {
  private readonly dev: boolean;
  private readonly projectRoot: string;
  private readonly development:
    ViteAtlasClientAdapterOptions["development"];

  public constructor(
    options: ViteAtlasClientAdapterOptions = {},
  ) {
    this.dev = options.dev ?? false;
    this.development = options.development;
    // Resolve from dist/atlas/adapters/client to the installed package root.
    this.projectRoot = options.projectRoot
      ?? fileURLToPath(new URL(
        "../../../../",
        import.meta.url,
      ));
  }

  public async setup(
    server: FastifyInstance,
    _atlas: Atlas,
    clientConfig: AtlasClientConfig,
  ): Promise<AtlasClientRender> {
    const serializedConfig = serializeClientConfig(clientConfig);

    if (this.dev && this.development !== undefined) {
      const { runtime, entry } = this.development;

      await runtime.mount(server);

      return async (reply) => {
        const source = await runtime.transformHtml(
          reply.request.url,
          entry,
        );
        const document = source.replace(
          "__ATLAS_CLIENT_CONFIG__",
          serializedConfig,
        );

        return reply.type("text/html").send(document);
      };
    }

    await server.register(fastifyVite, {
      root: this.projectRoot,
      dev: this.dev,
      spa: true,
      distDir: "assets/atlas",
      createHtmlFunction(source) {
        const document = source.replace(
          "__ATLAS_CLIENT_CONFIG__",
          serializedConfig,
        );

        return function renderAtlasHtml(this: FastifyReply) {
          return this.type("text/html").send(document);
        };
      },
    });
    await server.vite.ready();

    if (this.dev) {
      server.addHook("preClose", async () => {
        // Close HMR WebSockets before Fastify drains upgraded connections.
        await server.vite.devServer?.close();
      });
    }

    return (reply) => reply.html();
  }
}

function serializeClientConfig(config: AtlasClientConfig): string {
  // URI encoding keeps JSON inert and safe inside a double-quoted attribute.
  return encodeURIComponent(JSON.stringify(config));
}
