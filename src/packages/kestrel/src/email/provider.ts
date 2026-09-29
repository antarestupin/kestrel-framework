import type { Pool } from "pg";
import { ses } from "@opencoredev/email-sdk/ses";
import { smtp } from "@opencoredev/email-sdk/smtp";

import type {
  Provider,
  ProviderBootApp,
  ProviderCompositionApp,
} from "../app/index.js";
import { dep } from "../di/index.js";
import { observerContextDependency } from "../observability/index.js";
import { EmailCaptureAdapter } from "./adapters/capture/index.js";
import { EmailSdkEmailAdapter } from "./adapters/email_sdk/index.js";
import {
  MemoryEmailAdapter,
  MemoryEmailCaptureStore,
} from "./adapters/memory/index.js";
import { PostgresEmailCaptureStore } from "./adapters/postgres/index.js";
import {
  EmailCaptureInbox,
  type EmailCaptureStore,
} from "./capture.js";
import { EmailClient } from "./client.js";
import type {
  EmailConfig,
  EmailDriverConfig,
  SesEmailDriverConfig,
  SmtpEmailDriverConfig,
} from "./configuration.js";
import {
  emailCaptureStoreDependency,
  emailClientDependency,
} from "./dependencies.js";
import {
  recordEmailInstrumentation,
  type EmailInstrumentation,
} from "./observations.js";
import type { EmailDriver } from "./types.js";

interface DatabaseClientDependency {
  pool: Pool;
}

export interface EmailProviderOptions {
  /** Additional diagnostic sink combined with ambient observations. */
  readonly instrumentation?: EmailInstrumentation;
  readonly monotonicNow?: () => number;
  readonly createObservationId?: () => string;
}

/** Registers the configured email client and optional local capture services. */
export class EmailProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly config: EmailConfig,
    protected readonly options: EmailProviderOptions = {},
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    if (!this.config.enabled) return;

    if (this.config.driver.type === "capture") {
      this.registerCaptureServices(app);
    }

    app.container.registerFactory(
      emailClientDependency.id,
      () => this.createClient(app),
      {
        lifetime: "singleton",
        dispose: (client) => client.close(),
      },
    );
  }

  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    if (
      !this.config.enabled
      || this.config.driver.type !== "capture"
      || app.bootPlan.runningMode === "minimal"
    ) {
      return;
    }

    const store = app.container.resolve(emailCaptureStoreDependency);

    try {
      await store.prepare?.(this.config.capture.retentionDays);
    } catch (error: unknown) {
      // Disposable development tables may not exist until local database
      // maintenance runs, so their absence cannot block that repair command.
      if (!isUndefinedTableError(error)) throw error;
    }
  }

  /** Creates the selected driver and is the main subclass extension point. */
  protected createDriver(
    app: ProviderCompositionApp<Config>,
    config: EmailDriverConfig,
  ): EmailDriver {
    switch (config.type) {
      case "capture":
        return new EmailCaptureAdapter({
          name: "local-capture",
          store: app.container.resolve(emailCaptureStoreDependency),
          maxMessageBytes: this.config.capture.maxMessageBytes,
        });
      case "memory":
        return new MemoryEmailAdapter();
      case "smtp":
        return this.createSmtpDriver(config);
      case "ses":
        return this.createSesDriver(config);
      case "custom":
        return this.createCustomDriver(app, config.name);
    }
  }

  /** Allows applications to tune or replace the built-in SMTP composition. */
  protected createSmtpDriver(config: SmtpEmailDriverConfig): EmailDriver {
    return new EmailSdkEmailAdapter({
      adapter: smtp({
        host: config.host,
        secure: config.secure,
        requireTLS: config.requireTLS,
        allowInsecureAuth: config.allowInsecureAuth,
        timeoutMs: config.timeoutMs,
        ...(config.port === undefined ? {} : { port: config.port }),
        ...(config.auth === undefined
          ? {}
          : {
              auth: {
                user: config.auth.user,
                pass: config.auth.pass,
                ...(config.auth.method === undefined
                  ? {}
                  : { method: config.auth.method }),
              },
            }),
        ...(config.heloName === undefined
          ? {}
          : { heloName: config.heloName }),
      }),
    });
  }

  /** Allows applications to tune or replace the built-in SES composition. */
  protected createSesDriver(config: SesEmailDriverConfig): EmailDriver {
    return new EmailSdkEmailAdapter({
      adapter: ses({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region,
        charset: config.charset,
        ...(config.sessionToken === undefined
          ? {}
          : { sessionToken: config.sessionToken }),
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.configurationSetName === undefined
          ? {}
          : { configurationSetName: config.configurationSetName }),
      }),
    });
  }

  /** Handles `{ type: "custom" }` in an application-specific subclass. */
  protected createCustomDriver(
    _app: ProviderCompositionApp<Config>,
    name: string,
  ): EmailDriver {
    throw new Error(
      `Email driver "${name}" requires an EmailProvider subclass.`,
    );
  }

  /** Creates the configured capture storage and can be overridden by an app. */
  protected createCaptureStore(
    app: ProviderCompositionApp<Config>,
  ): EmailCaptureStore {
    if (this.config.capture.storage === "memory") {
      return new MemoryEmailCaptureStore();
    }

    const { pool } = app.container.resolve(
      dep<DatabaseClientDependency>("databaseClient"),
    );

    return new PostgresEmailCaptureStore(pool);
  }

  /** Builds one lifecycle-owned client from the configured driver. */
  protected createClient(app: ProviderCompositionApp<Config>): EmailClient {
    const observerContext = app.container.hasRegistration("observerContext")
      ? app.container.resolve(observerContextDependency)
      : undefined;
    const ambientInstrumentation: EmailInstrumentation | undefined =
      observerContext === undefined
        ? undefined
        : {
            record: (event) => {
              const observer = observerContext.get();

              if (observer !== undefined) {
                recordEmailInstrumentation(observer, event);
              }
            },
          };
    const instrumentation = combineInstrumentation(
      ambientInstrumentation,
      this.options.instrumentation,
    );

    return new EmailClient({
      name: this.config.name,
      driver: this.createDriver(app, this.config.driver),
      ...(instrumentation === undefined ? {} : { instrumentation }),
      ...(this.options.monotonicNow === undefined
        ? {}
        : { monotonicNow: this.options.monotonicNow }),
      ...(this.options.createObservationId === undefined
        ? {}
        : { createObservationId: this.options.createObservationId }),
    });
  }

  private registerCaptureServices(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      emailCaptureStoreDependency.id,
      () => this.createCaptureStore(app),
      { lifetime: "singleton" },
    );
    app.container.registerFactory(
      "emailCaptureInbox",
      () => new EmailCaptureInbox(
        app.container.resolve(emailCaptureStoreDependency),
        (message) => app.container.resolve(emailClientDependency).send(
          message,
          { operation: "studio.email.resend" },
        ),
      ),
      { lifetime: "singleton" },
    );
  }
}

function combineInstrumentation(
  first: EmailInstrumentation | undefined,
  second: EmailInstrumentation | undefined,
): EmailInstrumentation | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;

  return {
    record: (event) => {
      try {
        first.record(event);
      } catch {
        // One diagnostic sink cannot suppress another one.
      }

      try {
        second.record(event);
      } catch {
        // Diagnostics must never change email delivery semantics.
      }
    },
  };
}

/** PostgreSQL reports a missing relation with SQLSTATE 42P01. */
function isUndefinedTableError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "42P01";
}
