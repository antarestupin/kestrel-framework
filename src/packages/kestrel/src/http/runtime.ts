import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { RuntimeApp } from "../app/index.js";
import { waitForShutdownSignal } from "../app/process.js";
import { applicationLoggerDependency } from "../log/index.js";
import type { HttpConfig } from "./configuration.js";
import { HttpControllerManager } from "./controller_manager.js";
import type { HttpHardeningProfile } from "./hardening/index.js";
import {
  anonymousHttpAccess,
  type HttpAccessPolicy,
  validateHttpAccessPolicy,
} from "./access.js";

export type HttpRuntimeServerOptions = Omit<
  FastifyServerOptions,
  "logger" | "loggerInstance"
>;

export interface HttpRuntimeOptions {
  /** Policy inherited by controllers without access; defaults to unrestricted access. */
  readonly defaultAccess?: HttpAccessPolicy;
  readonly profile?: HttpHardeningProfile;
  readonly server?: HttpRuntimeServerOptions;
  readonly onListening?: (address: string) => Promise<void> | void;
}

/** Owns Fastify construction, listening and draining for one application. */
export class HttpRuntime<Config> {
  public readonly server: FastifyInstance;

  private stopPromise: Promise<void> | undefined;
  private readonly defaultAccess: HttpAccessPolicy;

  public constructor(
    private readonly app: RuntimeApp<Config>,
    private readonly config: HttpConfig,
    private readonly options: HttpRuntimeOptions = {},
  ) {
    // Validate composition before allocating the Fastify runtime.
    this.defaultAccess = validateHttpAccessPolicy(
      options.defaultAccess === undefined ? anonymousHttpAccess : options.defaultAccess,
    );
    if (
      options.profile !== undefined
      && options.server?.serverFactory !== undefined
    ) {
      throw new TypeError(
        "The HTTP hardening profile does not support a custom server factory.",
      );
    }

    // Fastify infrastructure events belong to the HTTP workload even when a
    // composite background process is running other workloads concurrently.
    const logger = app.container.resolve(applicationLoggerDependency).child({
      workload: "http",
    });
    const logOptions: Pick<FastifyServerOptions, "logger" | "loggerInstance"> =
      config.fastifyLogs
        ? { loggerInstance: logger as FastifyBaseLogger }
        : { logger: { level: "silent" } };

    this.server = Fastify({
      ...options.server,
      // An explicitly selected security profile cannot be weakened by generic
      // server options. Profile-specific customization belongs in its config.
      ...options.profile?.server,
      ...logOptions,
    });

    options.profile?.install(this.server);
    this.composeServer();
  }

  /** Opens the configured network listener after Fastify becomes ready. */
  public async start(): Promise<string> {
    const address = await this.server.listen({
      host: this.config.host,
      port: this.config.port,
    });

    await this.options.onListening?.(address);

    return address;
  }

  /** Runs until an interrupt or termination signal requests shutdown. */
  public async run(): Promise<void> {
    try {
      await this.start();
      await waitForShutdownSignal();
    } finally {
      await this.stop();
    }
  }

  /** Stops request admission and closes the Fastify runtime once. */
  public stop(): Promise<void> {
    this.stopPromise ??= this.server.close();

    return this.stopPromise;
  }

  /** Registers every HTTP definition before Fastify reaches readiness. */
  private composeServer(): void {
    for (const extension of this.app.httpExtensions.definitions) {
      this.server.register(async (server) => {
        await extension.mount({ app: this.app, server, defaultAccess: this.defaultAccess });
      });
    }

    const controllerManager = new HttpControllerManager(
      this.app,
      this.server,
      {
        executionIdHeader: this.config.executionIdHeader,
        defaultAccess: this.defaultAccess,
      },
    );

    for (const controller of this.app.catalog.httpControllers.definitions) {
      controllerManager.register(controller);
    }

    // Fastify readiness remains the boundary used by listen and inject tests.
    this.server.addHook("onReady", async () => {
      await this.app.start();
    });
    this.server.addHook("preClose", async () => {
      await this.app.stop();
    });
  }
}
