import { DeferredTasks } from "../concurrency/index.js";
import {
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  defineEvent,
  EventBus,
  eventListenerFailed,
} from "./index.js";

const messagePublished = defineEvent({
  name: "message.published",
  schema: z.object({
    id: z.coerce.number().int(),
  }),
});

describe("EventBus", () => {
  it("validates before dispatch and invokes synchronous listeners immediately", () => {
    const eventBus = new EventBus();
    const calls: number[] = [];

    eventBus.listen(messagePublished, (event) => {
      expectTypeOf(event.id).toEqualTypeOf<number>();
      calls.push(event.id);
    });

    eventBus.dispatch(messagePublished, { id: "42" });

    expect(calls).toEqual([42]);
    expect(() => eventBus.dispatch(messagePublished, { id: "invalid" }))
      .toThrow();
  });

  it("propagates synchronous failures and stops later listeners", () => {
    const eventBus = new EventBus();
    const failure = new Error("failed");
    const laterListener = vi.fn();

    eventBus.listen(messagePublished, () => {
      throw failure;
    });
    eventBus.listen(messagePublished, laterListener);

    expect(() => eventBus.dispatch(messagePublished, { id: 1 }))
      .toThrow(failure);
    expect(laterListener).not.toHaveBeenCalled();
  });

  it("keeps later one-time listeners pending when an earlier listener stops dispatch", async () => {
    const bus = new EventBus();
    const failure = new Error("first listener failed");
    const once = vi.fn();
    const onceAsync = vi.fn(async () => {});
    bus.listenOnce(messagePublished, () => { throw failure; });
    bus.listenOnce(messagePublished, once);
    bus.listenOnceAsync(messagePublished, onceAsync);
    const awaited = vi.fn();
    void bus.waitFor(messagePublished).then(awaited);

    expect(() => bus.dispatch(messagePublished, { id: 1 })).toThrow(failure);
    expect(once).not.toHaveBeenCalled();
    expect(onceAsync).not.toHaveBeenCalled();

    bus.dispatch(messagePublished, { id: 2 });
    await bus.wait();
    expect(once).toHaveBeenCalledExactlyOnceWith({ id: 2 }, { scope: bus.scope });
    expect(onceAsync).toHaveBeenCalledExactlyOnceWith({ id: 2 }, { scope: bus.scope });
    expect(awaited).toHaveBeenCalledExactlyOnceWith({ id: 2 });
    bus.close();
  });

  it("reserves a one-time listener for the dispatch that selected it first", () => {
    const bus = new EventBus();
    const once = vi.fn();
    bus.listen(messagePublished, ({ id }) => {
      if (id === 1) bus.dispatch(messagePublished, { id: 2 });
    });
    bus.listenOnce(messagePublished, once);

    bus.dispatch(messagePublished, { id: 1 });
    expect(once).toHaveBeenCalledExactlyOnceWith({ id: 1 }, { scope: bus.scope });
    bus.close();
  });

  it("keeps an ancestor's one-time async listener if a child cannot schedule its task", async () => {
    const root = new EventBus();
    const closedTasks = new DeferredTasks();
    await closedTasks.close();
    const child = root.createScope({ id: "closed-tasks", kind: "execution" }, closedTasks);
    const once = vi.fn(async () => {});
    root.listenOnceAsync(messagePublished, once, { scope: "descendants" });

    expect(() => child.dispatch(messagePublished, { id: 1 })).toThrow("closed");
    root.dispatch(messagePublished, { id: 2 });
    await root.wait();
    expect(once).toHaveBeenCalledExactlyOnceWith({ id: 2 }, { scope: root.scope });
    root.close();
  });

  it("protects the scope identity and ancestry returned by the bus", () => {
    const root = new EventBus();
    const options = { id: "execution", kind: "task" };
    const child = root.createScope(options);
    const received = vi.fn();
    root.listen(messagePublished, received, { scope: "descendants" });
    options.id = "different";

    expect(root.scope).toStrictEqual({ id: "app", kind: "app" });
    expect(Reflect.set(root.scope, "id", "changed")).toBe(false);
    expect(Reflect.set(child.scope, "parent", undefined)).toBe(false);
    child.dispatch(messagePublished, { id: 1 });
    expect(received).toHaveBeenCalledExactlyOnceWith({ id: 1 }, {
      scope: { id: "execution", kind: "task", parent: { id: "app", kind: "app" } },
    });
    root.close();
  });

  it("rejects a callable thenable returned by a synchronous listener", async () => {
    const bus = new EventBus();
    const then = vi.fn((resolve: (value: undefined) => void) => { resolve(undefined); });
    const thenable = Object.assign(() => {}, { then });
    bus.listen(messagePublished, () => thenable);

    expect(() => bus.dispatch(messagePublished, { id: 1 })).toThrow("use listenAsync() instead");
    await Promise.resolve();
    expect(then).toHaveBeenCalledOnce();
    bus.close();
  });

  it("allows synchronous return values that do not implement a thenable", () => {
    const bus = new EventBus();
    const completed = vi.fn();
    bus.listen(messagePublished, () => null);
    bus.listen(messagePublished, () => ({ then: false }));
    bus.listen(messagePublished, completed);

    expect(() => bus.dispatch(messagePublished, { id: 1 })).not.toThrow();
    expect(completed).toHaveBeenCalledOnce();
    bus.close();
  });

  it("rejects async functions registered through the synchronous API", () => {
    const eventBus = new EventBus();

    eventBus.listen(messagePublished, async () => {
      await Promise.resolve();
    });

    expect(() => eventBus.dispatch(messagePublished, { id: 1 }))
      .toThrow("use listenAsync() instead");
  });

  it("tracks asynchronous listeners in their bound deferred tasks", async () => {
    const tasks = new DeferredTasks();
    const eventBus = new EventBus({}, tasks);
    const calls: string[] = [];
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    eventBus.listenAsync(messagePublished, async () => {
      calls.push("first:start");
      await blocked;
      calls.push("first:end");
    });
    eventBus.listenAsync(messagePublished, async () => {
      calls.push("second:start");
      await blocked;
      calls.push("second:end");
    });

    eventBus.dispatch(messagePublished, { id: 1 });

    expect(tasks.pendingCount).toBe(2);
    await vi.waitFor(() => {
      expect(calls).toEqual(["first:start", "second:start"]);
    });
    release();
    await eventBus.wait();

    expect(calls).toEqual([
      "first:start",
      "second:start",
      "first:end",
      "second:end",
    ]);
  });

  it("surfaces asynchronous failures at the next wait boundary", async () => {
    const eventBus = new EventBus();
    const failure = new Error("failed");
    const completed = vi.fn();

    eventBus.listenAsync(messagePublished, async () => {
      await Promise.resolve();
      throw failure;
    });
    eventBus.listenAsync(messagePublished, async () => {
      await Promise.resolve();
      completed();
    });

    eventBus.dispatch(messagePublished, { id: 1 });

    await expect(eventBus.wait()).rejects.toBe(failure);
    expect(completed).toHaveBeenCalledOnce();
  });

  it("reports both synchronous and asynchronous listener failures", async () => {
    const eventBus = new EventBus();
    const synchronousFailure = new Error("sync");
    const asynchronousFailure = new Error("async");
    const failures: unknown[] = [];

    eventBus.listen(eventListenerFailed, (event) => {
      failures.push(event.error);
    });
    eventBus.listen(messagePublished, () => {
      throw synchronousFailure;
    });

    expect(() => eventBus.dispatch(messagePublished, { id: 1 }))
      .toThrow(synchronousFailure);

    const secondBus = eventBus.createScope({ id: "child", kind: "test" });
    secondBus.listen(eventListenerFailed, (event) => {
      failures.push(event.error);
    });
    secondBus.listenAsync(messagePublished, async () => {
      throw asynchronousFailure;
    });
    secondBus.dispatch(messagePublished, { id: 2 });
    await expect(secondBus.wait()).rejects.toBe(asynchronousFailure);

    expect(failures).toEqual([synchronousFailure, asynchronousFailure]);
  });

  it("reports a listener failure once when the asynchronous diagnostic listener also fails", async () => {
    const eventBus = new EventBus();
    const originalFailure = new Error("message listener failed");
    const diagnosticListener = vi.fn(async () => {
      throw new Error("diagnostic listener failed");
    });

    try {
      eventBus.listenAsync(eventListenerFailed, diagnosticListener);
      eventBus.listenAsync(messagePublished, async () => {
        throw originalFailure;
      });

      eventBus.dispatch(messagePublished, { id: 1 });

      // The diagnostic failure must neither recur nor replace the original rejection.
      await expect(eventBus.wait()).rejects.toBe(originalFailure);
      expect(diagnosticListener).toHaveBeenCalledExactlyOnceWith(
        { eventName: messagePublished.name, error: originalFailure },
        expect.anything(),
      );
      await expect(eventBus.wait()).resolves.toBeUndefined();
    } finally {
      eventBus.close();
    }
  });

  it("preserves the original failure when a synchronous diagnostic listener throws", () => {
    const bus = new EventBus();
    const failure = new Error("first failure");
    const diagnostic = vi.fn(() => { throw new Error("diagnostic failure"); });
    bus.listen(eventListenerFailed, diagnostic);
    bus.listen(messagePublished, () => { throw failure; });

    expect(() => bus.dispatch(messagePublished, { id: 1 })).toThrow(failure);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ eventName: messagePublished.name, error: failure }, {
      scope: bus.scope,
    });
    bus.close();
  });

  it("keeps persistent async listeners registered and names their deferred errors", async () => {
    const onError = vi.fn();
    const tasks = new DeferredTasks({ onError });
    const bus = new EventBus({}, tasks);
    const failure = new Error("async listener failed");
    const listener = vi.fn(async ({ id }: { id: number }) => {
      if (id === 1) throw failure;
    });
    bus.listenAsync(messagePublished, listener);

    bus.dispatch(messagePublished, { id: 1 });
    await expect(bus.wait()).rejects.toBe(failure);
    bus.dispatch(messagePublished, { id: 2 });
    await bus.wait();

    expect(listener.mock.calls.map(([payload]) => payload)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, { name: `event:${messagePublished.name}` });
    await tasks.close();
    bus.close();
  });

  it("supports removal, one-time variants and waiting for a payload", async () => {
    const eventBus = new EventBus();
    const removedListener = vi.fn();
    const oneTimeListener = vi.fn();
    const oneTimeAsyncListener = vi.fn(async () => Promise.resolve());
    const stop = eventBus.listen(messagePublished, removedListener);
    const nextPayload = eventBus.waitFor(messagePublished);

    stop();
    stop();
    eventBus.listenOnce(messagePublished, oneTimeListener);
    eventBus.listenOnceAsync(messagePublished, oneTimeAsyncListener);

    eventBus.dispatch(messagePublished, { id: 1 });
    await eventBus.wait();
    eventBus.dispatch(messagePublished, { id: 2 });

    await expect(nextPayload).resolves.toEqual({ id: 1 });
    expect(removedListener).not.toHaveBeenCalled();
    expect(oneTimeListener).toHaveBeenCalledOnce();
    expect(oneTimeAsyncListener).toHaveBeenCalledOnce();
  });

  it("isolates exact listeners and lets ancestors observe descendants", () => {
    const rootBus = new EventBus();
    const firstExecution = rootBus.createScope({
      id: "execution-1",
      kind: "execution",
    });
    const secondExecution = rootBus.createScope({
      id: "execution-2",
      kind: "execution",
    });
    const rootExact = vi.fn();
    const rootDescendants = vi.fn();
    const firstExact = vi.fn();
    const secondExact = vi.fn();

    rootBus.listen(messagePublished, rootExact);
    rootBus.listen(messagePublished, rootDescendants, {
      scope: "descendants",
    });
    firstExecution.listen(messagePublished, firstExact);
    secondExecution.listen(messagePublished, secondExact);

    firstExecution.dispatch(messagePublished, { id: 1 });

    expect(rootExact).not.toHaveBeenCalled();
    expect(rootDescendants).toHaveBeenCalledWith(
      { id: 1 },
      { scope: firstExecution.scope },
    );
    expect(firstExact).toHaveBeenCalledOnce();
    expect(secondExact).not.toHaveBeenCalled();
  });

  it("inherits deferred task lifetime in nested scopes", async () => {
    const tasks = new DeferredTasks();
    const rootBus = new EventBus();
    const executionBus = rootBus.createScope(
      { id: "execution-1", kind: "execution" },
      tasks,
    );
    const childBus = executionBus.createScope({
      id: "transaction-1",
      kind: "transaction",
    });
    const completed = vi.fn();

    executionBus.listenAsync(messagePublished, async () => {
      await Promise.resolve();
      completed();
    }, { scope: "descendants" });

    childBus.dispatch(messagePublished, { id: 1 });
    await tasks.close();

    expect(completed).toHaveBeenCalledOnce();
  });

  it("assigns ancestor async listeners to the dispatching child lifetime", async () => {
    const applicationTasks = new DeferredTasks();
    const executionTasks = new DeferredTasks();
    const rootBus = new EventBus({}, applicationTasks);
    const executionBus = rootBus.createScope(
      { id: "execution-1", kind: "execution" },
      executionTasks,
    );

    rootBus.listenAsync(messagePublished, async () => {
      await Promise.resolve();
    }, { scope: "descendants" });

    executionBus.dispatch(messagePublished, { id: 1 });

    expect(applicationTasks.pendingCount).toBe(0);
    expect(executionTasks.pendingCount).toBe(1);
    await executionTasks.close();
  });

  it("removes a scope subtree and prevents its later use", () => {
    // Inject the shared registry to verify resource release as well as dispatch rejection.
    const engine: NonNullable<ConstructorParameters<typeof EventBus>[3]> = {
      closedScopes: new WeakSet(), listeners: new Map(),
    };
    const rootBus = new EventBus({}, undefined, undefined, engine);
    const executionBus = rootBus.createScope({
      id: "execution-1",
      kind: "execution",
    });
    const childBus = executionBus.createScope({
      id: "child-1",
      kind: "child",
    });
    const otherBus = rootBus.createScope({ id: "execution-2", kind: "execution" });
    const listener = vi.fn();
    const sibling = vi.fn();

    executionBus.listen(messagePublished, listener, { scope: "descendants" });
    childBus.listen(messagePublished, listener);
    const stopSibling = otherBus.listen(messagePublished, sibling);
    otherBus.dispatch(messagePublished, { id: 1 });
    expect(listener).not.toHaveBeenCalled();
    expect(sibling).toHaveBeenCalledOnce();
    childBus.dispatch(messagePublished, { id: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
    executionBus.close();

    expect(engine.listeners.get(messagePublished)?.size).toBe(1);
    expect(() => childBus.createScope({ id: "grandchild", kind: "child" }))
      .toThrowError("Cannot use a closed event scope.");
    expect(() => childBus.wait()).toThrowError("Cannot use a closed event scope.");
    expect(() => childBus.dispatch(messagePublished, { id: 1 }))
      .toThrowError("Cannot use a closed event scope.");
    otherBus.dispatch(messagePublished, { id: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(sibling).toHaveBeenCalledTimes(2);
    rootBus.close();
    expect(engine.listeners.has(messagePublished)).toBe(false);
    // An owner may release its listener after its parent already closed the scope.
    expect(() => { stopSibling(); stopSibling(); }).not.toThrow();
  });
});
