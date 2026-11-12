import { describe, expect, it, vi } from "vitest";

import { createDependencyContainer } from "../di/index.js";
import { App, ExecutionScope, executionCompletedEvent } from "./index.js";

describe("ExecutionScope disposal failures", () => {
  it("reports a lone deferred failure and releases a standalone scope", async () => {
    const container = createDependencyContainer({});
    const scope = new ExecutionScope(container);
    const release = vi.fn();
    const failure = new Error("deferred work failed");
    container.registerValue("owned", {}, { dispose: release });
    scope.tasks.defer(() => { throw failure; });

    try {
      await expect(scope.dispose()).rejects.toBe(failure);
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
});
