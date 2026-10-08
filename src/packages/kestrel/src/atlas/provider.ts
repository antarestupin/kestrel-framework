import { registerAdapter } from "../di/adapter.js";
import type { AtlasClientAdapterDefinition } from "./adapter_definition.js";
import type { Provider, ProviderCompositionApp } from "../app/index.js";
import {
  defineHttpAccessPolicy,
  defineHttpController,
  del,
  get,
  HttpControllerManager,
  patch,
  post,
  defineHttpMiddleware,
  type HttpMiddleware,
} from "../http/index.js";
import type { AtlasClientAdapter } from "./adapters/index.js";
import type { Atlas } from "./atlas.js";
import {
  ATLAS_ASSET_BASE_PATH,
  type AtlasClientAuthenticationConfig,
  type AtlasClientConfig,
} from "./client_config.js";
import { AtlasLoginRequiredError } from "./errors.js";

export interface AtlasAuthenticationOptions {
  /** Relative route below Atlas base path. */
  readonly loginPath?: string;
  /** Public application endpoint accepting username and password. */
  readonly passwordSignInUrl: string;
  /** Public application endpoint revoking the current browser session. */
  readonly signOutUrl: string;
  /** Resolves the cookie session and rejects an anonymous execution. */
  readonly requiredSession: HttpMiddleware<any, any>;
  /** Identifies the authentication library's missing-session error. */
  readonly isAuthenticationRequired: (error: unknown) => boolean;
}

export interface AtlasProviderOptions {
  /** Lets the application make exposure an explicit deployment decision. */
  readonly enabled?: boolean;
  readonly atlas: Atlas;
  readonly authentication?: AtlasAuthenticationOptions;
  /** Protects the exact base path and every descendant route. */
  readonly access?: {
    readonly required?: readonly HttpMiddleware<any, any>[];
    readonly unsafe?: readonly HttpMiddleware<any, any>[];
  };
}

/** Mounts one Atlas manifest and React application on Fastify. */
export class AtlasProvider<Config> implements Provider<Config> {
  private readonly atlas: Atlas;
  private readonly enabled: boolean;
  private readonly access: NonNullable<AtlasProviderOptions["access"]>;
  private readonly authentication: AtlasClientAuthenticationConfig | undefined;
  private readonly isAuthenticationRequired: ((error: unknown) => boolean) | undefined;
  private readonly requiredSession: HttpMiddleware<any, any> | undefined;

  public constructor(
    private readonly adapter: AtlasClientAdapterDefinition,
    options: AtlasProviderOptions,
  ) {
    this.enabled = options.enabled ?? true;
    this.atlas = options.atlas;
    this.access = options.access ?? {};
    this.authentication =
      options.authentication === undefined
        ? undefined
        : normalizeAuthenticationOptions(options.atlas.basePath, options.authentication);
    this.isAuthenticationRequired = options.authentication?.isAuthenticationRequired;
    this.requiredSession = options.authentication?.requiredSession;
  }

  public register(app: ProviderCompositionApp<Config>): void {
    if (!this.enabled) {
      return;
    }

    const adapter = registerAdapter(
      app.container,
      `atlasClientAdapter:${this.atlas.basePath}`,
      this.adapter,
      undefined,
    );
    app.container.registerValue("atlas", this.atlas);
    app.httpExtensions.register({
      mount: ({ server, defaultAccess }) => {
        server.register(async (server) => {
          await adapter.boot();
          const renderClient = await adapter
            .get()
            .setup(server, this.atlas, createClientConfig(this.atlas, this.authentication));
          const controllerManager = new HttpControllerManager(
            app.runtime,
            server,
            defaultAccess === undefined ? {} : { defaultAccess },
          );
          const required = [
            ...(this.requiredSession === undefined ? [] : [this.requiredSession]),
            ...(this.access.required ?? []),
          ];

          for (const controller of this.atlas.defineHttpControllers({
            required,
            ...(this.access.unsafe === undefined ? {} : { unsafe: this.access.unsafe }),
          })) {
            controllerManager.register(controller);
          }

          // Asset requests enter the provider scope before Vite serves them.
          server.get(`${ATLAS_ASSET_BASE_PATH}*`, async (_request, reply) =>
            reply.code(404).send({
              error: "Atlas asset not found.",
            }),
          );

          const unsafe = [...(this.access.unsafe ?? []), ...required];
          const pageRequired =
            this.authentication === undefined
              ? required
              : [this.createLoginRedirectMiddleware(), ...required];
          const requiredAccess = defineHttpAccessPolicy("atlas.http.required", required);
          const pageAccess = defineHttpAccessPolicy("atlas.http.page", pageRequired);
          const unsafeAccess = defineHttpAccessPolicy("atlas.http.unsafe", unsafe);
          const loginAccess = defineHttpAccessPolicy("atlas.http.login");
          const renderAtlas = (route: string, operationId: string) =>
            defineHttpController({
              access: pageAccess,
              route: get(route),
              operationId,
              handler: ({ reply }) => renderClient(reply),
            });

          if (this.authentication !== undefined) {
            // The login document must remain reachable before a session exists.
            controllerManager.register(
              defineHttpController({
                access: loginAccess,
                route: get(this.authentication.loginPath),
                operationId: "atlas.authentication.login",
                handler: ({ reply }) => {
                  reply.header("cache-control", "no-store");
                  return renderClient(reply);
                },
              }),
            );
          }

          controllerManager.register(renderAtlas(this.atlas.basePath, "atlas.render.base"));

          if (this.atlas.basePath !== "/") {
            controllerManager.register(
              renderAtlas(`${this.atlas.basePath}/`, "atlas.render.trailing"),
            );
          }

          // API misses remain JSON responses rather than the SPA shell.
          controllerManager.register(
            defineHttpController({
              access: requiredAccess,
              route: get(`${this.atlas.basePath === "/" ? "" : this.atlas.basePath}/api/*`),
              operationId: "atlas.api.not-found",
              handler: ({ reply }) =>
                reply.code(404).send({
                  error: "Atlas API route not found.",
                }),
            }),
          );
          controllerManager.register(
            renderAtlas(
              `${this.atlas.basePath === "/" ? "" : this.atlas.basePath}/*`,
              "atlas.render.fallback",
            ),
          );

          // Unknown unsafe routes still cross the same access boundary. This
          // prevents unsupported methods from becoming an authorization bypass
          // or a route-discovery side channel under the owned prefix.
          const unsafeNotFound = (route: ReturnType<typeof post>, operationId: string) =>
            defineHttpController({
              access: unsafeAccess,
              route,
              operationId,
              handler: ({ reply }) =>
                reply.code(404).send({
                  error: "Atlas route not found.",
                }),
            });
          const unsafeRoutes = [
            [post, "post"],
            [patch, "patch"],
            [del, "delete"],
          ] as const;

          for (const [createRoute, method] of unsafeRoutes) {
            controllerManager.register(
              unsafeNotFound(createRoute(this.atlas.basePath), `atlas.${method}.base.not-found`),
            );
            controllerManager.register(
              unsafeNotFound(
                createRoute(`${this.atlas.basePath === "/" ? "" : this.atlas.basePath}/*`),
                `atlas.${method}.not-found`,
              ),
            );
          }
        });
      },
    });
  }

