import type { Logger } from "pino";

import {
  applicationStartedEvent,
  executionCompletedEvent,
  type ExecutionContext,
  type Provider,
  type ProviderBootApp,
  type ProviderCompositionApp,
} from "../app/index.js";
import { dep } from "../di/index.js";
import type { LoggerConfig } from "./configuration.js";
import {
  createDelegatingLogger,
  createDynamicExecutionLogger,
  createExecutionWorkloadLogger,
  createLogger,
  projectExecutionLogContext,
  type OwnedLogger,
} from "./logger.js";

interface ScopedLoggerDependencies {
  applicationLogger: Logger;
  executionContext: ExecutionContext;
  executionId: string;
}

interface ApplicationLoggerResource<Config> extends OwnedLogger {
  boot(app: ProviderBootApp<Config>): Promise<void>;
}

/** Declares scoped loggers and selects their backend during bootstrap. */
export class LoggerProvider<Config> implements Provider<Config> {
  /** Local overrides are keyed by context so completion listeners need no scope lookup. */
  private readonly executionLogOverrides = new WeakMap<ExecutionContext, boolean>();

  public constructor(protected readonly config: LoggerConfig) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "loggerResource",
      () => this.createResource(),
      {
        lifetime: "singleton",
        dispose: (resource) => resource.close(),
      },
    );
    app.container.registerFactory<Logger, {
      loggerResource: ApplicationLoggerResource<Config>;
    }>(
      "applicationLogger",
      ({ loggerResource }) => loggerResource.logger,
      { lifetime: "singleton" },
    );
    app.container.registerFactory(
      "setExecutionLogEnabled",
      ({ executionContext }: Pick<ScopedLoggerDependencies, "executionContext">) =>
        (enabled: boolean) => {
          this.executionLogOverrides.set(executionContext, enabled);
        },
      { lifetime: "scoped" },
    );
    app.container.registerFactory(
      "logger",
      ({
        applicationLogger,
        executionContext,
        executionId,
      }: ScopedLoggerDependencies) => {
        const logger = createExecutionWorkloadLogger(
          applicationLogger.child({ executionId }),
          executionContext,
        );

        return this.config.executionLog.enabled
          && this.config.executionLog.contextMode === "dynamic"
          ? createDynamicExecutionLogger(
              logger,
              executionContext,
              () => this.isExecutionLogEnabled(executionContext),
            )
          : logger;
      },
      { lifetime: "scoped" },
    );

    // Startup is summarized only after the active logger backend is ready.
    app.eventBus.listen(applicationStartedEvent, (startup) => {
      app.container.resolve(dep<Logger>("applicationLogger")).debug(
        startup,
        "App started",
      );
    });

    if (
      this.config.executionLog.enabled
      && this.config.executionLog.contextMode === "completion"
    ) {
      // The application listener sees the sealed execution snapshot even when
      // no action or service resolved the scoped logger itself.
      app.eventBus.listen(executionCompletedEvent, ({
        context,
        executionId,
        outcome,
      }) => {
        const fields = projectExecutionLogContext(context);

        if (this.isExecutionLogEnabled(context)) {
          app.container.resolve(dep<Logger>("applicationLogger")).info({
            executionId,
            outcome,
            ...fields,
          }, "Execution context completed");
        }
      }, { scope: "descendants" });
    }
  }

  /** A local override can suppress but never bypass the application policy. */
  private isExecutionLogEnabled(context: ExecutionContext): boolean {
    return this.config.executionLog.enabled
      && (this.executionLogOverrides.get(context) ?? true);
  }

  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    await app.container.resolve(
      dep<ApplicationLoggerResource<Config>>("loggerResource"),
    ).boot(app);
  }

  /** Creates the backend selected for the finalized application runtime. */
  protected createActiveLogger(
    _app: ProviderBootApp<Config>,
  ): Promise<OwnedLogger> | OwnedLogger {
    return createLogger({ level: this.config.level });
  }

  /** Creates a stable facade before the runtime-specific backend is selected. */
  protected createResource(): ApplicationLoggerResource<Config> {
    const fallback = createLogger({ level: "silent" });
    let active = fallback;
    let booted = false;

    return {
      logger: createDelegatingLogger(() => active.logger),
      boot: async (app) => {
        if (!booted) {
          booted = true;
          active = await this.createActiveLogger(app);
        }
      },
      close: async () => {
        const owned = active;

        active = fallback;

        if (owned !== fallback) {
          await owned.close();
        }

        await fallback.close();
      },
    };
  }
}
