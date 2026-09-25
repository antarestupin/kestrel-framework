import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import {
  AsyncLocalObserverContext,
  type ObservationEvent,
  type ObservationRecorder,
  ScopedObserver,
} from "../observability/index.js";
import { setExecutionLogEnabledDependency } from "../log/index.js";
import { MemoryScheduledTaskAdapter } from "./adapters/memory/index.js";
import { every, loop } from "./schedule.js";
import { ScheduledTaskScheduler } from "./scheduler.js";
import { defineScheduledTask } from "./task.js";

/** Creates an application that captures scoped task observations in memory. */
async function createObservedApp(): Promise<{
  app: App<Record<string, never>>;
  events: ObservationEvent[];
}> {
  const app = new App<Record<string, never>>({});
  const events: ObservationEvent[] = [];
  const observerContext = new AsyncLocalObserverContext();
  const recorder: ObservationRecorder = {
    enqueue: (event) => events.push(event),
    flush: async () => {},
    close: async () => {},
    getHealth: () => ({
      status: "healthy",
      pendingCount: 0,
      droppedCount: 0,
      droppedByOverflow: 0,
      droppedByStorageFailure: 0,
      consecutiveStorageFailures: 0,
    }),
  };
  app.container.registerValue("observationRecorder", recorder);
  app.container.registerValue("observerContext", observerContext);
  app.container.registerFactory(
    "observer",
    ({ executionId, observationRecorder }: {
      executionId: string;
      observationRecorder: ObservationRecorder;
    }) => new ScopedObserver(executionId, observationRecorder),
    { lifetime: "scoped" },
  );
  await app.start();
  return { app, events };
}

/** Creates a running application for scheduler-only tests. */
async function createStartedApp(): Promise<App<Record<string, never>>> {
  const app = new App<Record<string, never>>({});

  await app.start();

  return app;
}

