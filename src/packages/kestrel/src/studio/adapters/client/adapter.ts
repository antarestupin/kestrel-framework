import fastifyVite from "@fastify/vite";
import type {
  FastifyInstance,
  FastifyReply,
} from "fastify";
import { fileURLToPath } from "node:url";

import type {
  ViteClientDevelopmentOptions,
} from "../../../client/index.js";
import type { StudioSourcePathMapping } from "../../client_config.js";
import type { Studio } from "../../studio.js";

export type StudioClientRender = (
  reply: FastifyReply,
) => Promise<unknown> | unknown;

/**
 * Separates Studio's HTTP contracts from its Vite-powered client delivery.
 */
export interface StudioClientAdapter {
  setup(
    server: FastifyInstance,
    studio: Studio,
  ): Promise<StudioClientRender>;
}

export interface ViteStudioClientAdapterOptions {
  dev?: boolean;
  projectRoot?: string;
  /** Reuses a lower-level Vite runtime composed by the consuming app. */
  development?: ViteClientDevelopmentOptions;
  /** Optional runtime-to-editor mapping exposed to source-aware tools. */
  sourcePathMapping?: StudioSourcePathMapping;
}

/**
 * Delivers Studio through Vite middleware in development mode and through
 * generated assets when the application disables development mode.
 */
export class ViteStudioClientAdapter implements StudioClientAdapter {
  private readonly dev: boolean;
  private readonly projectRoot: string;
  private readonly development:
    ViteStudioClientAdapterOptions["development"];
  private readonly sourcePathMapping: StudioSourcePathMapping | undefined;

  public constructor(
    options: ViteStudioClientAdapterOptions = {},
  ) {
    this.dev = options.dev ?? false;
    this.development = options.development;
    this.projectRoot = options.projectRoot
      ?? fileURLToPath(new URL("../../../../", import.meta.url));
    this.sourcePathMapping = options.sourcePathMapping;
  }

  public async setup(
    server: FastifyInstance,
    studio: Studio,
  ): Promise<StudioClientRender> {
    const serializedConfig = serializeClientConfig(
      studio,
      this.sourcePathMapping,
    );

    if (this.dev && this.development !== undefined) {
      const { runtime, entry } = this.development;

      await runtime.mount(server);

      return async (reply) => {
        const source = await runtime.transformHtml(
          reply.request.url,
          entry,
        );
        const document = source.replace(
          "__STUDIO_CLIENT_CONFIG__",
          serializedConfig,
        );

        return reply.type("text/html").send(document);
      };
    }

    await server.register(fastifyVite, {
      root: this.projectRoot,
      dev: this.dev,
      spa: true,
      distDir: "assets/studio",
      createHtmlFunction(source) {
        const document = source.replace(
          "__STUDIO_CLIENT_CONFIG__",
          serializedConfig,
        );

        return function renderStudioHtml(this: FastifyReply) {
          return this.type("text/html").send(document);
        };
      },
    });
    await server.vite.ready();

    if (this.dev) {
      server.addHook("preClose", async () => {
        // Close HMR WebSockets before Fastify waits for upgraded connections.
        await server.vite.devServer?.close();
      });
    }

    return (reply) => reply.html();
  }
}

function serializeClientConfig(
  studio: Studio,
  sourcePathMapping: StudioSourcePathMapping | undefined,
): string {
  // URI encoding keeps JSON inert and safe inside a double-quoted attribute.
  return encodeURIComponent(JSON.stringify({
    basePath: studio.basePath,
    ...(sourcePathMapping === undefined ? {} : { sourcePathMapping }),
  }));
}
