import type { Provider, ProviderBootApp, ProviderCompositionApp } from "../app/index.js";
import { shutdownStartedEvent } from "../app/events.js";
import { dep, registerAdapter, type AdapterRegistration } from "../di/index.js";
import { observerContextDependency } from "../observability/index.js";
import { EmailCaptureInbox, type EmailCaptureStorageAdapter } from "./capture.js";
import { EmailClient } from "./client.js";
import type { EmailConfig } from "./configuration.js";
import type { EmailTransportAdapterDefinition } from "./adapter_definition.js";
import { emailCaptureStoreDependency, emailClientDependency } from "./dependencies.js";
import { recordEmailInstrumentation, type EmailInstrumentation } from "./observations.js";
import type { EmailTransportAdapter } from "./types.js";

export interface EmailProviderOptions {
  readonly instrumentation?: EmailInstrumentation;
  readonly monotonicNow?: () => number;
  readonly createObservationId?: () => string;
}

/** Composes delivery and optional capture persistence without selecting concrete backends. */
export class EmailProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly config: EmailConfig,
    private readonly adapter: EmailTransportAdapterDefinition,
    protected readonly options: EmailProviderOptions = {},
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    if (!this.config.enabled) return;
    let storage: AdapterRegistration<EmailCaptureStorageAdapter> | undefined;
    if (this.adapter.captureStorage !== undefined) {
      storage = registerAdapter(
        app.container,
        emailCaptureStoreDependency.id,
        this.adapter.captureStorage,
        undefined,
      );
      app.container.registerFactory(
        "emailCaptureInbox",
        () =>
          new EmailCaptureInbox(app.container.resolve(emailCaptureStoreDependency), (message) =>
            app.container
              .resolve(emailClientDependency)
              .send(message, { operation: "studio.email.resend" }),
          ),
        { lifetime: "singleton" },
      );
    }
    let client: EmailClient | undefined;
    const delivery = registerAdapter(app.container, "emailAdapter", this.adapter, this.config, {
      beforeDispose: async () => {
        await client?.close();
      },
    });
    // The inbox can resolve storage without ever resolving delivery. Close both
    // registrations explicitly, in dependency order, before borrowed connections.
    app.eventBus.listenAsync(shutdownStartedEvent, async () => {
      try {
        await delivery.dispose();
      } finally {
        await storage?.dispose();
      }
    });
    app.container.registerFactory(
      emailClientDependency.id,
      () => (client = this.createClient(app)),
      { lifetime: "singleton", dispose: (value) => value.close() },
    );
  }

  /** Initialize storage before delivery, and never open either in minimal mode. */
  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    if (!this.config.enabled || app.bootPlan.runningMode === "minimal") return;
    if (this.adapter.captureStorage !== undefined)
      await app.container
        .resolve(
          dep<AdapterRegistration<EmailCaptureStorageAdapter>>(
            `${emailCaptureStoreDependency.id}Registration`,
          ),
        )
        .boot();
    await app.container
      .resolve(dep<AdapterRegistration<EmailTransportAdapter>>("emailAdapterRegistration"))
      .boot();
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
      driver: app.container.resolve(dep<EmailTransportAdapter>("emailAdapter")),
      closeDriver: false,
      ...(instrumentation === undefined ? {} : { instrumentation }),
      ...(this.options.monotonicNow === undefined
        ? {}
        : { monotonicNow: this.options.monotonicNow }),
      ...(this.options.createObservationId === undefined
        ? {}
        : { createObservationId: this.options.createObservationId }),
    });
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
