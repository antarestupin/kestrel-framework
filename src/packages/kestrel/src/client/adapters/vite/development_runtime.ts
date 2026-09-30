import middie from "@fastify/middie";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import type { InlineConfig, ViteDevServer } from "vite";

export interface ViteDevelopmentEntry {
  /** HTML template retained by the client's standalone production build. */
  readonly htmlPath: string;
  /** Module URL written in the standalone HTML template. */
  readonly templateModulePath: string;
  /** Module URL resolved from the shared development root. */
  readonly developmentModulePath: string;
}

export interface ViteDevelopmentRuntimeOptions {
  readonly root: string;
  readonly configFile: string;
}

export interface ViteDevelopmentClientOptions {
  /** Client root relative to the shared Vite development root. */
  readonly root: string;
  /** Standalone HTML template relative to the client root. */
  readonly html?: string;
  /** Browser entry module relative to the client root. */
  readonly module?: string;
}

export interface ViteClientDevelopmentOptions {
  readonly runtime: ViteDevelopmentRuntime;
  readonly entry: ViteDevelopmentEntry;
}

type CreateViteServer = (config: InlineConfig) => Promise<ViteDevServer>;

interface ViteDevelopmentRuntimeDependencies {
  readonly createServer?: CreateViteServer;
  readonly readHtml?: typeof readFile;
}

/**
 * Owns one Vite middleware server shared by multiple browser clients.
 *
 * Client adapters remain responsible for their HTML contracts while this
 * lower-level runtime owns the common watcher, module graph and HMR socket.
 */
export class ViteDevelopmentRuntime {
  private readonly mountedScopes = new WeakSet<FastifyInstance>();
  private readonly createServer: CreateViteServer;
  private readonly readHtml: typeof readFile;
  private serverPromise: Promise<ViteDevServer> | undefined;
  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly options: ViteDevelopmentRuntimeOptions,
    dependencies: ViteDevelopmentRuntimeDependencies = {},
  ) {
    this.createServer = dependencies.createServer ?? defaultCreateServer;
    this.readHtml = dependencies.readHtml ?? readFile;
  }

  /** Resolves one standalone client against this runtime's shared root. */
  public entry(
    options: ViteDevelopmentClientOptions,
  ): ViteClientDevelopmentOptions {
    const clientRoot = normalizeRelativePath(options.root, "client root");
    const html = normalizeRelativePath(
      options.html ?? "index.html",
      "client HTML",
    );
    const module = normalizeRelativePath(
      options.module ?? "src/main.tsx",
      "client module",
    );

    return {
      runtime: this,
      entry: {
        htmlPath: resolve(this.options.root, clientRoot, html),
        templateModulePath: `/${module}`,
        developmentModulePath: `/${posix.join(clientRoot, module)}`,
      },
    };
  }

  /** Attaches the shared middleware to one encapsulated client scope. */
  public async mount(server: FastifyInstance): Promise<void> {
    if (this.mountedScopes.has(server)) {
      return;
    }

    const vite = await this.getServer(server);

    await server.register(middie);
    server.use(vite.middlewares);
    server.addHook("preClose", async () => this.close());
    this.mountedScopes.add(server);
  }

  /** Transforms one client's standalone HTML for the shared development root. */
  public async transformHtml(
    requestUrl: string,
    entry: ViteDevelopmentEntry,
  ): Promise<string> {
    const vite = await this.getServer();
    const template = await this.readHtml(entry.htmlPath, "utf8");

    if (!template.includes(entry.templateModulePath)) {
      throw new Error(
        `Vite development entry ${entry.htmlPath} does not reference ${entry.templateModulePath}.`,
      );
    }

    const developmentHtml = template.replace(
      entry.templateModulePath,
      entry.developmentModulePath,
    );

    return vite.transformIndexHtml(requestUrl, developmentHtml);
  }

  /** Closes the shared HMR runtime exactly once across every client scope. */
  public async close(): Promise<void> {
    if (this.serverPromise === undefined) {
      return;
    }

    this.closePromise ??= this.serverPromise.then(async (server) => {
      await server.close();
    });

    await this.closePromise;
  }

  private getServer(server?: FastifyInstance): Promise<ViteDevServer> {
    if (this.serverPromise === undefined) {
      if (server === undefined) {
        throw new Error(
          "Vite development runtime must be mounted before transforming HTML.",
        );
      }

      this.serverPromise = this.createServer({
        root: this.options.root,
        configFile: this.options.configFile,
        // Bundled configs are imported and deleted, triggering Node's module watch mode.
        // Native loading uses the application's Node/tsx runtime and preserves real-file watching.
        configLoader: "native",
        appType: "custom",
        server: {
          middlewareMode: true,
          ws: { server: server.server },
        },
      });
    }

    return this.serverPromise;
  }
}

async function defaultCreateServer(
  config: InlineConfig,
): Promise<ViteDevServer> {
  // Vite stays out of non-HTTP runtimes and production startup paths.
  const { createServer } = await import("vite");

  return createServer(config);
}

function normalizeRelativePath(path: string, label: string): string {
  const portablePath = path.replaceAll("\\", "/");
  const normalized = posix.normalize(portablePath).replace(/^\.\//u, "");

  if (
    normalized === ""
    || isAbsolute(path)
    || posix.isAbsolute(portablePath)
    || /^[A-Za-z]:\//u.test(portablePath)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new TypeError(`Vite development ${label} must be a relative path.`);
  }

  return normalized;
}
