import { registerAdapter, type AdapterRegistration } from "../di/adapter.js";
import type { WebClientAdapterDefinition } from "./adapter_definition.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Provider, ProviderCompositionApp } from "../app/index.js";
import { DEFAULT_CLIENT_ASSET_BASE_PATH, type WebClientAdapter, type WebClient } from "./client.js";

export interface ClientProviderOptions {
  readonly basePath?: string;
  readonly assetBasePath?: string;
  /** Paths that must retain JSON not-found responses instead of the SPA shell. */
  readonly excludedPaths?: readonly string[];
}

/** Mounts one browser application without depending on its UI framework. */
export class ClientProvider<Config> implements Provider<Config> {
  private readonly client: WebClient;
  private readonly excludedPaths: readonly string[];

  public constructor(
    private readonly adapter: WebClientAdapterDefinition,
    options: ClientProviderOptions = {},
  ) {
    this.client = {
      basePath: normalizeBasePath(options.basePath ?? "/"),
      assetBasePath: normalizeAssetBasePath(
        options.assetBasePath ?? DEFAULT_CLIENT_ASSET_BASE_PATH,
      ),
    };
    this.excludedPaths = (options.excludedPaths ?? []).map(normalizeExcludedPath);
  }

  public register(app: ProviderCompositionApp<Config>): void {
    // Distinct mounts must retain independent definitions and lifecycle holders.
    const adapter = registerAdapter(
      app.container,
      `webClientAdapter:${this.client.basePath}`,
      this.adapter,
      undefined,
    );
    app.httpExtensions.register({
      mount: ({ server }) => this.mount(server, adapter),
    });
  }

  private async mount(
    server: FastifyInstance,
    adapter: AdapterRegistration<WebClientAdapter>,
  ): Promise<void> {
    await server.register(async (server) => {
      await adapter.boot();
      const renderClient = await adapter.get().setup(server, this.client);
      const render = (request: FastifyRequest, reply: FastifyReply) =>
        renderClient({ request, reply });

      // The sentinel route enters the encapsulated Vite scope before fallback.
      server.get(`${this.client.assetBasePath}*`, async (_request, reply) =>
        reply.code(404).send({
          error: "Client asset not found.",
        }),
      );

      for (const excludedPath of this.excludedPaths) {
        const notFound = async (_request: FastifyRequest, reply: FastifyReply) =>
          reply.code(404).send({ error: "API route not found." });

        server.get(excludedPath, notFound);
        server.get(`${excludedPath}/*`, notFound);
      }

      server.get(this.client.basePath, render);
      // Fastify's wildcard already matches the empty suffix after a trailing slash.
      server.get(joinWildcardPath(this.client.basePath), render);
    });
  }
}

function normalizeBasePath(path: string): string {
  if (!isLiteralRoutePath(path) || (path !== "/" && path.endsWith("/"))) {
    throw new TypeError(
      "A client base path must be a literal absolute URL path and omit a trailing slash except at the root.",
    );
  }

  return path;
}

function normalizeAssetBasePath(path: string): string {
  if (!isLiteralRoutePath(path) || path === "/" || !path.endsWith("/")) {
    throw new TypeError(
      "A client asset base path must be a literal absolute URL path with a trailing slash and a non-root prefix.",
    );
  }

  return path;
}

function normalizeExcludedPath(path: string): string {
  if (!isLiteralRoutePath(path) || path.endsWith("/")) {
    throw new TypeError(
      "An excluded client path must be a literal absolute URL path and omit a trailing slash.",
    );
  }

  return path;
}

/** Require Fastify and browser navigation to agree on the configured literal route. */
function isLiteralRoutePath(path: string): boolean {
  return path.startsWith("/")
    && !path.includes("//")
    && !/[\\?#:*\p{White_Space}\p{Cc}]/u.test(path)
    && !/(?:^|\/)(?:\.|%2e){1,2}(?=\/|$)/iu.test(path);
}

function joinWildcardPath(basePath: string): string {
  return `${basePath === "/" ? "" : basePath}/*`;
}
