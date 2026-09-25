import { DeferredTasks } from "../concurrency/index.js";
import type {
  AnyEventDefinition,
  EventDefinition,
  EventInput,
  EventPayload,
} from "./event.js";
import { eventListenerFailed } from "./event.js";
import type { ZodType } from "zod";

/** Event bus construction options reserved for future process-local policies. */
export type EventBusOptions = Readonly<Record<never, never>>;

export interface EventScopeOptions {
  id: string;
  kind: string;
}

/** Immutable identity in the hierarchy shared by every bound event bus. */
export interface EventScope extends EventScopeOptions {
  readonly parent?: EventScope;
}

export type EventListenerScope = "exact" | "descendants";

export interface EventListenOptions {
  /** Selects this exact scope or this scope together with all descendants. */
  scope?: EventListenerScope;
}

export interface EventListenerContext {
  /** Scope from which this event was dispatched. */
  readonly scope: EventScope;
}

/** A synchronous listener invoked directly during dispatch. */
export type EventListener<Event extends AnyEventDefinition> = (
  payload: EventPayload<Event>,
  context: EventListenerContext,
) => void;

/** An asynchronous listener owned by the bound event scope. */
export type AsyncEventListener<Event extends AnyEventDefinition> = (
  payload: EventPayload<Event>,
  context: EventListenerContext,
) => PromiseLike<void>;

/** Removes a listener from its event bus. Calling it repeatedly is safe. */
export type StopListening = () => void;

interface RegisteredListener {
  readonly callback: (
    payload: unknown,
    context: EventListenerContext,
  ) => PromiseLike<void> | void;
  readonly asynchronous: boolean;
  readonly owner: EventBus;
  readonly scope: EventScope;
  readonly scopeSelection: EventListenerScope;
  once: boolean;
}

interface EventBusEngine {
  readonly closedScopes: WeakSet<EventScope>;
  readonly listeners: Map<AnyEventDefinition, Set<RegisteredListener>>;
}

/**
 * A scope-bound facade over one process-local event registry.
 *
 * Child buses share listeners with their parent while retaining their own
 * scope identity and deferred task lifetime.
 */
export class EventBus {
  private readonly engine: EventBusEngine;

  private readonly ownedListeners = new Set<RegisteredListener>();

  private closed = false;

  private readonly scopeNode: EventScope;

  public get scope(): EventScope {
    return this.scopeNode;
  }

  public constructor(
    _options: EventBusOptions = {},
    private readonly deferredTasks: DeferredTasks = new DeferredTasks(),
    scope: EventScopeOptions = { id: "app", kind: "app" },
    engine?: EventBusEngine,
    parentScope?: EventScope,
  ) {
    this.engine = engine ?? {
      closedScopes: new WeakSet(),
      listeners: new Map(),
    };
    this.scopeNode = parentScope === undefined
      ? { ...scope }
      : { ...scope, parent: parentScope };
  }

  /** Creates a child facade sharing this bus's registry. */
  public createScope(
    scope: EventScopeOptions,
    deferredTasks: DeferredTasks = this.deferredTasks,
  ): EventBus {
    this.assertOpen();

    return new EventBus(
      {},
      deferredTasks,
      scope,
      this.engine,
      this.scopeNode,
    );
  }

  /** Registers a synchronous listener. */
  public listen<Schema extends ZodType>(
    event: EventDefinition<Schema>,
    listener: EventListener<EventDefinition<Schema>>,
    options: EventListenOptions = {},
  ): StopListening {
    return this.addListener(event, listener, false, options);
  }

  /** Registers a synchronous listener removed before its first invocation. */
  public listenOnce<Schema extends ZodType>(
    event: EventDefinition<Schema>,
    listener: EventListener<EventDefinition<Schema>>,
    options: EventListenOptions = {},
  ): StopListening {
    return this.addListener(event, listener, true, options);
  }

  /** Registers asynchronous work in the deferred tasks bound to this scope. */
  public listenAsync<Schema extends ZodType>(
    event: EventDefinition<Schema>,
    listener: AsyncEventListener<EventDefinition<Schema>>,
    options: EventListenOptions = {},
  ): StopListening {
    return this.addAsyncListener(event, listener, false, options);
  }

  /** Registers one asynchronous listener owned by this scope. */
  public listenOnceAsync<Schema extends ZodType>(
    event: EventDefinition<Schema>,
    listener: AsyncEventListener<EventDefinition<Schema>>,
    options: EventListenOptions = {},
  ): StopListening {
    return this.addAsyncListener(event, listener, true, options);
  }

  /** Resolves with the next parsed payload dispatched in the selected scope. */
  public waitFor<Schema extends ZodType>(
    event: EventDefinition<Schema>,
    options: EventListenOptions = {},
  ): Promise<EventPayload<EventDefinition<Schema>>> {
    return new Promise((resolve) => {
      this.listenOnce(event, (payload) => resolve(payload), options);
    });
  }

