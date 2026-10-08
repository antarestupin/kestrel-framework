import { registerAdapter } from "../di/adapter.js";
import type { StudioClientAdapterDefinition } from "./adapter_definition.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Provider, ProviderCompositionApp } from "../app/index.js";
import { HttpControllerManager, type HttpAccessPolicy } from "../http/index.js";
import type { StudioClientAdapter } from "./adapters/index.js";
import { STUDIO_ASSET_BASE_PATH } from "./client_config.js";
import type { StudioConfig } from "./configuration.js";
import type { StudioExtension } from "./extension.js";
import { Studio } from "./studio.js";

export interface StudioProviderOptions {
  readonly extensions?: readonly StudioExtension[];
}

/** Mounts Studio and its extensions when explicitly enabled. */
export class StudioProvider<
  Config,
  Configuration extends StudioConfig = StudioConfig,
> implements Provider<Config> {
  private readonly extensions: readonly StudioExtension[];

  public constructor(
    protected readonly config: Configuration,
    private readonly adapter: StudioClientAdapterDefinition,
    options: StudioProviderOptions = {},
  ) {
    this.extensions = options.extensions ?? [];
  }

  public register(app: ProviderCompositionApp<Config>): void {
    if (!this.config.enabled) {
      return;
    }

    const studio = this.createStudio(app);
    const adapter = registerAdapter(
      app.container,
      `studioClientAdapter:${this.config.basePath}`,
      this.adapter,
      undefined,
    );

    // Keeping the registry in DI lets other providers inspect the configured
    // Studio without coupling the application core to its user interface.
    app.container.registerValue("studio", studio);
    app.httpExtensions.register({
      mount: async ({ server, defaultAccess }) => {
        await adapter.boot();
        await this.mount(app, server, studio, adapter.get(), defaultAccess);
      },
    });
  }

  /** Creates the Studio definition from configuration and installed extensions. */
  protected createStudio(app: ProviderCompositionApp<Config>): Studio {
    return new Studio({
      basePath: this.config.basePath,
      extensions: this.createExtensions(app),
    });
  }

  /** Lists extensions installed by this provider or an application subclass. */
  protected createExtensions(_app: ProviderCompositionApp<Config>): readonly StudioExtension[] {
    return this.extensions;
  }

  /** Mounts Studio inside one encapsulated Fastify scope. */
  protected async mount(
    app: ProviderCompositionApp<Config>,
    server: FastifyInstance,
    studio: Studio,
    client: StudioClientAdapter,
    defaultAccess?: HttpAccessPolicy,
  ): Promise<void> {
    await server.register(async (server) => {
      const renderClient = await client.setup(server, studio);
      // Studio data requests must not recursively appear in observations.
      const controllerManager = new HttpControllerManager(app.runtime, server, {
        observe: false,
        executionLog: false,
        ...(defaultAccess === undefined ? {} : { defaultAccess }),
      });

      for (const controller of await studio.defineHttpControllers()) {
        controllerManager.register(controller);
      }

      // The sentinel route enters Studio's Vite scope before the fallback.
      server.get(`${STUDIO_ASSET_BASE_PATH}*`, async (_request, reply) =>
        reply.code(404).send({
          error: "Studio asset not found.",
        }),
      );

      const renderStudio = async (_request: FastifyRequest, reply: FastifyReply) =>
        renderClient(reply);

      server.get(studio.basePath, renderStudio);

      if (studio.basePath !== "/") {
        server.get(`${studio.basePath}/`, renderStudio);
      }

      // Unknown API routes remain JSON instead of reaching the SPA shell.
      server.get(
        `${studio.basePath === "/" ? "" : studio.basePath}/api/*`,
        async (_request, reply) =>
          reply.code(404).send({
            error: "Studio API route not found.",
          }),
      );
      server.get(`${studio.basePath === "/" ? "" : studio.basePath}/*`, renderStudio);
    });
  }
}
