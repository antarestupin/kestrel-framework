import { createUuid } from "../utils/uuid.js";
import {
  createActionRunner,
  type Action,
  type ActionRunner,
} from "../actions/index.js";
import {
  DeferredTasks,
} from "../concurrency/index.js";
import {
  type DependencyContainer,
  type DependencyDeclarations,
  type ResolvedDependencies,
} from "../di/index.js";
import type { ZodType } from "zod";
import {
  DefaultErrorHandler,
  type ErrorHandler,
} from "../errors/index.js";
import type { EventBus } from "../events/index.js";
import {
  executionCompletedEvent,
  type ExecutionOutcome,
} from "./events.js";
import {
  ExecutionContext,
  sealExecutionContext,
} from "./execution_context.js";

/**
 * Exposes action binding without leaking the underlying DI container.
 */
export interface ActionExecution {
  readonly id: string;
  readonly context: ExecutionContext;
  readonly errorHandler: ErrorHandler;
  /** Work that must settle before this execution releases scoped resources. */
  readonly tasks: DeferredTasks;
  /** Event facade bound to this execution when it is application-owned. */
  readonly eventBus: EventBus | undefined;
  get<
    InputSchema extends ZodType,
    OutputSchema extends ZodType,
  >(
    action: Action<
      InputSchema,
      OutputSchema,
      // The concrete scope retains dependency config typing internally.
      any
    >,
  ): ActionRunner<InputSchema, OutputSchema>;
  /** Resolves definition dependencies without exposing the container. */
  resolveDependencies<
    const Declarations extends DependencyDeclarations<never>,
  >(
    declarations: Declarations,
  ): ResolvedDependencies<Declarations>;
}

/**
 * Owns the dependencies shared by one transport execution.
 *
 * HTTP requests and CLI commands create one execution scope and bind every
 * action they run to it.
 */
export class ExecutionScope<Config> implements ActionExecution {
  private disposePromise: Promise<void> | undefined;

  private readonly resolveDisposed: () => void;

  /** Resolves after the scoped bus and dependency container are released. */
  public readonly whenDisposed: Promise<void>;

  public constructor(
    public readonly container: DependencyContainer<Config>,
    public readonly id: string = createUuid(),
    public readonly errorHandler: ErrorHandler = new DefaultErrorHandler({
      debug: false,
    }),
    public readonly tasks: DeferredTasks = new DeferredTasks(),
    public readonly eventBus: EventBus | undefined = undefined,
    public readonly context: ExecutionContext = new ExecutionContext(),
  ) {
    let resolveDisposed = (): void => undefined;
    this.whenDisposed = new Promise<void>((resolve) => {
      resolveDisposed = resolve;
    });
    this.resolveDisposed = resolveDisposed;
  }

  /**
   * Binds an action runner to this execution's dependency scope.
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
    return createActionRunner(this.container, action);
  }

  /** Resolves dependencies needed by a definition invoked in this scope. */
  public resolveDependencies<
    const Declarations extends DependencyDeclarations<never>,
  >(
    declarations: Declarations,
  ): ResolvedDependencies<Declarations> {
    return this.container.resolveDependencies(
      declarations as unknown as DependencyDeclarations<Config>,
    ) as ResolvedDependencies<Declarations>;
  }

  /**
   * Releases scoped resources after the transport execution completes.
   */
  public dispose(outcome: ExecutionOutcome = "success"): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }

    this.disposePromise = this.finishAndDispose(outcome);

    return this.disposePromise;
  }

  /** Announces completion and drains deferred work before releasing resources. */
  private async finishAndDispose(outcome: ExecutionOutcome): Promise<void> {
    const errors: unknown[] = [];

    // Completion fixes entry membership, while copied diagnostic values remain
    // deterministic for asynchronous listeners and integrations.
    sealExecutionContext(this.context);

    try {
      try {
        if (this.eventBus !== undefined) {
          this.eventBus.dispatch(executionCompletedEvent, {
            executionId: this.id,
            outcome,
            context: this.context,
          });
        }
      } catch (error: unknown) {
        errors.push(error);
      }

      try {
        await this.tasks.close();
      } catch (error: unknown) {
        errors.push(error);
      }

      if (errors.length === 1) {
        throw errors[0];
      }

      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Execution completion failed.",
        );
      }
    } finally {
      this.eventBus?.close();

      try {
        await this.container.dispose();
      } finally {
        this.resolveDisposed();
      }
    }
  }
}
