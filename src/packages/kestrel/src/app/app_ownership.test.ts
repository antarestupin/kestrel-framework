import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineEvent, EventBus } from "../events/index.js";
import { createDependencyContainer, dep } from "../di/index.js";
import { DeferredTasks } from "../concurrency/index.js";
import {
  App,
  applicationStartedEvent,
  ApplicationShutdownTimeoutError,
  bootstrapCompletedEvent,
  bootstrapStartedEvent,
  executionCompletedEvent,
  executionStartedEvent,
  ExecutionScope,
  runtimeStartedEvent,
  type Provider,
} from "./index.js";

afterEach(() => vi.useRealTimers());

describe("application ownership boundaries", () => {
  it("registers shared defaults and preserves explicitly supplied infrastructure registrations", async () => {
    const defaults = new App({});
    const container = createDependencyContainer({});
    const tasks = new DeferredTasks();
    const eventBus = new EventBus({}, tasks);
    const bootPlan = { workloads: [], runningMode: "minimal", runtime: "worker" };
    container.registerValue("deferredTasks", tasks);
    container.registerValue("eventBus", eventBus);
    container.registerValue("bootPlan", bootPlan);
    const registration = vi.spyOn(container, "registerValue");
    const explicit = new App({}, { container });
    try {
      expect(defaults.bootPlan).toEqual({ workloads: [], runningMode: "standard", runtime: "command" });
      expect(defaults.container.resolve(dep("deferredTasks"))).toBe(defaults.tasks);
      expect(defaults.container.resolve(dep("eventBus"))).toBe(defaults.eventBus);
      expect(defaults.container.resolve(dep("bootPlan"))).toBe(defaults.bootPlan);
      expect(explicit.tasks).toBe(tasks);
      expect(explicit.eventBus).toBe(eventBus);
      expect(container.resolve(dep("bootPlan"))).toBe(bootPlan);
      expect(registration.mock.calls.map(([name]) => name)).toEqual(["errorHandler"]);
    } finally {
      registration.mockRestore();
      await Promise.all([defaults.dispose(), explicit.dispose()]);
    }
  });

  it("closes the partial execution when resolving its error handler fails", async () => {
    const app = new App({});
    const container = app.container.createScope();
    const createScope = vi.spyOn(app.container, "createScope").mockReturnValue(container);
    const failure = new Error("Scoped error handler failed");
    const release = vi.fn();
    const complete = vi.fn();
    const pending = Promise.withResolvers<void>();
    const testEvent = defineEvent({ name: "execution.ownership.test", schema: z.object({}) });
    let bus: EventBus | undefined;
    app.container.registerFactory("resource", () => ({}), { lifetime: "scoped", dispose: release });
    app.container.registerFactory("errorHandler", ({ resource, eventBus, deferredTasks }: {
      resource: object; eventBus: EventBus; deferredTasks: DeferredTasks;
    }) => {
      // A user factory may borrow scoped dependencies before it fails to initialize.
      expect(resource).toBeDefined();
      bus = eventBus;
      bus.listen(testEvent, () => {});
      deferredTasks.defer(async () => { await pending.promise; complete(); });
      throw failure;
    }, { lifetime: "scoped" });

    let rejected: Promise<unknown> | undefined;
    try {
      await app.start();
      rejected = app.createExecutionScope().catch((error: unknown) => error);
      // Keep borrowed resources live until work queued during failed construction settles.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(release).not.toHaveBeenCalled();
      pending.resolve();
      expect(await rejected).toBe(failure);
      expect(complete).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(bus).toBeDefined();
      expect(() => bus!.dispatch(testEvent, {})).toThrow(/closed/u);
    } finally {
      pending.resolve();
      const result = await rejected;
      if (result instanceof ExecutionScope) await result.dispose();
      createScope.mockRestore();
      bus?.close();
      await container.dispose();
      await app.dispose();
    }
  });

  it("freezes the finalized boot plan before a provider or bootstrap listener observes it", async () => {
    const app = new App({});
    const observed: unknown[] = [];
    const plan = app.bootPlan;
    app.prepareBootPlan(["http", "workers", "http"], "minimal", "background");
    app.eventBus.listen(bootstrapStartedEvent, () => {
      observed.push(app.bootPlan);
      expect(Reflect.set(app.bootPlan, "runtime", "command")).toBe(false);
      expect(Reflect.set(app.bootPlan.workloads, 0, "workflows")).toBe(false);
    });
    app.register({
      register() {},
      boot({ bootPlan, container }) {
        observed.push(bootPlan, container.resolve(dep("bootPlan")));
        expect(Object.isFrozen(bootPlan)).toBe(true);
        expect(Object.isFrozen(bootPlan.workloads)).toBe(true);
      },
    });

    try {
      await app.start();
      expect(observed).toHaveLength(3);
      expect(observed.every((item) => item === plan)).toBe(true);
      expect(plan).toEqual({ workloads: ["http", "workers"], runningMode: "minimal", runtime: "background" });
    } finally {
      await app.dispose();
    }
  });

  it("applies the standard command defaults and refuses a first startup after disposal", async () => {
    const app = new App({});
    app.prepareBootPlan(["http"], "minimal", "server");
    app.prepareBootPlan(["workers"]);
    expect(app.bootPlan).toEqual({ workloads: ["workers"], runningMode: "standard", runtime: "command" });
    await app.dispose();
    await expect(app.start()).rejects.toThrow("Cannot start an application while it is disposed.");
  });

  it("announces a cancelled outcome and removes a scope when an execution start listener fails", async () => {
    const app = new App({});
    const failure = new Error("Execution start listener failed");
    const completed = vi.fn();
    app.eventBus.listenAsync(executionStartedEvent, async () => { throw failure; }, { scope: "descendants" });
    app.eventBus.listen(executionCompletedEvent, completed, { scope: "descendants" });
    let started: Promise<unknown> | undefined;
    try {
      await app.start();
      started = app.createExecutionScope("interrupted").catch((error: unknown) => error);
      expect(await started).toBe(failure);
      expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        executionId: "interrupted", outcome: "cancelled",
      }), expect.anything());
      await expect(app.dispose()).resolves.toBeUndefined();
    } finally {
      const result = await started;
      if (result instanceof ExecutionScope) await result.dispose();
      await app.dispose();
    }
  });

  it("exposes the scoped owner and tasks and removes disposed scopes from application draining", async () => {
    const app = new App({});
    await app.start();
    const scope = await app.createExecutionScope();
    const settled = scope.whenDisposed;
    const readDisposal = vi.fn(() => settled);
    Object.defineProperty(scope, "whenDisposed", { get: readDisposal });
    try {
      expect(scope.container.resolve(dep("execution"))).toBe(scope);
      expect(scope.container.resolve(dep("deferredTasks"))).toBe(scope.tasks);
      await scope.dispose();
      await app.dispose();
      // An app that kept the disposed scope would read this promise during its drain.
      expect(readDisposal).not.toHaveBeenCalled();
    } finally {
      await scope.dispose();
      await app.dispose();
    }
  });

  it("reports measured startup durations for a provider without a constructor", async () => {
    let now = 10;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const app = new App({});
    const startup = vi.fn();
    const provider: Provider<{}> = {
      register() { now = 22.346; },
      boot() { now = 47.346; },
    };
    Object.setPrototypeOf(provider, null);
    app.eventBus.listen(bootstrapStartedEvent, () => { now = 45; });
    app.eventBus.listen(runtimeStartedEvent, () => { now = 55; });
    app.eventBus.listen(applicationStartedEvent, startup);
    try {
      now = 20;
      app.register(provider);
      now = 40;
      await app.start();
      expect(startup).toHaveBeenCalledExactlyOnceWith({
        runtime: "command",
        durations: {
          bootstrapMs: 15,
          compositionMs: 30,
          totalMs: 45,
          providers: {
            boot: [{ provider: "AnonymousProvider", durationMs: 2.35 }],
            composition: [{ provider: "AnonymousProvider", durationMs: 2.35 }],
          },
        },
      }, expect.anything());
    } finally {
      clock.mockRestore();
      await app.dispose();
    }
  });

  it("never announces successful bootstrap after the last provider outlives shutdown", async () => {
    vi.useFakeTimers();
    const app = new App({}, { shutdown: { timeoutMs: 30, drainMs: 20 } });
    let entered = false;
    const release = Promise.withResolvers<void>();
    const completed = vi.fn();
    app.eventBus.listen(bootstrapCompletedEvent, completed);
    app.register({ register() {}, boot: () => { entered = true; return release.promise; } });
    const starting = app.start().catch((error: unknown) => error);
    let disposed: Promise<unknown> | undefined;

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(entered).toBe(true);
      disposed = app.dispose().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30);
      const disposalError = await disposed;
      expect(app.shutdown.error).toBeInstanceOf(ApplicationShutdownTimeoutError);
      expect(disposalError instanceof AggregateError ? disposalError.errors : [disposalError])
        .toContain(app.shutdown.error);
      release.resolve();
      expect(await starting).toBe(app.shutdown.error);
      expect(app.state).toBe("shutdownTimedOut");
      expect(completed).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await starting;
      await disposed;
      app.shutdown.finish();
      await app.tasks.close();
      app.eventBus.close();
      await app.container.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    { stage: "bootstrap.started", expected: ["bootstrap.started"] },
    { stage: "provider boot", expected: ["bootstrap.started"] },
    { stage: "bootstrap.completed", expected: ["bootstrap.started", "bootstrap.completed"] },
    { stage: "runtime.started", expected: ["bootstrap.started", "bootstrap.completed", "runtime.started"] },
    { stage: "application.started", expected: ["bootstrap.started", "bootstrap.completed", "runtime.started", "application.started"] },
  ])("does not advance startup beyond $stage once shutdown expires", async ({ stage, expected }) => {
    vi.useFakeTimers();
    const app = new App({}, { shutdown: { timeoutMs: 30, drainMs: 20 } });
    const blocked = Promise.withResolvers<void>();
    let entered = false;
    const hold = () => { entered = true; return blocked.promise; };
    const events: string[] = [];
    const nextProvider = vi.fn();
    app.eventBus.listen(bootstrapStartedEvent, () => { events.push("bootstrap.started"); });
    app.eventBus.listen(bootstrapCompletedEvent, () => { events.push("bootstrap.completed"); });
    app.eventBus.listen(runtimeStartedEvent, () => { events.push("runtime.started"); });
    app.eventBus.listen(applicationStartedEvent, () => { events.push("application.started"); });
    if (stage === "bootstrap.started") app.eventBus.listenAsync(bootstrapStartedEvent, hold);
    if (stage === "provider boot") {
      app.register({ register() {}, boot: hold });
      app.register({ register() {}, boot: nextProvider });
    }
    if (stage === "bootstrap.completed") app.eventBus.listenAsync(bootstrapCompletedEvent, hold);
    if (stage === "runtime.started") app.eventBus.listenAsync(runtimeStartedEvent, hold);
    if (stage === "application.started") app.eventBus.listenAsync(applicationStartedEvent, hold);
    const starting = app.start().catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(entered).toBe(true);
      app.shutdown.begin();
      await vi.advanceTimersByTimeAsync(30);
      blocked.resolve();
      expect(app.shutdown.error).toBeInstanceOf(ApplicationShutdownTimeoutError);
      expect(await starting).toBe(app.shutdown.error);
      expect(app.state).toBe("shutdownTimedOut");
      expect(events).toEqual(expected);
      expect(nextProvider).not.toHaveBeenCalled();
    } finally {
      blocked.resolve();
      await starting;
      app.shutdown.finish();
      await app.tasks.close();
      app.eventBus.close();
      await app.container.dispose();
      vi.useRealTimers();
    }
  });
});
