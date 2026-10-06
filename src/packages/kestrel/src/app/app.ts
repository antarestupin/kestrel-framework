import { uuidV7 } from "../utils/uuid.js";
import {
  type Action,
  type ActionRunner,
} from "../actions/index.js";
import {
  DeferredTasks,
} from "../concurrency/index.js";
import {
  createDependencyContainer,
  dep,
  type DependencyContainer,
  type DependencyDeclarations,
} from "../di/index.js";
import { DefinitionRegistry } from "../definitions/index.js";
import {
  EventBus,
  eventBusDependency,
  type EventBusOptions,
} from "../events/index.js";
import type { ZodType } from "zod";
import { ExecutionScope } from "./execution_scope.js";
import {
  AppCatalog,
  type AppCatalogDeclaration,
} from "./catalog.js";
import {
  DefaultErrorHandler,
  errorHandlerDependency,
} from "../errors/index.js";
import {
  observationRecorderDependency,
  observerContextDependency,
  observerDependency,
  type Observer,
} from "../observability/index.js";
import {
  executionCompletedObservation,
  executionStartedObservation,
  getExecutionObservationError,
  getExecutionObservationContext,
  setExecutionLogContext,
} from "./observations.js";
import {
  applicationStartedEvent,
  bootstrapCompletedEvent,
  bootstrapStartedEvent,
  executionStartedEvent,
  runtimeStartedEvent,
  runtimeStoppingEvent,
  shutdownCompletedEvent,
  shutdownStartedEvent,
} from "./events.js";
import type { HttpExtension } from "../http/extension.js";
import {
  ExecutionContext,
  type ExecutionContextOptions,
} from "./execution_context.js";
import type { AppWorkload } from "./workloads.js";
export type { AppWorkload } from "./workloads.js";

export type AppRunningMode = "standard" | "minimal";
export type AppRuntime =
  | "background"
  | "command"
  | "scheduled-tasks"
  | "server"
  | "worker"
  | "workflow";

/** Immutable view of the workloads and infrastructure selected at boot. */
export interface AppBootPlan {
  readonly workloads: readonly AppWorkload[];
  readonly runningMode: AppRunningMode;
  readonly runtime: AppRuntime;
}

interface MutableAppBootPlan {
  workloads: AppWorkload[];
  runningMode: AppRunningMode;
  runtime: AppRuntime;
}

interface AppStartupStepTiming {
  durationMs: number;
  provider: string;
}

export type AppState =
  | "composing"
  | "bootstrapping"
  | "ready"
  | "running"
  | "stopping"
  | "shuttingDown"
  | "disposed"
  | "failed";

/** Internal storage shared by the application lifecycle transitions. */
interface AppLifecycleContext<Config> {
  activeExecutions: Set<ExecutionScope<Config>>;
  currentState: AppState;
  providers: Provider<Config>[];
  bootPlan: MutableAppBootPlan;
  disposePromise?: Promise<void>;
  startPromise?: Promise<void>;
  stopPromise?: Promise<void>;
}

/** Optional infrastructure and catalog inputs used to construct an app. */
export interface AppOptions<
  Config,
  Catalog extends AppCatalogDeclaration,
> {
  readonly catalog?: Catalog;
  readonly container?: DependencyContainer<Config>;
  readonly eventBus?: EventBusOptions;
  readonly executionContext?: ExecutionContextOptions;
}

/** Runtime capabilities providers may hand to transport infrastructure. */
export type RuntimeApp<Config> = Pick<
  App<Config>,
  | "catalog"
  | "container"
  | "createExecutionScope"
  | "httpExtensions"
  | "runInObservationContext"
  | "start"
  | "state"
  | "stop"
>;

/** Capabilities available while a provider contributes application structure. */
export type ProviderCompositionApp<Config> = Pick<
  App<Config>,
  "catalog" | "config" | "container" | "eventBus" | "httpExtensions"
> & {
  /** Lifecycle access reserved for transport infrastructure constructed here. */
  readonly runtime: RuntimeApp<Config>;
};

/** Capabilities available while a provider initializes registered resources. */
export type ProviderBootApp<Config> = Pick<
  App<Config>,
  "bootPlan" | "container"
>;

export interface Provider<Config> {
  /**
   * Contributes configuration and services to an application instance.
   */
  register: (app: ProviderCompositionApp<Config>) => void;
  /** Initializes dependencies after every provider has been registered. */
  boot?: (app: ProviderBootApp<Config>) => Promise<void> | void;
}

/**
 * Central composition point for an application.
 *
 * The application owns its resolved configuration, dependency container and
 * the resources registered by its providers.
 */
