import { afterEach, describe, expect, it, vi } from "vitest";

import { defineEvent, EventBus } from "../events/index.js";
import { DeferredTasks } from "../concurrency/index.js";
import { createDependencyContainer, defineAdapter, dep, type AdapterRegistration } from "../di/index.js";
import { z } from "zod";
import {
  App, ApplicationShutdownTimeoutError, bootstrapStartedEvent,
  runtimeStartedEvent, runtimeStoppingEvent, shutdownCompletedEvent, shutdownStartedEvent,
} from "./index.js";
import { registerProviderAdapter } from "./adapter.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const outcome = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
const causes = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(causes) : [error];

afterEach(() => vi.useRealTimers());

/** Cleanup also covers assertion failures and mutations which omit a disposal phase. */
async function releaseApp(app: App<{}>) {
  app.shutdown.finish();
  await app.tasks.close().catch(() => undefined);
  app.eventBus.close();
  await app.container.dispose();
}

describe("application shutdown contracts", () => {
  it.each(["bootstrapping", "ready"] as const)("waits for %s startup before releasing shared resources", async (stage) => {
    const app = new App({});
    const blocked = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const close = vi.fn();
    const hold = async () => { entered.resolve(); await blocked.promise; };
    app.container.registerValue("owned", {}, { dispose: close });
    if (stage === "bootstrapping") app.register({ register() {}, boot: hold });
    else app.eventBus.listenAsync(runtimeStartedEvent, hold);
    const starting = app.start();
    const started = outcome(starting);
    let disposed: Promise<unknown> | undefined;
    try {
      await entered.promise;
      disposed = outcome(app.dispose());
      await turn();
      expect(app.state).toBe(stage);
      expect(close).not.toHaveBeenCalled();
      blocked.resolve();
      expect(await started).toBeUndefined();
      expect(await disposed).toBeUndefined();
      expect(app.state).toBe("disposed");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      blocked.resolve();
      await started;
      await disposed;
      await releaseApp(app);
    }
  });

  it("preserves a failed startup during disposal and still releases owned resources", async () => {
    const app = new App({});
    const blocked = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error("Provider boot failed");
    const close = vi.fn();
    app.container.registerValue("owned", {}, { dispose: close });
    app.register({ register() {}, boot: async () => { entered.resolve(); await blocked.promise; throw failure; } });
    const started = outcome(app.start());
    let disposed: Promise<unknown> | undefined;
    try {
      await entered.promise;
      disposed = outcome(app.dispose());
      await turn();
      expect(close).not.toHaveBeenCalled();
      blocked.resolve();
      expect(await started).toBe(failure);
      expect(causes(await disposed)).toContain(failure);
      expect(app.state).toBe("disposed");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      blocked.resolve(); await started; await disposed; await releaseApp(app);
    }
  });

  it("starts registered transport drains when only stop is called", async () => {
    const app = new App({});
    const blocked = Promise.withResolvers<void>();
    const drain = vi.fn(() => blocked.promise);
    app.shutdown.registerDrain(drain);
    try {
      await app.start();
      await app.stop();
      expect(drain).toHaveBeenCalledOnce();
      blocked.resolve();
      await app.dispose();
      expect(drain).toHaveBeenCalledOnce();
    } finally { blocked.resolve(); await releaseApp(app); }
  });

  it("leaves composition unchanged on stop but starts the embedded owner's deadline", async () => {
    vi.useFakeTimers();
    const app = new App({}, { shutdown: { timeoutMs: 30 } });
    const stopping = vi.fn();
    const drain = vi.fn(async () => {});
    app.eventBus.listen(runtimeStoppingEvent, stopping);
    app.shutdown.registerDrain(drain);
    try {
      await app.stop();
      expect(app.state).toBe("composing");
      expect(stopping).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30);
      expect(app.state).toBe("shutdownTimedOut");
      expect(app.shutdown.error).toBeInstanceOf(ApplicationShutdownTimeoutError);
    } finally { await releaseApp(app); }
  });

  it("waits for queued shutdown work after a synchronous listener throws", async () => {
    const app = new App({});
    const blocked = Promise.withResolvers<void>();
    const failure = new Error("Synchronous shutdown listener failed");
    const flush = vi.fn(async () => {});
    app.container.registerValue("observationRecorder", { flush });
    app.eventBus.listenAsync(shutdownStartedEvent, () => blocked.promise);
    app.eventBus.listen(shutdownStartedEvent, () => { throw failure; });
    let disposed: Promise<unknown> | undefined;
    try {
      await app.start();
      disposed = outcome(app.dispose());
      await turn();
      expect(flush).not.toHaveBeenCalled();
      blocked.resolve();
      expect(causes(await disposed)).toContain(failure);
      expect(flush).toHaveBeenCalledOnce();
      expect(app.state).toBe("disposed");
    } finally { blocked.resolve(); await disposed; await releaseApp(app); }
  });

  it("reports adapter shutdown once and preserves independent container disposal failures", async () => {
    const app = new App({});
    const adapterFailure = new Error("Adapter close failed");
    const containerFailure = new Error("Container resource close failed");
    const release = vi.fn(() => { throw adapterFailure; });
    app.register({
      register(composition) {
        registerProviderAdapter(composition, "ownedAdapter", defineAdapter({
          dependencies: {}, capabilities: {}, create: () => ({}), dispose: release,
        }), undefined);
      },
    });
    const registration = app.container.resolve(dep<AdapterRegistration<object>>("ownedAdapterRegistration"));
    app.container.registerValue("otherResource", {}, { dispose: () => { throw containerFailure; } });

    try {
      registration.get();
      await app.start();
      expect(causes(await outcome(app.dispose()))).toEqual([adapterFailure, containerFailure]);
      expect(release).toHaveBeenCalledOnce();
      await expect(registration.dispose()).rejects.toBe(adapterFailure);
    } finally { await releaseApp(app).catch(() => undefined); }
  });

  it("retains the container fallback when the application shutdown event was never dispatched", async () => {
    const app = new App({});
    const failure = new Error("Fallback adapter close failed");
    const release = vi.fn(() => { throw failure; });
    app.register({
      register(composition) {
        registerProviderAdapter(composition, "ownedAdapter", defineAdapter({
          dependencies: {}, capabilities: {}, create: () => ({}), dispose: release,
        }), undefined).get();
      },
    });

    try {
      expect(causes(await outcome(app.container.dispose()))).toEqual([failure]);
      expect(release).toHaveBeenCalledOnce();
    } finally { await releaseApp(app).catch(() => undefined); }
  });

  it.each([false, true])("preserves completion-listener failures and continues cleanup (async=%s)", async (asynchronous) => {
    const app = new App({});
    const failure = new Error("Completion listener failed");
    const close = vi.fn();
    app.container.registerValue("owned", {}, { dispose: close });
    if (asynchronous) app.eventBus.listenAsync(shutdownCompletedEvent, async () => { throw failure; });
    else app.eventBus.listen(shutdownCompletedEvent, () => { throw failure; });
    try {
      await app.start();
      expect(causes(await outcome(app.dispose()))).toContain(failure);
      expect(close).toHaveBeenCalledOnce();
      expect(app.state).toBe("disposed");
    } finally { await releaseApp(app); }
  });

  it("drains completion listeners and their child tasks before sealing tasks and events", async () => {
    const app = new App({});
    const blocked = Promise.withResolvers<void>();
    const calls: string[] = [];
    const close = vi.fn(() => { calls.push("resource"); });
    const event = defineEvent({ name: "shutdown.test", schema: z.object({}) });
    app.container.registerValue("owned", {}, { dispose: close });
    app.eventBus.listenAsync(shutdownCompletedEvent, async () => {
      await blocked.promise;
      calls.push("listener");
      app.tasks.defer(() => { calls.push("child"); });
    });
    let disposed: Promise<unknown> | undefined;
    try {
      await app.start();
      disposed = outcome(app.dispose());
      await turn();
      expect(close).not.toHaveBeenCalled();
      blocked.resolve();
      expect(await disposed).toBeUndefined();
      expect(calls).toEqual(["listener", "child", "resource"]);
      expect(app.tasks.state).toBe("closed");
      expect(() => app.tasks.defer(() => {})).toThrow();
      expect(() => app.eventBus.dispatch(event, {})).toThrow(/closed/);
      expect(() => app.eventBus.listen(event, () => {})).toThrow(/closed/);
    } finally { blocked.resolve(); await disposed; await releaseApp(app); }
  });

  it("cancels the deadline after successful disposal", async () => {
    vi.useFakeTimers();
    const app = new App({}, { shutdown: { drainMs: 20, timeoutMs: 30 } });
    const expired = vi.fn();
    app.shutdown.onTimeout(expired);
    try {
      await app.start(); await app.dispose();
      await vi.advanceTimersByTimeAsync(60);
      expect(app.state).toBe("disposed");
      expect(app.shutdown.error).toBeUndefined();
      expect(app.shutdown.signal.aborted).toBe(false);
      expect(expired).not.toHaveBeenCalled();
    } finally { await releaseApp(app); }
  });

  it.each([
    "startup completion:bootstrapping", "startup completion:ready",
    "runtime stopping listeners", "transport drain", "active executions",
    "shutdown listeners", "observation flush", "completion listeners", "owned resource disposal",
  ])("identifies the timed-out phase %s and preserves the deadline cause", async (selection) => {
    vi.useFakeTimers();
    const app = new App({}, { shutdown: { drainMs: 20, timeoutMs: 30 } });
    const blocked = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const phase = selection.split(":")[0]!;
    const completed = vi.fn();
    const close = vi.fn(async () => {
      if (phase === "owned resource disposal") await blocked.promise;
    });
    const hold = async () => { entered.resolve(); await blocked.promise; };
    app.container.registerValue("owned", {}, { dispose: close });
    app.eventBus.listen(shutdownCompletedEvent, completed);
    if (selection === "startup completion:bootstrapping") app.register({ register() {}, boot: hold });
    if (selection === "startup completion:ready") app.eventBus.listenAsync(runtimeStartedEvent, hold);
    if (phase === "runtime stopping listeners") app.eventBus.listenAsync(runtimeStoppingEvent, hold);
    if (phase === "transport drain") app.shutdown.registerDrain(hold);
    if (phase === "shutdown listeners") app.eventBus.listenAsync(shutdownStartedEvent, hold);
    if (phase === "observation flush") app.container.registerValue("observationRecorder", { flush: hold });
    if (phase === "completion listeners") app.eventBus.listenAsync(shutdownCompletedEvent, hold);
    const starting = outcome(app.start());
    let execution: Awaited<ReturnType<typeof app.createExecutionScope>> | undefined;
    let disposed: Promise<unknown> | undefined;
    try {
      if (phase === "startup completion") await entered.promise;
      else await starting;
      if (phase === "active executions") execution = await app.createExecutionScope();
      disposed = outcome(app.dispose());
      await vi.advanceTimersByTimeAsync(30);
      const error = await disposed;
      const timeout = app.shutdown.error;
      expect(timeout).toBeInstanceOf(ApplicationShutdownTimeoutError);
      expect(timeout?.phase).toBe(phase);
      expect(timeout?.timeoutMs).toBe(30);
      expect(causes(error)).toContain(timeout);
      expect(app.state).toBe("shutdownTimedOut");
      if (!["completion listeners", "owned resource disposal"].includes(phase)) {
        expect(completed).not.toHaveBeenCalled();
      }
      if (phase !== "owned resource disposal") expect(close).not.toHaveBeenCalled();
    } finally {
      blocked.resolve();
      await starting;
      await execution?.dispose();
      await disposed;
      await releaseApp(app);
    }
  });

  it("waits for startup even when disposal is requested synchronously during bootstrap dispatch", async () => {
    const app = new App({});
    const blocked = Promise.withResolvers<void>();
    const close = vi.fn();
    app.container.registerValue("owned", {}, { dispose: close });
    app.register({ register() {}, boot: () => blocked.promise });
    let disposed: Promise<unknown> | undefined;
    app.eventBus.listen(bootstrapStartedEvent, () => { disposed = outcome(app.dispose()); });
    const started = outcome(app.start());
    try {
      await turn();
      expect(close).not.toHaveBeenCalled();
      blocked.resolve();
      expect(await started).toBeUndefined();
      expect(await disposed).toBeUndefined();
      expect(app.state).toBe("disposed");
    } finally { blocked.resolve(); await started; await disposed; await releaseApp(app); }
  });

  it("does not restart bootstrap when a synchronous bootstrap listener reenters start", async () => {
    const app = new App({});
    const boot = vi.fn(async () => {});
    let nested: Promise<void> | undefined;
    app.register({ register() {}, boot });
    // A once-listener makes a broken implementation fail by duplicate boot, not recursion.
    app.eventBus.listenOnce(bootstrapStartedEvent, () => { nested = app.start(); });
    try {
      const started = app.start();
      await Promise.all([started, nested]);
      expect(nested).toBe(started);
      expect(boot).toHaveBeenCalledOnce();
      expect(app.state).toBe("running");
      await app.dispose();
    } finally { await nested; await releaseApp(app); }
  });

  it("retains deadline expiry alongside a synchronous collaborator's cleanup failure", async () => {
    vi.useFakeTimers();
    const tasks = new DeferredTasks();
    const container = createDependencyContainer({});
    const failure = new Error("Event scope cleanup failed");
    const close = vi.fn();
    let closed = false;
    let restoreClock: (() => void) | undefined;
    // Preconfigured event buses are supported composition inputs. Model synchronous
    // cleanup consuming the budget, then asking the coordinator for a bounded check.
    const bus = new class extends EventBus {
      public override close() {
        if (closed) return;
        closed = true;
        super.close();
        const elapsed = performance.now() + 31;
        const clock = vi.spyOn(performance, "now").mockReturnValue(elapsed);
        restoreClock = () => clock.mockRestore();
        void app.shutdown.wait("event scope cleanup", async () => {}).catch(() => undefined);
        throw failure;
      }
    }(undefined, tasks);
    container.registerValue("deferredTasks", tasks);
    container.registerValue("eventBus", bus);
    container.registerValue("owned", {}, { dispose: close });
    const app = new App({}, { container, shutdown: { timeoutMs: 30 } });
    try {
      await app.start();
      const error = await outcome(app.dispose());
      expect(app.shutdown.error).toBeInstanceOf(ApplicationShutdownTimeoutError);
      expect(app.shutdown.error?.phase).toBe("event scope cleanup");
      expect(causes(error)).toContain(failure);
      expect(causes(error)).toContain(app.shutdown.error);
      expect(app.state).toBe("shutdownTimedOut");
      expect(close).not.toHaveBeenCalled();
    } finally {
      restoreClock?.();
      await releaseApp(app);
    }
  });

  it("shares stop completion with a reentrant caller from a synchronous stopping listener", async () => {
    const app = new App({});
    const blocked = Promise.withResolvers<void>();
    let nested: Promise<void> | undefined;
    const settled = vi.fn();
    app.eventBus.listen(runtimeStoppingEvent, () => { nested = app.stop(); void nested.then(settled, settled); });
    app.eventBus.listenAsync(runtimeStoppingEvent, () => blocked.promise);
    let stopped: Promise<unknown> | undefined;
    try {
      await app.start(); stopped = outcome(app.stop());
      await turn();
      expect(settled).not.toHaveBeenCalled();
      blocked.resolve();
      expect(await stopped).toBeUndefined();
      await nested;
      expect(settled).toHaveBeenCalledOnce();
      await app.dispose();
    } finally { blocked.resolve(); await stopped; await nested; await releaseApp(app); }
  });

  it("runs disposal boundaries once when a stopping listener reenters dispose", async () => {
    const app = new App({});
    const shuttingDown = vi.fn();
    const close = vi.fn();
    let nested: Promise<unknown> | undefined;
    app.container.registerValue("owned", {}, { dispose: close });
    app.eventBus.listen(runtimeStoppingEvent, () => { nested = outcome(app.dispose()); });
    app.eventBus.listen(shutdownStartedEvent, shuttingDown);
    try {
      await app.start();
      const error = await outcome(app.dispose());
      expect(error).toBeUndefined();
      expect(await nested).toBeUndefined();
      expect(shuttingDown).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(app.state).toBe("disposed");
    } finally { await nested; await releaseApp(app); }
  });
});
