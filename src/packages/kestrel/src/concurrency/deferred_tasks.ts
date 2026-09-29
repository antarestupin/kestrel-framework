export type DeferredTasksState = "open" | "closing" | "closed";

export interface DeferredTaskOptions {
  /** Optional diagnostic name exposed to the error reporter. */
  name?: string;
}

export interface DeferredTaskErrorContext {
  name?: string;
}

export interface DeferredTasksOptions {
  /** Reports a task failure as soon as it occurs. Reporter failures are contained. */
  onError?: (
    error: unknown,
    context: DeferredTaskErrorContext,
  ) => Promise<void> | void;
}

export type DeferredTask = () => PromiseLike<unknown> | unknown;

interface PendingTask {
  readonly name?: string;
}

interface IdleWaiter {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
}

/** Raised when work is registered after a deferred task group has closed. */
export class DeferredTasksClosedError extends Error {
  public constructor() {
    super("Cannot register a task in a closed deferred task group.");
    this.name = "DeferredTasksClosedError";
  }
}

/**
 * Tracks asynchronous work that must settle before owned resources are freed.
 *
 * The group is infrastructure-neutral: callers decide which lifetime it
 * represents, such as an execution, an application or another resource scope.
 */
export class DeferredTasks {
  private currentState: DeferredTasksState = "open";

  private readonly pendingTasks = new Set<PendingTask>();

  private readonly idleWaiters = new Set<IdleWaiter>();

  private errors: unknown[] = [];

  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly options: DeferredTasksOptions = {},
  ) {}

  /** Number of tasks that have not settled yet. */
  public get pendingCount(): number {
    return this.pendingTasks.size;
  }

  /** Current registration and lifetime state of this group. */
  public get state(): DeferredTasksState {
    return this.currentState;
  }

  /**
   * Schedules fire-and-forget work in a microtask and tracks it immediately.
   *
   * Returning no promise makes the ownership transfer explicit: failures are
   * observed by this group and surfaced at its next wait boundary.
   */
  public defer(
    task: DeferredTask,
    options: DeferredTaskOptions = {},
  ): void {
    this.assertAcceptingTasks();

    // Construct the promise before tracking but run the callback later. The
    // task is registered synchronously before any queued callback can execute.
    const promise = Promise.resolve().then(task);
    this.trackPromise(promise, options);
  }

  /**
   * Attaches an already-created promise to this group and preserves its result.
   */
  public track<Value>(
    promise: PromiseLike<Value>,
    options: DeferredTaskOptions = {},
  ): Promise<Value> {
    this.assertAcceptingTasks();

    return this.trackPromise(Promise.resolve(promise), options);
  }

  /**
   * Waits for quiescence while leaving the group open for a later work cycle.
   *
   * Tasks registered by pending tasks are included. Errors accumulated since
   * the previous completed wait boundary are consumed by this boundary.
   */
  public wait(): Promise<void> {
    if (this.pendingTasks.size === 0) {
      return this.consumeErrors();
    }

    return new Promise<void>((resolve, reject) => {
      this.idleWaiters.add({ resolve, reject });
    });
  }

  /**
   * Waits for quiescence and permanently prevents subsequent registration.
   *
   * Work may still register child tasks while closing, until the tracked task
   * count reaches zero. Repeated close calls share the same result.
   */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    if (this.currentState === "closed") {
      return Promise.resolve();
    }

    this.currentState = "closing";

    if (this.pendingTasks.size === 0) {
      // Close the admission window synchronously so a caller cannot register
      // work between this call and the promise continuation below.
      this.currentState = "closed";
      this.closePromise = this.consumeErrors();
      void this.closePromise.catch(() => undefined);

      return this.closePromise;
    }

    this.closePromise = this.wait().finally(() => {
      this.currentState = "closed";
    });

    // The returned promise may be intentionally left to an owning container.
    // Observing it here prevents an unhandled rejection without changing what
    // callers receive when they await the same promise.
    void this.closePromise.catch(() => undefined);

    return this.closePromise;
  }

  private trackPromise<Value>(
    promise: Promise<Value>,
    options: DeferredTaskOptions,
  ): Promise<Value> {
    const pendingTask: PendingTask = options.name === undefined
      ? {}
      : { name: options.name };

    this.pendingTasks.add(pendingTask);

    const trackedPromise = promise.then(
      (value) => {
        this.settleTask(pendingTask);
        return value;
      },
      (error: unknown) => {
        this.errors.push(error);
        this.reportError(error, pendingTask);
        this.settleTask(pendingTask);
        throw error;
      },
    );

    // A tracked promise keeps its rejection semantics for consumers, while
    // this internal observer makes ignoring the returned promise safe.
    void trackedPromise.catch(() => undefined);

    return trackedPromise;
  }

  private settleTask(task: PendingTask): void {
    this.pendingTasks.delete(task);

    if (this.pendingTasks.size !== 0) {
      return;
    }

    // Reaching zero is the atomic closing boundary. Marking the group closed
    // before resolving waiters prevents new work from slipping into the gap.
    if (this.currentState === "closing") {
      this.currentState = "closed";
    }

    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();

    if (waiters.length === 0) {
      return;
    }

    const error = this.takeError();

    for (const waiter of waiters) {
      if (error === undefined) {
        waiter.resolve();
      } else {
        waiter.reject(error);
      }
    }
  }

  private consumeErrors(): Promise<void> {
    const error = this.takeError();

    return error === undefined
      ? Promise.resolve()
      : Promise.reject(error);
  }

  private takeError(): unknown | undefined {
    if (this.errors.length === 0) {
      return undefined;
    }

    const errors = this.errors;
    this.errors = [];

    return errors.length === 1
      ? errors[0]
      : new AggregateError(
          errors,
          "Multiple deferred tasks failed.",
        );
  }

  private reportError(error: unknown, task: PendingTask): void {
    if (this.options.onError === undefined) {
      return;
    }

    const context: DeferredTaskErrorContext = task.name === undefined
      ? {}
      : { name: task.name };

    try {
      const reporting = this.options.onError(error, context);

      // Error reporting is deliberately outside the tracked workload. A
      // broken reporter must not extend the lifetime or replace task errors.
      void Promise.resolve(reporting).catch(() => undefined);
    } catch {
      // Synchronous reporter failures are contained for the same reason.
    }
  }

  private assertAcceptingTasks(): void {
    if (this.currentState === "closed") {
      throw new DeferredTasksClosedError();
    }
  }
}