  private createLoginRedirectMiddleware(): HttpMiddleware<unknown, any> {
    const authentication = this.authentication;
    const isAuthenticationRequired = this.isAuthenticationRequired;

    if (authentication === undefined || isAuthenticationRequired === undefined) {
      throw new Error("Atlas authentication is not configured.");
    }

    return defineHttpMiddleware("atlas.authentication.redirect", {
      handler: async ({ request }, next) => {
        try {
          return await next();
        } catch (error: unknown) {
          if (!isAuthenticationRequired(error)) {
            throw error;
          }

          const returnTo = getSafeNavigationTarget(request.url, this.atlas.basePath);
          throw new AtlasLoginRequiredError(
            `${authentication.loginPath}?returnTo=${encodeURIComponent(returnTo)}`,
          );
        }
      },
    });
  }
}

function normalizeAuthenticationOptions(
  basePath: string,
  options: AtlasAuthenticationOptions,
): AtlasClientAuthenticationConfig {
  const relativeLoginPath = options.loginPath ?? "/login";

  if (
    !relativeLoginPath.startsWith("/") ||
    relativeLoginPath.startsWith("//") ||
    relativeLoginPath === "/" ||
    relativeLoginPath.endsWith("/") ||
    relativeLoginPath.includes("?") ||
    relativeLoginPath.includes("#") ||
    relativeLoginPath === "/api" ||
    relativeLoginPath.startsWith("/api/")
  ) {
    throw new TypeError(
      "An Atlas login path must be a non-root relative path starting with one slash and without a trailing slash, query, or fragment.",
    );
  }
  if (
    !options.passwordSignInUrl.startsWith("/") ||
    options.passwordSignInUrl.startsWith("//") ||
    options.passwordSignInUrl.includes("#")
  ) {
    throw new TypeError("An Atlas password sign-in URL must start with a slash.");
  }
  if (
    !options.signOutUrl.startsWith("/") ||
    options.signOutUrl.startsWith("//") ||
    options.signOutUrl.includes("#")
  ) {
    throw new TypeError("An Atlas sign-out URL must start with a slash.");
  }

  return {
    loginPath: `${basePath === "/" ? "" : basePath}${relativeLoginPath}`,
    passwordSignInUrl: options.passwordSignInUrl,
    signOutUrl: options.signOutUrl,
  };
}

function createClientConfig(
  atlas: Atlas,
  authentication?: AtlasClientAuthenticationConfig,
): AtlasClientConfig {
  return {
    basePath: atlas.basePath,
    title: atlas.title,
    ...(authentication === undefined ? {} : { authentication }),
  };
}

function getSafeNavigationTarget(requestUrl: string, basePath: string): string {
  const fallback = basePath;

  try {
    const url = new URL(requestUrl, "http://atlas.local");

    const isBelowBasePath =
      basePath === "/"
        ? url.pathname.startsWith("/")
        : url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);

    return url.origin === "http://atlas.local" && isBelowBasePath
      ? `${url.pathname}${url.search}${url.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}