  /**
   * Validates the payload and invokes every matching listener immediately.
   *
   * Asynchronous listeners register their work before this method returns.
   * Synchronous listener failures stop dispatch and are propagated directly.
   */
  public dispatch<Schema extends ZodType>(
    event: EventDefinition<Schema>,
    payload: EventInput<EventDefinition<Schema>>,
  ): void {
    this.assertOpen();
    const parsedPayload = event.schema.parse(payload);
    const listeners = this.takeListenerSnapshot(event);
    const context: EventListenerContext = { scope: this.scopeNode };

    for (const listener of listeners) {
      try {
        if (listener.asynchronous) {
          // Dispatch owns asynchronous listener work so an ancestor observing
          // a child still extends the child scope's resource lifetime.
          this.deferredTasks.defer(async () => {
            try {
              await listener.callback(parsedPayload, context);
            } catch (error: unknown) {
              if ((event as AnyEventDefinition) === eventListenerFailed) {
                return;
              }

              this.reportListenerFailure(event, error);
              throw error;
            }
          }, { name: `event:${event.name}` });
        } else {
          const result = listener.callback(parsedPayload, context);

          if (isPromiseLike(result)) {
            // TypeScript permits promise-returning functions in void callback
            // positions, so enforce the synchronous API contract at runtime.
            void Promise.resolve(result).catch(() => undefined);
            throw new Error(
              `Async listener registered for event "${event.name}" with listen(); use listenAsync() instead.`,
            );
          }
        }
      } catch (error: unknown) {
        this.reportListenerFailure(event, error);
        throw error;
      }
    }
  }

  /** Waits for all asynchronous listener work currently owned by this scope. */
  public wait(): Promise<void> {
    this.assertOpen();

    return this.deferredTasks.wait();
  }

  /** Removes every listener registered through this bound facade. */
  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.engine.closedScopes.add(this.scopeNode);

    // Closing a scope also retires listeners owned by its descendants. This
    // prevents optional child scopes from outliving an execution accidentally.
    for (const listeners of this.engine.listeners.values()) {
      for (const listener of [...listeners]) {
        if (
          listener.scope === this.scopeNode
          || isDescendantOf(listener.scope, this.scopeNode)
        ) {
          this.removeListener(listener);
        }
      }
    }
  }

  private addAsyncListener<Schema extends ZodType>(
    event: EventDefinition<Schema>,
    listener: AsyncEventListener<EventDefinition<Schema>>,
    once: boolean,
    options: EventListenOptions,
  ): StopListening {
    return this.addListener(event, listener, once, options, true);
  }

  private addListener<Schema extends ZodType>(
    event: EventDefinition<Schema>,
    listener:
      | AsyncEventListener<EventDefinition<Schema>>
      | EventListener<EventDefinition<Schema>>,
    once: boolean,
    options: EventListenOptions,
    asynchronous = false,
  ): StopListening {
    this.assertOpen();
    const listeners = this.getOrCreateListeners(event);
    const registered: RegisteredListener = {
      callback: listener as RegisteredListener["callback"],
      asynchronous,
      once,
      owner: this,
      scope: this.scopeNode,
      scopeSelection: options.scope ?? "exact",
    };

    listeners.add(registered);
    this.ownedListeners.add(registered);

    return () => this.removeListener(registered, event);
  }

  private takeListenerSnapshot(
    event: AnyEventDefinition,
  ): readonly RegisteredListener[] {
    const listeners = this.engine.listeners.get(event);

    if (listeners === undefined) {
      return [];
    }

    const snapshot = [...listeners].filter((listener) =>
      listener.scope === this.scopeNode
      || (
        listener.scopeSelection === "descendants"
        && isDescendantOf(this.scopeNode, listener.scope)
      )
    );

    for (const listener of snapshot) {
      if (listener.once) {
        this.removeListener(listener, event);
      }
    }

    return snapshot;
  }

  private getOrCreateListeners(
    event: AnyEventDefinition,
  ): Set<RegisteredListener> {
    const current = this.engine.listeners.get(event);

    if (current !== undefined) {
      return current;
    }

    const listeners = new Set<RegisteredListener>();
    this.engine.listeners.set(event, listeners);

    return listeners;
  }

  private removeListener(
    listener: RegisteredListener,
    knownEvent?: AnyEventDefinition,
  ): void {
    listener.owner.ownedListeners.delete(listener);
    const entries = knownEvent === undefined
      ? this.engine.listeners.entries()
      : [[knownEvent, this.engine.listeners.get(knownEvent)] as const];

    for (const [event, listeners] of entries) {
      if (listeners === undefined || !listeners.delete(listener)) {
        continue;
      }

      if (listeners.size === 0) {
        this.engine.listeners.delete(event);
      }

      return;
    }
  }

  private reportListenerFailure(
    event: AnyEventDefinition,
    error: unknown,
  ): void {
    if (event === eventListenerFailed || !this.isOpen()) {
      return;
    }

    // Failure reporting stays synchronous and cannot replace the original
    // listener error if a technical failure listener is itself broken.
    try {
      this.dispatch(eventListenerFailed, {
        eventName: event.name,
        error,
      });
    } catch {
      // Technical listeners are deliberately contained.
    }
  }

  private assertOpen(): void {
    if (!this.isOpen()) {
      throw new Error("Cannot use a closed event scope.");
    }
  }

  private isOpen(): boolean {
    let scope: EventScope | undefined = this.scopeNode;

    while (scope !== undefined) {
      if (this.engine.closedScopes.has(scope)) {
        return false;
      }

      scope = scope.parent;
    }

    return !this.closed;
  }
}

/** Returns whether a scope belongs to another scope's descendant tree. */
function isDescendantOf(scope: EventScope, ancestor: EventScope): boolean {
  let current = scope.parent;

  while (current !== undefined) {
    if (current === ancestor) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

/** Detects accidental promise-returning listeners hidden by void assignability. */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof value.then === "function";
}