export class App<
  Config,
  Catalog extends AppCatalogDeclaration = AppCatalogDeclaration,
> {
  /** Captures construction and provider registration as one composition phase. */
  private readonly compositionStartedAt = performance.now();

  /** Preserves per-provider timings until the single startup summary is emitted. */
  private readonly compositionStepTimings: AppStartupStepTiming[] = [];

  private readonly bootStepTimings: AppStartupStepTiming[] = [];

  public readonly container: DependencyContainer<Config>;

  public readonly eventBus: EventBus;

  public readonly tasks: DeferredTasks;

  /** Typed declaration and consolidated runtime definition indexes. */
  public readonly catalog: AppCatalog<Catalog>;

  /** Fastify integrations mounted only by the HTTP runtime. */
  public readonly httpExtensions = new DefinitionRegistry<HttpExtension<Config>>();

  private readonly lifecycle: AppLifecycleContext<Config>;

  private readonly executionContextOptions: ExecutionContextOptions;

  /** Current application lifecycle state. */
  public get state(): AppState {
    return this.lifecycle.currentState;
  }

  /** Workloads and running mode finalized before bootstrap begins. */
  public get bootPlan(): AppBootPlan {
    return this.lifecycle.bootPlan;
  }

  public constructor(
    public readonly config: Config,
    options: AppOptions<Config, Catalog> = {},
  ) {
    // Snapshot primitive limits so later caller mutation cannot affect scopes.
    this.executionContextOptions = Object.freeze({
      ...options.executionContext,
    });
    this.container = options.container ?? createDependencyContainer(config);
    this.tasks = this.container.hasRegistration("deferredTasks")
      ? this.container.resolve(dep<DeferredTasks>("deferredTasks"))
      : new DeferredTasks();
    this.eventBus = this.container.hasRegistration("eventBus")
      ? this.container.resolve(eventBusDependency)
      : new EventBus(options.eventBus, this.tasks);
    this.lifecycle = {
      activeExecutions: new Set(),
      currentState: "composing",
      providers: [],
      bootPlan: {
        workloads: [],
        runningMode: "standard",
        runtime: "command",
      },
    };
    this.catalog = new AppCatalog(
      options.catalog ?? {} as Catalog,
      () => this.lifecycle.currentState === "composing",
    );

    if (!this.container.hasRegistration("deferredTasks")) {
      this.container.registerValue("deferredTasks", this.tasks);
    }

    if (!this.container.hasRegistration("eventBus")) {
      this.container.registerValue("eventBus", this.eventBus);
    }

    if (!this.container.hasRegistration("bootPlan")) {
      this.container.registerValue<AppBootPlan>(
        "bootPlan",
        this.lifecycle.bootPlan,
      );
    }

    if (!this.container.hasRegistration("errorHandler")) {
      // Applications can replace this safe default during provider composition.
      this.container.registerValue(
        "errorHandler",
        new DefaultErrorHandler({ debug: false }),
      );
    }
  }

  /**
   * Applies a provider and returns this application for fluent composition.
   */
  public register(provider: Provider<Config>): this {
    if (this.lifecycle.currentState !== "composing") {
      throw new Error("Providers can only be registered during composition.");
    }

    const startedAt = performance.now();

    try {
      provider.register({
        catalog: this.catalog,
        config: this.config,
        container: this.container,
        eventBus: this.eventBus,
        httpExtensions: this.httpExtensions,
        runtime: this,
      });
      this.lifecycle.providers.push(provider);
    } finally {
      this.compositionStepTimings.push({
        durationMs: this.getDuration(startedAt),
        provider: this.getProviderName(provider),
      });
    }

    return this;
  }

  /**
   * Binds an action to this application's dependency container.
   */
  public get<
    InputSchema extends ZodType,
    OutputSchema extends ZodType,
    const Dependencies extends DependencyDeclarations<Config>,
  >(
    action: Action<
      InputSchema,
      OutputSchema,
      Dependencies
    >,
  ): ActionRunner<InputSchema, OutputSchema> {
    return {
      run: async (input) => {
        await this.start();
        const execution = await this.createExecutionScope();
        setExecutionLogContext(execution.context, {
          operation: action.name,
          transport: "direct",
        });
        const observer = this.resolveObserver(execution.container);
        const startedAt = performance.now();
        let outcome: "failure" | "success" = "success";
        let executionError: unknown;

        return this.runInObservationContext(observer, async () => {
          observer?.record(executionStartedObservation, {
            operation: action.name,
            transport: "direct",
          });

          try {
            return await execution.get(action).run(input);
          } catch (error: unknown) {
            outcome = "failure";
            executionError = error;
            throw error;
          } finally {
            observer?.record(
              executionCompletedObservation,
              {
                operation: action.name,
                transport: "direct",
                ...getExecutionObservationContext(execution.context),
                ...(executionError === undefined
                  ? {}
                  : getExecutionObservationError(executionError)),
              },
              {
                outcome,
                durationMs: performance.now() - startedAt,
              },
            );
            await execution.dispose(outcome);
          }
        });
      },
    };
  }

  /**
   * Creates the dependency scope shared by one request, command or direct run.
   */
  public async createExecutionScope(
    id?: string,
  ): Promise<ExecutionScope<Config>> {
    if (this.lifecycle.currentState !== "running") {
      throw new Error(
        `Cannot create an execution while the application is ${this.lifecycle.currentState}.`,
      );
    }

    const container = this.container.createScope();
    const executionId = id ?? uuidV7();
    const tasks = new DeferredTasks();
    const context = new ExecutionContext(this.executionContextOptions);

    // Correlation is part of every execution context, independently of which
    // transports or optional integrations resolve scoped dependencies.
    context.setDiagnostic("executionId", executionId);
    const eventBus = this.eventBus.createScope(
      { id: executionId, kind: "execution" },
      tasks,
    );

    // Register the id before resolving scoped services such as loggers and the
    // error handler, which may use it for correlation.
    container.registerValue("executionId", executionId);
    container.registerValue("executionContext", context);
    container.registerValue("deferredTasks", tasks);
    container.registerValue("eventBus", eventBus);
    const errorHandler = container.resolve(errorHandlerDependency);
    const execution = new ExecutionScope(
      container,
      executionId,
      errorHandler,
      tasks,
      eventBus,
      context,
    );

    // Context values let scoped dependencies correlate work without knowing
    // which transport owns the execution.
    container.registerValue("execution", execution);
    this.lifecycle.activeExecutions.add(execution);
    void execution.whenDisposed.then(() => {
      this.lifecycle.activeExecutions.delete(execution);
    });

    try {
      eventBus.dispatch(executionStartedEvent, { executionId });
      await tasks.wait();

      return execution;
    } catch (error: unknown) {
      // A failed start still completes the scope as cancelled so shutdown does
      // not retain it and scoped resources are released deterministically.
      await execution.dispose("cancelled").catch(() => undefined);
      throw error;
    }
  }

  /** Completes bootstrap and opens the application runtime. */
  public start(): Promise<void> {
    if (this.lifecycle.startPromise !== undefined) {
      return this.lifecycle.startPromise;
    }

    if (this.lifecycle.currentState !== "composing") {
      return Promise.reject(new Error(
        `Cannot start an application while it is ${this.lifecycle.currentState}.`,
      ));
    }

    this.lifecycle.startPromise = this.finishStart();

    return this.lifecycle.startPromise;
  }

  /** Runs each startup transition and waits for its deferred listeners. */
  private async finishStart(): Promise<void> {
    const compositionDurationMs = this.getDuration(this.compositionStartedAt);
    const bootStartedAt = performance.now();

    try {
      this.lifecycle.currentState = "bootstrapping";
      this.eventBus.dispatch(bootstrapStartedEvent, {});
      await this.tasks.wait();

      // Provider order is the explicit infrastructure dependency order.
      for (const provider of this.lifecycle.providers) {
        if (provider.boot !== undefined) {
          const startedAt = performance.now();

          try {
            await provider.boot({
              bootPlan: this.bootPlan,
              container: this.container,
            });
          } finally {
            this.bootStepTimings.push({
              durationMs: this.getDuration(startedAt),
              provider: this.getProviderName(provider),
            });
          }
        }
      }

      this.eventBus.dispatch(bootstrapCompletedEvent, {});
      await this.tasks.wait();

      this.lifecycle.currentState = "ready";
      this.eventBus.dispatch(runtimeStartedEvent, {});
      await this.tasks.wait();
      this.lifecycle.currentState = "running";

      const bootstrapDurationMs = this.getDuration(bootStartedAt);

      // The active logging provider can now emit one complete startup summary.
      this.eventBus.dispatch(applicationStartedEvent, {
        runtime: this.bootPlan.runtime,
        durations: {
          bootstrapMs: bootstrapDurationMs,
          compositionMs: compositionDurationMs,
          totalMs: this.getDuration(this.compositionStartedAt),
          providers: {
            boot: this.bootStepTimings,
            composition: this.compositionStepTimings,
          },
        },
      });
      await this.tasks.wait();
    } catch (error: unknown) {
      this.lifecycle.currentState = "failed";
      throw error;
    }
  }

  /** Returns compact millisecond values suitable for structured logs. */
  private getDuration(startedAt: number): number {
    return Number((performance.now() - startedAt).toFixed(2));
  }

  /** Identifies class-based providers while retaining an anonymous fallback. */
  private getProviderName(provider: Provider<Config>): string {
    return provider.constructor.name || "AnonymousProvider";
  }

  /** Finalizes the workload and infrastructure selection before bootstrap. */
  public prepareBootPlan(
    workloads: readonly AppWorkload[],
    runningMode: AppRunningMode = "standard",
    runtime: AppRuntime = "command",
  ): void {
    if (this.lifecycle.currentState !== "composing") {
      throw new Error("The boot plan must be selected during composition.");
    }

    this.lifecycle.bootPlan.workloads.splice(
      0,
      this.lifecycle.bootPlan.workloads.length,
      ...new Set(workloads),
    );
    this.lifecycle.bootPlan.runningMode = runningMode;
    this.lifecycle.bootPlan.runtime = runtime;
  }

  /** Stops admission of new executions before transport-specific draining. */
  public stop(): Promise<void> {
    if (this.lifecycle.stopPromise !== undefined) {
      return this.lifecycle.stopPromise;
    }

    if (this.lifecycle.currentState !== "running") {
      return Promise.resolve();
    }

    this.lifecycle.currentState = "stopping";
    this.lifecycle.stopPromise = (async () => {
      this.eventBus.dispatch(runtimeStoppingEvent, {});
      await this.tasks.wait();
    })();

    return this.lifecycle.stopPromise;
  }

  /**
   * Releases resources owned by the application's dependency container.
   */
  public async dispose(): Promise<void> {
    if (this.lifecycle.disposePromise === undefined) {
      this.lifecycle.disposePromise = this.finishAndDispose();
    }

    await this.lifecycle.disposePromise;
  }

  /** Drains application work before shared resources are released. */
  private async finishAndDispose(): Promise<void> {
    const errors: unknown[] = [];

    try {
      if (
        this.lifecycle.startPromise !== undefined
        && (
          this.lifecycle.currentState === "bootstrapping"
          || this.lifecycle.currentState === "ready"
        )
      ) {
        try {
          await this.lifecycle.startPromise;
        } catch (error: unknown) {
          errors.push(error);
        }
      }

      try {
        await this.stop();
      } catch (error: unknown) {
        errors.push(error);
      }

      this.lifecycle.currentState = "shuttingDown";
      // Runtime owners finish their scopes; the application only waits for
      // them here so shared dependencies remain alive throughout cleanup.
      await Promise.all(
        [...this.lifecycle.activeExecutions]
          .map((execution) => execution.whenDisposed),
      );
      await this.runShutdownBoundary(shutdownStartedEvent, errors);

      if (this.container.hasRegistration("observationRecorder")) {
        // Flush while shared infrastructure such as the database is available.
        try {
          await this.container.resolve(observationRecorderDependency).flush();
        } catch (error: unknown) {
          errors.push(error);
        }
      }

      try {
        this.eventBus.dispatch(shutdownCompletedEvent, {});
      } catch (error: unknown) {
        errors.push(error);
      }

      try {
        // This final boundary waits for completion listeners and seals task
        // registration before shared application resources are destroyed.
        await this.tasks.close();
      } catch (error: unknown) {
        errors.push(error);
      }
    } finally {
      this.eventBus.close();

      try {
        await this.container.dispose();
      } catch (error: unknown) {
        errors.push(error);
      }

      this.lifecycle.currentState = "disposed";
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, "Application shutdown failed.");
    }
  }

  /** Runs one shutdown event while preserving later cleanup on failure. */
  private async runShutdownBoundary(
    event: typeof shutdownStartedEvent,
    errors: unknown[],
  ): Promise<void> {
    try {
      this.eventBus.dispatch(event, {});
    } catch (error: unknown) {
      errors.push(error);
    }

    try {
      await this.tasks.wait();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  /** Runs work with an observer visible to singleton instrumentation hooks. */
  public runInObservationContext<Value>(
    observer: Observer | undefined,
    callback: () => Value,
  ): Value {
    return this.container.hasRegistration("observerContext")
      ? this.container.resolve(observerContextDependency).run(
          observer,
          callback,
        )
      : callback();
  }

  /** Resolves optional instrumentation without requiring it in bare apps. */
  private resolveObserver(
    container: DependencyContainer<Config>,
  ): Observer | undefined {
    return container.hasRegistration("observer")
      ? container.resolve(observerDependency)
      : undefined;
  }
}
