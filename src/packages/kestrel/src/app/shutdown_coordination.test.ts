import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, ApplicationShutdown, ApplicationShutdownTimeoutError } from "./index.js";
import { runSupervisedRuntime, waitForShutdownSignal } from "./process.js";

afterEach(() => vi.restoreAllMocks());

describe("shutdown coordination", () => {
  it("waits for a late transport and retains every drain failure in registration order", async () => {
    const shutdown = new ApplicationShutdown();
    const first = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const firstError = new Error("Initial drain failed");
    const lateError = new Error("Late drain failed");
    shutdown.registerDrain(() => first.promise);
    let settled = false;
    const draining = shutdown.drained().catch((error: unknown) => error).finally(() => { settled = true; });
    shutdown.registerDrain(() => { started.resolve(); return late.promise; });

    try {
      await started.promise;
      first.reject(firstError);
      await nextTurn();
      expect(settled).toBe(false);
      late.reject(lateError);
      const error = await draining;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({ message: "Transport drain failed.", errors: [firstError, lateError] });
    } finally {
      first.resolve();
      late.resolve();
      await draining;
      shutdown.finish();
    }
  });

  it("reports the pending phase after a concurrent phase has already finished", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const shutdown = new ApplicationShutdown({ timeoutMs: 30_000 });
    const blocked = Promise.withResolvers<void>();
    const subscribed = vi.fn();
    const removed = vi.fn();
    shutdown.onTimeout(subscribed);
    shutdown.onTimeout(removed)();
    const pending = shutdown.wait("owned resource disposal", () => blocked.promise).catch((error: unknown) => error);
    try {
      await expect(shutdown.wait("transport drain", () => 42)).resolves.toBe(42);
      clock.mockReturnValue(30_100);
      const unexpectedlyStarted = vi.fn();
      const expired = await shutdown.wait("late wait", unexpectedlyStarted).catch((error: unknown) => error);
      expect(expired).toBeInstanceOf(ApplicationShutdownTimeoutError);
      expect(expired).toMatchObject({
        name: "ApplicationShutdownTimeoutError", phase: "owned resource disposal", timeoutMs: 30_000,
        message: "Application shutdown exceeded 30000ms during owned resource disposal.",
      });
      expect(unexpectedlyStarted).not.toHaveBeenCalled();
      expect(await pending).toBe(expired);
      expect(shutdown.signal.reason).toBe(expired);
      expect(subscribed).toHaveBeenCalledExactlyOnceWith(expired);
      expect(removed).not.toHaveBeenCalled();
    } finally {
      blocked.resolve();
      await pending;
      shutdown.finish();
    }
  });

  it("keeps the deadline ref'ed only while an operation is waiting", async () => {
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const shutdown = new ApplicationShutdown({ drainMs: 2_987, timeoutMs: 7_913 });
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    try {
      shutdown.begin();
      const drain = setTimer.mock.results[setTimer.mock.calls.findIndex(([, delay]) => delay === 2_987)]?.value as NodeJS.Timeout;
      const deadline = setTimer.mock.results[setTimer.mock.calls.findIndex(([, delay]) => delay === 7_913)]?.value as NodeJS.Timeout;
      expect(drain.hasRef()).toBe(false);
      expect(deadline.hasRef()).toBe(false);
      const waiting = shutdown.wait("first", () => first.promise);
      const alsoWaiting = shutdown.wait("second", () => second.promise);
      expect(deadline.hasRef()).toBe(true);
      first.resolve();
      await waiting;
      expect(deadline.hasRef()).toBe(true);
      second.resolve();
      await alsoWaiting;
      expect(deadline.hasRef()).toBe(false);
    } finally {
      first.resolve();
      second.resolve();
      shutdown.finish();
    }
  });

  it("allows zero drain time and the largest supported Node timeout", async () => {
    const shutdown = new ApplicationShutdown({ drainMs: 0, timeoutMs: 2_147_483_647 });
    const cancellation = Promise.withResolvers<void>();
    shutdown.signal.addEventListener("abort", () => cancellation.resolve(), { once: true });
    shutdown.begin();
    try {
      await cancellation.promise;
      expect(shutdown.signal.reason).toMatchObject({ message: "Application drain budget expired." });
    } finally {
      shutdown.finish();
    }
  });
});

