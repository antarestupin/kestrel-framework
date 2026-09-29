import type { Pool } from "pg";

import type {
  Provider,
  ProviderBootApp,
  ProviderCompositionApp,
} from "../app/index.js";
import { dep } from "../di/index.js";
import { applicationLoggerDependency } from "../log/dependencies.js";
import { observerContextDependency } from "./dependencies.js";
import type { ObservationConfig } from "./configuration.js";
import { AsyncLocalObserverContext } from "./context.js";
import { PostgresObservationStore } from "./db/observation_store.js";
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

interface DatabaseClientDependency {
  pool: Pool;
}

interface ApplicationObservationResource<Config> {
  readonly recorder: ObservationRecorder;
  boot(app: ProviderBootApp<Config>): Promise<void>;
  close(): Promise<void>;
}

/** Declares observation infrastructure and prepares optional storage. */
export class ObservationProvider<Config> implements Provider<Config> {
  public constructor(protected readonly config: ObservationConfig) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "observationResource",
      () => this.createResource(),
      {
        lifetime: "singleton",
        dispose: (resource) => resource.close(),
      },
    );
    app.container.registerFactory<ObservationRecorder, {
      observationResource: ApplicationObservationResource<Config>;
    }>(
      "observationRecorder",
      ({ observationResource }) => observationResource.recorder,
      { lifetime: "singleton" },
    );
    app.container.registerFactory(
      "observerContext",
      () => new AsyncLocalObserverContext(),
      { lifetime: "singleton" },
    );
    app.container.registerFactory(
      "observer",
      ({ executionId, observationRecorder }: ScopedObserverDependencies) =>
        new ScopedObserver(executionId, observationRecorder),
      { lifetime: "scoped" },
    );

    if (this.config.enabled) {
      app.container.registerFactory<
        PostgresObservationStore,
        { databaseClient: DatabaseClientDependency }
      >(
        "observationSource",
        ({ databaseClient }) => this.createStore(databaseClient.pool),
        { lifetime: "singleton" },
      );
    }
  }

  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    await app.container.resolve(
      dep<ApplicationObservationResource<Config>>("observationResource"),
    ).boot(app);
  }

  /** Creates the persistent development observation store. */
  protected createStore(pool: Pool): PostgresObservationStore {
    return new PostgresObservationStore(pool);
  }

  /** Owns the backend behind recorders resolved by execution scopes. */
  protected createResource(): ApplicationObservationResource<Config> {
    const recorder = new DelegatingObservationRecorder();
    let active: ObservationRecorder | undefined;

    return {
      recorder,
      boot: async (app) => {
        if (
          active !== undefined
          || !this.config.enabled
          || app.bootPlan.runningMode === "minimal"
        ) {
          return;
        }

        const store = app.container.resolve(
          dep<PostgresObservationStore>("observationSource"),
        );

        try {
          await store.prepare(this.config.retentionDays);
        } catch (error: unknown) {
          // Optional development storage must not make local repair impossible.
          if (isUndefinedTableError(error)) {
            return;
          }

          throw error;
        }

        const observerContext = app.container.resolve(
          observerContextDependency,
        );
        const applicationLogger = app.container.resolve(
          applicationLoggerDependency,
        );

        active = new BufferedObservationRecorder({
          append: (events) => observerContext.run(
            undefined,
            () => store.append(events),
          ),
        }, {
          batchSize: this.config.buffer.batchSize,
          flushIntervalMs: this.config.buffer.flushIntervalMs,
          maxQueueSize: this.config.buffer.maxQueueSize,
          overflowPolicy: this.config.overflowPolicy,
          failurePolicy: this.config.failurePolicy,
          maxAttempts: this.config.retry.maxAttempts,
          initialRetryDelayMs: this.config.retry.initialDelayMs,
          maxRetryDelayMs: this.config.retry.maxDelayMs,
          onError: (error, context) => {
            applicationLogger.warn({
              err: error,
              observationRecorder: context,
            }, "Observation storage write failed");
          },
          onOverflow: (health) => {
            applicationLogger.warn({
              observationRecorder: health,
            }, "Observation recorder queue is full");
          },
        });
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

/** PostgreSQL reports a missing relation with SQLSTATE 42P01. */
function isUndefinedTableError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "42P01";
}
