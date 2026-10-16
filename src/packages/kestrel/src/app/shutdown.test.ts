import { afterEach, describe, expect, it, vi } from "vitest";
import { App, ApplicationShutdown, ApplicationShutdownTimeoutError, executionSignalDependency, runtimeStoppingEvent, shutdownStartedEvent } from "./index.js";
import { waitForShutdownSignal } from "./process.js";

// Every blocked operation is released in cleanup, including timed-out work.
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
afterEach(() => vi.useRealTimers());

describe("application shutdown budget", () => {
  it.each([{ timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }, { timeoutMs: 10, drainMs: 11 }, { drainMs: -1 }])("rejects invalid timer budgets %j", (options) => {
    expect(() => new ApplicationShutdown(options)).toThrow(TypeError);
  });

  it("keeps borrowed resources alive, cancels scopes and reports incomplete shutdown", async () => {
    vi.useFakeTimers();
    const app = new App({}, { shutdown: { drainMs: 20, timeoutMs: 30 } });
    const close = vi.fn();
    app.container.registerValue("resource", {}, { dispose: close });
    await app.start();
    const execution = await app.createExecutionScope();
    expect(execution.resolveDependencies({ signal: executionSignalDependency }).signal).toBe(execution.signal);
    const disposing = app.dispose();
    const outcome = expect(disposing).rejects.toBeInstanceOf(ApplicationShutdownTimeoutError);
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(execution.signal.aborted).toBe(true);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      await outcome;
      expect(app.state).toBe("shutdownTimedOut");
      expect(close).not.toHaveBeenCalled();
      await expect(app.createExecutionScope()).rejects.toThrow("shutdownTimedOut");
    } finally {
      await execution.dispose();
      await app.container.dispose();
    }
  });

  it("shares the first deadline with transport draining and never disposes its borrowed dependencies early", async () => {
    vi.useFakeTimers();
    const app = new App({}, { shutdown: { drainMs: 20, timeoutMs: 30 } });
    const blocked = gate();
    const close = vi.fn();
    const stopTransport = vi.fn(() => blocked.promise);
    app.shutdown.registerDrain(stopTransport);
    app.container.registerValue("resource", {}, { dispose: close });
    await app.start();
    await app.stop();
    await vi.advanceTimersByTimeAsync(25);
    const disposing = app.dispose();
    const outcome = expect(disposing).rejects.toThrow();
    try {
      await vi.advanceTimersByTimeAsync(5);
      await outcome;
      expect(stopTransport).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(app.state).toBe("shutdownTimedOut");
    } finally {
      blocked.release();
      await app.container.dispose();
    }
  });

  it.each(["runtime listener", "shutdown listener", "diagnostic flush", "disposer"])("bounds a blocked %s", async (phase) => {
    vi.useFakeTimers();
    const app = new App({}, { shutdown: { drainMs: 10, timeoutMs: 30 } });
    const blocked = gate();
    if (phase === "runtime listener") app.eventBus.listenAsync(runtimeStoppingEvent, () => blocked.promise);
    if (phase === "shutdown listener") app.eventBus.listenAsync(shutdownStartedEvent, () => blocked.promise);
    if (phase === "diagnostic flush") app.container.registerValue("observationRecorder", { flush: () => blocked.promise });
    if (phase === "disposer") app.container.registerValue("resource", {}, { dispose: () => blocked.promise });
    await app.start();
    const disposing = app.dispose();
    const outcome = expect(disposing).rejects.toThrow();
    try {
      await vi.advanceTimersByTimeAsync(30);
      await outcome;
      expect(app.state).toBe("shutdownTimedOut");
    } finally {
      blocked.release();
      await app.tasks.wait().catch(() => undefined);
      await app.container.dispose();
    }
  });

  it("marks a stop-only embedded application incomplete at expiration", async () => {
    vi.useFakeTimers();
    const app = new App({}, { shutdown: { timeoutMs: 30 } });
    const blocked = gate();
    app.eventBus.listenAsync(runtimeStoppingEvent, () => blocked.promise);
    await app.start();
    const stopping = app.stop();
    const outcome = expect(stopping).rejects.toBeInstanceOf(ApplicationShutdownTimeoutError);
    try {
      await vi.advanceTimersByTimeAsync(30);
      await outcome;
      expect(app.state).toBe("shutdownTimedOut");
      await expect(app.createExecutionScope()).rejects.toThrow();
    } finally {
      blocked.release();
      await app.tasks.wait();
      app.shutdown.finish();
      await app.container.dispose();
    }
  });

  it("removes process listeners when the owner stops waiting", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const controller = new AbortController();
    const waiting = waitForShutdownSignal(controller.signal);
    controller.abort();
    await waiting;
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
});