describe("ScheduledTaskScheduler", () => {
  it("runs a due task in an observed execution scope", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const { app, events } = await createObservedApp();
    const handler = vi.fn();
    const task = defineScheduledTask({
      id: "maintenance.cache",
      schedule: every({ minutes: 1, start: "immediate" }),
      runtime: { state: "memory", coordination: "local" },
      handler,
    });
    const scheduler = new ScheduledTaskScheduler(
      app,
      { memory: adapter },
      undefined,
      [task],
      { slots: 1, leaseMs: 10_000, now: () => now },
    );

    await expect(scheduler.runOnce()).resolves.toBe(1);

    expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({
      scheduledAt: now,
      trigger: "scheduled",
      signal: expect.any(AbortSignal),
    }));
    expect(events.map((event) => event.name)).toEqual([
      "execution.started",
      "execution.completed",
    ]);
    expect(events[0]?.data).toEqual({
      operation: "maintenance.cache",
      transport: "scheduled-task",
    });
    expect(task.executionLog).toBe(true);
    expect(task.observe).toBe(true);
  });

  it.each([
    { configured: undefined, expected: true, label: "the default" },
    { configured: false, expected: false, label: "a local override" },
  ])("applies $label observation policy", async ({
    configured,
    expected,
  }) => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const { app, events } = await createObservedApp();
    const handler = vi.fn(({
      observerContext,
    }: {
      observerContext: AsyncLocalObserverContext;
    }) => {
      expect(observerContext.get() !== undefined).toBe(expected);
    });
    const task = defineScheduledTask({
      id: "observation.policy",
      schedule: every({ minutes: 1, start: "immediate" }),
      runtime: { state: "memory", coordination: "local" },
      dependencies: {
        observerContext: dep<AsyncLocalObserverContext>("observerContext"),
      },
      ...(configured === undefined ? {} : { observe: configured }),
      handler,
    });
    const scheduler = new ScheduledTaskScheduler(
      app,
      { memory: adapter },
      undefined,
      [task],
      { slots: 1, leaseMs: 10_000, now: () => now },
    );

    await scheduler.runOnce();

    expect(handler).toHaveBeenCalledOnce();
    expect(task.observe).toBe(expected);
    expect(events).toHaveLength(expected ? 2 : 0);
    await app.dispose();
  });

  it.each([
    { configured: undefined, expected: true, label: "the default" },
    { configured: false, expected: false, label: "a local override" },
  ])("applies $label execution-log policy", async ({
    configured,
    expected,
  }) => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const app = new App({});
    await app.start();
    const setExecutionLogEnabled = vi.fn();
    const task = defineScheduledTask({
      id: "logging.policy",
      schedule: every({ minutes: 1, start: "immediate" }),
      runtime: { state: "memory", coordination: "local" },
      ...(configured === undefined ? {} : { executionLog: configured }),
      handler: () => undefined,
    });

    app.container.registerFactory(
      setExecutionLogEnabledDependency.id,
      () => setExecutionLogEnabled,
      { lifetime: "scoped" },
    );
    const scheduler = new ScheduledTaskScheduler(
      app,
      { memory: adapter },
      undefined,
      [task],
      { slots: 1, leaseMs: 10_000, now: () => now },
    );

    await scheduler.runOnce();

    expect(task.executionLog).toBe(expected);
    expect(setExecutionLogEnabled).toHaveBeenCalledWith(expected);
    await app.dispose();
  });

  it("applies handler deferrals without moving a manual run", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const task = defineScheduledTask({
      id: "adaptive-loop",
      schedule: loop({ delay: { minutes: 1 } }),
      runtime: { state: "memory", coordination: "local" },
      handler: (_dependencies, context) => {
        context.deferNextRun({ minutes: 5 });
      },
    });
    const scheduler = new ScheduledTaskScheduler(
      await createStartedApp(),
      { memory: adapter },
      undefined,
      [task],
      { slots: 1, leaseMs: 10_000, now: () => now },
    );

    await scheduler.runOnce();
    expect(adapter.inspectStates()[0]?.nextScheduledAt)
      .toEqual(new Date("2026-01-01T00:05:00.000Z"));

    now = new Date("2026-01-01T00:01:00.000Z");
    await adapter.requestRun(task.id);
    await scheduler.runOnce();
    expect(adapter.inspectStates()[0]?.nextScheduledAt)
      .toEqual(new Date("2026-01-01T00:05:00.000Z"));
  });

  it("allows an explicit manual run while regular scheduling is paused", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const handler = vi.fn();
    const task = defineScheduledTask({
      id: "paused.manual",
      schedule: every({ hours: 1 }),
      runtime: { state: "memory", coordination: "local" },
      handler,
    });
    const scheduler = new ScheduledTaskScheduler(
      await createStartedApp(),
      { memory: adapter },
      undefined,
      [task],
      { slots: 1, leaseMs: 10_000, now: () => now },
    );
    await scheduler.runOnce();
    await adapter.setPaused(task.id, true);
    await adapter.requestRun(task.id);

    await expect(scheduler.runOnce()).resolves.toBe(1);
    expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({
      trigger: "manual",
    }));
  });

  it("coalesces a waiting overlap until the active run completes", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    let release = (): void => undefined;
    const firstRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue(undefined);
    const task = defineScheduledTask({
      id: "overlap.wait",
      schedule: every({ minutes: 1, start: "immediate" }),
      overlap: "wait",
      runtime: { state: "memory", coordination: "local" },
      handler,
    });
    const scheduler = new ScheduledTaskScheduler(
      await createStartedApp(),
      { memory: adapter },
      undefined,
      [task],
      { slots: 2, leaseMs: 10_000, now: () => now },
    );

    const running = scheduler.runOnce();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    now = new Date("2026-01-01T00:01:00.000Z");
    await expect(scheduler.runOnce()).resolves.toBe(0);
    release();
    await running;
    await expect(scheduler.runOnce()).resolves.toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
