import { describe, expect, it, vi } from "vitest";

import { createDependencyContainer, dep } from "../di/index.js";
import { EventBus } from "../events/index.js";
import { App, ExecutionScope, executionCompletedEvent } from "./index.js";

describe("ExecutionScope disposal failures", () => {
  it("shares disposal with reentrant completion listeners and keeps the first outcome", async () => {
    const app = new App({});
    await app.start();
    const scope = await app.createExecutionScope();
    const outcomes: string[] = [];
    let joined: Promise<void> | undefined;
    scope.eventBus!.listen(executionCompletedEvent, ({ outcome }) => {
      outcomes.push(outcome);
      // Limit reentry to the first dispatch so a broken implementation fails by assertion.
      if (outcomes.length === 1) joined = scope.dispose("failure");
    });
    try {
      const disposing = scope.dispose("cancelled");
      expect(joined).toBe(disposing);
      await disposing;
      expect(outcomes).toEqual(["cancelled"]);
      expect(() => scope.context.set("late", 1)).toThrow("Cannot modify a completed execution context.");
      await expect(scope.whenDisposed).resolves.toBeUndefined();
    } finally {
      await scope.dispose().catch(() => undefined);
      await joined?.catch(() => undefined);
      await app.dispose();
    }
  });

  it("reports a lone deferred failure and releases a standalone scope", async () => {
    const container = createDependencyContainer({});
    const scope = new ExecutionScope(container);
    const release = vi.fn();
    const failure = new Error("deferred work failed");
    container.registerValue("owned", {}, { dispose: release });
    scope.tasks.defer(() => { throw failure; });

    try {
      await expect(scope.dispose()).rejects.toBe(failure);
      expect(scope.errorHandler.handleHttp(new Error("Secret details"), { executionId: scope.id })).toMatchObject({
        statusCode: 500, message: "An unexpected error occurred.",
      });
      await expect(scope.whenDisposed).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await scope.dispose().catch(() => undefined);
    }
  });

  it("reports dispatch and deferred failures together and releases the application-owned scope", async () => {
    const app = new App({});
    const listenerFailure = new Error("completion dispatch failed");
    const deferredFailure = new Error("deferred work failed");
    await app.start();
    const scope = await app.createExecutionScope();
    scope.eventBus?.listen(executionCompletedEvent, () => { throw listenerFailure; });
    scope.tasks.defer(() => { throw deferredFailure; });

    try {
      await expect(scope.dispose()).rejects.toMatchObject({
        name: "AggregateError",
        errors: [listenerFailure, deferredFailure],
      });
      await expect(scope.whenDisposed).resolves.toBeUndefined();
      // Scope cleanup cannot leave application shutdown waiting on a failed completion.
      await expect(app.dispose()).resolves.toBeUndefined();
    } finally {
      await scope.dispose().catch(() => undefined);
      await app.dispose();
    }
  });

  it("preserves completion and dependency disposal failures together", async () => {
    const app = new App({});
    const listenerFailure = new Error("completion listener failed");
    const disposalFailure = new Error("scoped dependency disposal failed");
    app.container.registerFactory("owned", () => ({}), {
      lifetime: "scoped", dispose: () => { throw disposalFailure; },
    });
    await app.start();
    const scope = await app.createExecutionScope();
    scope.eventBus!.listen(executionCompletedEvent, () => { throw listenerFailure; });
    try {
      scope.container.resolve(dep("owned"));
      await expect(scope.dispose()).rejects.toMatchObject({
        name: "AggregateError",
        message: "Execution completion failed.",
        errors: [listenerFailure, expect.objectContaining({ errors: [disposalFailure] })],
      });
      await expect(scope.whenDisposed).resolves.toBeUndefined();
    } finally {
      await scope.dispose().catch(() => undefined);
      await app.dispose();
    }
  });

  it("reports a bus close failure and still releases the scope's dependencies", async () => {
    const container = createDependencyContainer({});
    const bus = new EventBus();
    const scope = new ExecutionScope(container, undefined, undefined, undefined, bus);
    const failure = new Error("Scoped bus close failed");
    const close = vi.spyOn(bus, "close").mockImplementationOnce(() => { throw failure; });
    const release = vi.fn();
    container.registerValue("owned", {}, { dispose: release });
    try {
      await expect(scope.dispose()).rejects.toBe(failure);
      expect(close).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      await expect(scope.whenDisposed).resolves.toBeUndefined();
    } finally {
      close.mockRestore();
      bus.close();
      await scope.dispose().catch(() => undefined);
      await container.dispose();
    }
  });
});
