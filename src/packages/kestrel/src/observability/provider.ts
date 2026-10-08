import { registerProviderAdapter } from "../app/adapter.js";
import type { ObservationAdapterDefinition, ObservationAdapter } from "./adapter_definition.js";
import type { AdapterRegistration } from "../di/index.js";

import type { Provider, ProviderBootApp, ProviderCompositionApp } from "../app/index.js";
import { dep } from "../di/index.js";
import { applicationLoggerDependency } from "../log/dependencies.js";
import { observerContextDependency } from "./dependencies.js";
import type { ObservationConfig } from "./configuration.js";
import { AsyncLocalObserverContext } from "./context.js";

import {
  DelegatingObservationRecorder,
  ScopedObserver,
  type ObservationRecorder,
} from "./observer.js";
import { BufferedObservationRecorder } from "./recorder.js";

interface ScopedObserverDependencies {
  executionId: string;
  observationRecorder: ObservationRecorder;
}

interface ApplicationObservationResource<Config> {
  readonly recorder: ObservationRecorder;
  boot(app: ProviderBootApp<Config>): Promise<void>;
  close(): Promise<void>;
}

/** Declares observation infrastructure and prepares optional storage. */
export class ObservationProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly config: ObservationConfig,
    private readonly adapter: ObservationAdapterDefinition,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    let resource: ApplicationObservationResource<Config> | undefined;
    if (this.config.enabled)
      registerProviderAdapter(app, "observationAdapter", this.adapter, undefined, {
        beforeDispose: async () => {
          await resource?.close();
        },
        validate: (value) => {
          if (this.adapter.capabilities.query !== (value.source !== undefined))
            throw new TypeError("Observation query capability does not match its implementation.");
        },
      });
    app.container.registerFactory("observationResource", () => (resource = this.createResource()), {
      lifetime: "singleton",
      dispose: (resource) => resource.close(),
    });
    app.container.registerFactory<
      ObservationRecorder,
      {
        observationResource: ApplicationObservationResource<Config>;
      }
    >("observationRecorder", ({ observationResource }) => observationResource.recorder, {
      lifetime: "singleton",
    });
    app.container.registerFactory("observerContext", () => new AsyncLocalObserverContext(), {
      lifetime: "singleton",
    });
    app.container.registerFactory(
      "observer",
      ({ executionId, observationRecorder }: ScopedObserverDependencies) =>
        new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );

    if (this.config.enabled && this.adapter.capabilities.query) {
      app.container.registerFactory(
        "observationSource",
        ({ observationAdapter }: { observationAdapter: ObservationAdapter }) =>
          observationAdapter.source!,
        { lifetime: "singleton" },
      );
    }
  }

  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    await app.container
      .resolve(dep<ApplicationObservationResource<Config>>("observationResource"))
      .boot(app);
  }

  /** Owns the backend behind recorders resolved by execution scopes. */
  protected createResource(): ApplicationObservationResource<Config> {
    const recorder = new DelegatingObservationRecorder();
    let active: ObservationRecorder | undefined;

    return {
      recorder,
      boot: async (app) => {
        if (
          active !== undefined ||
          !this.config.enabled ||
          app.bootPlan.runningMode === "minimal"
        ) {
          return;
        }

        const registration = app.container.resolve(
          dep<AdapterRegistration<ObservationAdapter>>("observationAdapterRegistration"),
        );
        await registration.boot();
        const backend = registration.get();
        if (backend.available === false) return;
        const store = backend.writer;

        const observerContext = app.container.resolve(observerContextDependency);
        const applicationLogger = app.container.resolve(applicationLoggerDependency);

        active = new BufferedObservationRecorder(
          {
            append: (events) => observerContext.run(undefined, () => store.append(events)),
          },
          {
            batchSize: this.config.buffer.batchSize,
            flushIntervalMs: this.config.buffer.flushIntervalMs,
            maxQueueSize: this.config.buffer.maxQueueSize,
            overflowPolicy: this.config.overflowPolicy,
            failurePolicy: this.config.failurePolicy,
            maxAttempts: this.config.retry.maxAttempts,
            initialRetryDelayMs: this.config.retry.initialDelayMs,
            maxRetryDelayMs: this.config.retry.maxDelayMs,
            onError: (error, context) => {
              applicationLogger.warn(
                {
                  err: error,
                  observationRecorder: context,
                },
                "Observation storage write failed",
              );
            },
            onOverflow: (health) => {
              applicationLogger.warn(
                {
                  observationRecorder: health,
                },
                "Observation recorder queue is full",
              );
            },
          },
        );
        recorder.use(active);
      },
      close: async () => {
        if (active !== undefined) {
          recorder.clear(active);
          await active.close();
          active = undefined;
        }
      },
    };
  }
}
