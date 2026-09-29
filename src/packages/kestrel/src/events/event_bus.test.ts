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
    const rootBus = new EventBus();
    const executionBus = rootBus.createScope({
      id: "execution-1",
      kind: "execution",
    });
    const childBus = executionBus.createScope({
      id: "child-1",
      kind: "child",
    });
    const listener = vi.fn();

    childBus.listen(messagePublished, listener);
    executionBus.close();

    expect(() => childBus.dispatch(messagePublished, { id: 1 }))
      .toThrowError("Cannot use a closed event scope.");
    rootBus.dispatch(messagePublished, { id: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});
