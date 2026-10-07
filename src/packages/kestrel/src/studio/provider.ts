import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type { Provider, ProviderCompositionApp } from "../app/index.js";
import { HttpControllerManager, type HttpAccessPolicy } from "../http/index.js";
import type { StudioClientAdapter } from "./adapters/index.js";
import { ViteStudioClientAdapter } from "./adapters/index.js";
import { STUDIO_ASSET_BASE_PATH } from "./client_config.js";
import type { StudioConfig } from "./configuration.js";
import type { StudioExtension } from "./extension.js";
import { Studio } from "./studio.js";

export interface StudioProviderOptions {
  readonly client?: StudioClientAdapter;
  readonly extensions?: readonly StudioExtension[];
}

/** Mounts Studio and its extensions when explicitly enabled. */
export class StudioProvider<
  Config,
  Configuration extends StudioConfig = StudioConfig,
> implements Provider<Config> {
  private readonly client: StudioClientAdapter | undefined;
  private readonly extensions: readonly StudioExtension[];

  public constructor(
    protected readonly config: Configuration,
    options: StudioProviderOptions = {},
  ) {
    this.client = options.client;
    this.extensions = options.extensions ?? [];
  }

  public register(app: ProviderCompositionApp<Config>): void {
    if (!this.config.enabled) {
      return;
    }

    const studio = this.createStudio(app);
    const client = this.client ?? this.createClient();

    // Keeping the registry in DI lets other providers inspect the configured
    // Studio without coupling the application core to its user interface.
    app.container.registerValue("studio", studio);
    app.httpExtensions.register({
      mount: ({ server, defaultAccess }) =>
        this.mount(app, server, studio, client, defaultAccess),
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
  protected createExtensions(
    _app: ProviderCompositionApp<Config>,
  ): readonly StudioExtension[] {
    return this.extensions;
  }

  /** Creates the default Vite delivery adapter for the selected mode. */
  protected createClient(): StudioClientAdapter {
    return new ViteStudioClientAdapter({ dev: this.config.devMode });
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
      const controllerManager = new HttpControllerManager(
        app.runtime,
        server,
        {
          observe: false,
          executionLog: false,
          ...(defaultAccess === undefined ? {} : { defaultAccess }),
        },
      );

      for (const controller of await studio.defineHttpControllers()) {
        controllerManager.register(controller);
      }

      // The sentinel route enters Studio's Vite scope before the fallback.
      server.get(
        `${STUDIO_ASSET_BASE_PATH}*`,
        async (_request, reply) => reply.code(404).send({
          error: "Studio asset not found.",
        }),
      );

      const renderStudio = async (
        _request: FastifyRequest,
        reply: FastifyReply,
      ) => renderClient(reply);

      server.get(studio.basePath, renderStudio);

      if (studio.basePath !== "/") {
        server.get(`${studio.basePath}/`, renderStudio);
      }

      // Unknown API routes remain JSON instead of reaching the SPA shell.
      server.get(
        `${studio.basePath === "/" ? "" : studio.basePath}/api/*`,
        async (_request, reply) => reply.code(404).send({
          error: "Studio API route not found.",
        }),
      );
      server.get(
        `${studio.basePath === "/" ? "" : studio.basePath}/*`,
        renderStudio,
      );
    });
  }
}