describe("supervised process coordination", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("settles an unscoped wait on %s and removes both listeners", async (signal) => {
    const before = { SIGINT: new Set(process.listeners("SIGINT")), SIGTERM: new Set(process.listeners("SIGTERM")) };
    const added = (name: keyof typeof before) => process.listeners(name).filter((listener) => !before[name].has(listener));
    const waiting = waitForShutdownSignal().catch((error: unknown) => error);
    try {
      expect(added("SIGINT")).toHaveLength(1);
      expect(added("SIGTERM")).toHaveLength(1);
      // Invoke only the handler installed by this wait, leaving Vitest's handlers alone.
      added(signal)[0]!(signal);
      expect(await waiting).toBeUndefined();
      expect(added("SIGINT")).toHaveLength(0);
      expect(added("SIGTERM")).toHaveLength(0);
    } finally {
      for (const name of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of added(name)) process.off(name, listener as () => void);
      }
    }
  });

  it("removes its abort listener when a process signal wins", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const before = new Set(process.listeners("SIGTERM"));
    const waiting = waitForShutdownSignal(controller.signal).catch((error: unknown) => error);
    try {
      const attached = process.listeners("SIGTERM").find((listener) => !before.has(listener));
      expect(attached).toBeTypeOf("function");
      attached!("SIGTERM");
      expect(await waiting).toBeUndefined();
      expect(add).toHaveBeenCalledExactlyOnceWith("abort", attached, { once: true });
      expect(remove).toHaveBeenCalledExactlyOnceWith("abort", attached);
    } finally {
      controller.abort();
      await waiting;
    }
  });

  it("does not start a runtime whose shutdown signal wait could not be installed", async () => {
    const app = new App({});
    const failure = new Error("Signal registration failed");
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    try {
      await expect(runSupervisedRuntime(app, { start, stop }, () => { throw failure; })).rejects.toBe(failure);
      expect(start).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await app.dispose();
    }
  });

  it("never reads polling completion when a signal wins during startup", async () => {
    const app = new App({});
    const startup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const signal = Promise.withResolvers<void>();
    const readCompletion = vi.fn(() => { throw new Error("Polling did not start"); });
    const running = runSupervisedRuntime(app, {
      start: () => { entered.resolve(); return startup.promise; },
      get completion() { return readCompletion(); },
      stop: async () => {},
    }, () => signal.promise).catch((error: unknown) => error);
    try {
      await entered.promise;
      signal.resolve();
      expect(await running).toBeUndefined();
      expect(readCompletion).not.toHaveBeenCalled();
    } finally {
      signal.resolve();
      startup.resolve();
      await running;
      await app.dispose();
    }
  });

  it("keeps unexpected polling completion and drain failures together", async () => {
    const app = new App({});
    const signal = Promise.withResolvers<void>();
    const drainError = new Error("Polling drain failed");
    const begin = vi.spyOn(app.shutdown, "begin");
    const stopApp = vi.spyOn(app, "stop").mockImplementation(async () => {
      expect(begin).toHaveBeenCalled();
    });
    const running = runSupervisedRuntime(app, {
      start: () => {}, completion: Promise.resolve(), stop: async () => { throw drainError; },
    }, () => signal.promise).catch((error: unknown) => error);
    try {
      expect(await running).toMatchObject({
        message: "Runtime failed or shutdown was incomplete.",
        errors: [new Error("Runtime polling terminated before shutdown was requested."), drainError],
      });
    } finally {
      signal.resolve();
      await running;
      stopApp.mockRestore();
      await app.dispose();
    }
  });
});
