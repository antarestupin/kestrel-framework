import { setImmediate } from "node:timers/promises";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import type { Locks } from "../lock/index.js";
import { MemoryScheduledTaskAdapter } from "./adapters/memory/index.js";
import type { ScheduledTasksConfig } from "./configuration.js";
import { ScheduledTaskRuntime, selectScheduledTasks } from "./runtime.js";
import { every } from "./schedule.js";
import { ScheduledTaskScheduler } from "./scheduler.js";
import { defineScheduledTask } from "./task.js";

const epoch = new Date("2026-01-01T00:00:00.000Z");
const config: ScheduledTasksConfig = { slots: 1, leaseMs: 1_000, pollIntervalMs: 1_000, defaultState: "persistent", defaultCoordination: "local", expiredRunPruneBatchSize: 10, expiredRunPruneIntervalSeconds: 0 };
const tasks = [
  defineScheduledTask({ id: "first", groups: ["shared", "alpha"], schedule: every({ hours: 1 }), handler: () => undefined }),
  defineScheduledTask({ id: "second", groups: ["shared", "beta"], schedule: every({ hours: 1 }), handler: () => undefined }),
  defineScheduledTask({ id: "third", schedule: every({ hours: 1 }), handler: () => undefined }),
];
const owned: Array<{ app: App<Record<string, never>>; runtime: ScheduledTaskRuntime<Record<string, never>> }> = [];
afterEach(async () => {
  try {
    for (const { app, runtime } of owned.splice(0)) {
      try { await runtime.stop(); } finally { await app.dispose(); }
    }
  } finally { vi.useRealTimers(); }
});

/** Compose real runtime ownership without transport listeners or process signal handlers. */
async function setup(definitions = tasks, runtimeConfig = config) {
  const app = new App<Record<string, never>>({});
  app.catalog.scheduledTasks.registerMany(definitions, { kind: "application" });
  const adapter = new MemoryScheduledTaskAdapter({ now: () => epoch });
  const logger = { error: vi.fn() } as unknown as Logger;
  const locks = { tryAcquire: vi.fn() } as unknown as Locks;
  const runtime = new ScheduledTaskRuntime(app, adapter, locks, runtimeConfig, logger);
  owned.push({ app, runtime });
  await app.start();
  return { app, adapter, runtime, logger, locks };
}

describe("scheduled task selection", () => {
  it("preserves the full declaration order without filters", () => {
    expect(selectScheduledTasks(tasks, { taskIds: [], groups: [] })).toBe(tasks);
  });
  it("forms a de-duplicated union of explicit ids and group membership", () => {
    expect(selectScheduledTasks(tasks, { taskIds: ["third", "first"], groups: ["alpha"] })).toEqual([tasks[0], tasks[2]]);
    expect(selectScheduledTasks(tasks, { taskIds: ["third"], groups: ["beta"] })).toEqual([tasks[1], tasks[2]]);
    expect(selectScheduledTasks(tasks, { taskIds: [], groups: ["shared"] })).toEqual([tasks[0], tasks[1]]);
    expect(selectScheduledTasks(tasks, { taskIds: ["second"], groups: [] })).toEqual([tasks[1]]);
  });
  it.each([
    { taskIds: ["missing"], groups: [] },
    { taskIds: [], groups: ["missing"] },
  ])("rejects unknown selections before polling: %j", (selection) => {
    expect(() => selectScheduledTasks(tasks, selection)).toThrow(TypeError);
  });
});

describe("ScheduledTaskRuntime", () => {
  it("coalesces ordinary concurrent starts and exposes one polling completion", async () => {
    // Keep polling timers under test ownership while checking one event-loop turn.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runtime, adapter } = await setup();
    const reconcile = vi.spyOn(adapter, "reconcile");
    const build = vi.spyOn(runtime, "buildScheduler");
    try {
      expect(runtime.completion).toBeUndefined();
      await Promise.all([runtime.start({ taskIds: ["second"], groups: [] }), runtime.start()]);
      expect(reconcile).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ taskId: "second" })]);
      const completion = runtime.completion;
      expect(completion).toBeInstanceOf(Promise);
      const outcomes: PromiseSettledResult<void>[] = [];
      void Promise.all([runtime.stop(), completion]).then(
        () => outcomes.push({ status: "fulfilled", value: undefined }),
        (reason: unknown) => outcomes.push({ status: "rejected", reason }),
      );
      await setImmediate();
      expect(outcomes).toEqual([{ status: "fulfilled", value: undefined }]);
      await expect(runtime.start()).rejects.toThrow(/stopped/);
    } finally {
      // The fixture owns the built scheduler even if the runtime's stop is removed.
      await build.mock.results.find((result) => result.type === "return")?.value.stop();
    }
  });

  it("publishes startup ownership before a synchronous adapter callback reenters start", async () => {
    const { runtime, adapter } = await setup();
    let reentered: Promise<void> | undefined;
    const original = adapter.reconcile.bind(adapter);
    vi.spyOn(adapter, "reconcile").mockImplementation((registrations) => {
      // Capture rejection immediately so the regression never leaks an unhandled promise.
      reentered = runtime.start();
      void reentered.catch(() => undefined);
      return original(registrations);
    });
    await runtime.start();
    expect(reentered).toBeInstanceOf(Promise);
    await expect(reentered).resolves.toBeUndefined();
    expect(adapter.reconcile).toHaveBeenCalledOnce();
  });

  it("drains pending initialization before runtime stop resolves", async () => {
    const { runtime, adapter } = await setup();
    const gate = Promise.withResolvers<void>();
    vi.spyOn(adapter, "reconcile").mockReturnValue(gate.promise);
    const started = runtime.start();
    const stopping = runtime.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    try {
      await setImmediate();
      expect(stopped).toBe(false);
    } finally { gate.resolve(); await started; await stopping; }
    expect(runtime.completion).toBeUndefined();
  });

  it("rejects an invalid selection without initializing adapter state", async () => {
    const { runtime, adapter } = await setup();
    const reconcile = vi.spyOn(adapter, "reconcile");
    await expect(runtime.start({ taskIds: ["missing"], groups: [] })).rejects.toThrow(TypeError);
    expect(reconcile).not.toHaveBeenCalled();
  });
});


// Supervision uses its own signal listener; invoking that listener avoids signalling other tests.
describe("scheduled task runtime supervision", () => {
  it("forwards selection, waits for shutdown, drains polling and removes signal listeners", async () => {
    const { app, runtime } = await setup();
    const selection = { taskIds: ["second"], groups: [] };
    const start = vi.spyOn(runtime, "start");
    const stop = vi.spyOn(runtime, "stop");
    const once = vi.spyOn(process, "once");
    const before = process.listenerCount("SIGTERM");
    const running = runtime.run(selection);
    void running.catch(() => undefined);
    const requestShutdown = () => once.mock.calls.find(([event]) => event === "SIGTERM")?.[1]();
    try {
      await setImmediate();
      expect(start).toHaveBeenCalledExactlyOnceWith(selection);
      expect(runtime.completion).toBeInstanceOf(Promise);
      expect(process.listenerCount("SIGTERM")).toBe(before + 1);
      requestShutdown();
      await running;
      expect(stop).toHaveBeenCalled();
      expect(app.state).toBe("stopping");
      expect(process.listenerCount("SIGTERM")).toBe(before);
    } finally {
      requestShutdown();
      await runtime.stop();
      await running;
      once.mockRestore();
    }
  });

  it("registers its own application drain even when no supervisor owns stop", async () => {
    const { app, runtime } = await setup();
    const stop = vi.spyOn(runtime, "stop");
    await runtime.start();
    await app.stop();
    expect(stop).toHaveBeenCalledOnce();
    await runtime.completion;
  });

  it("forwards task execution failure to its injected logger", async () => {
    const error = new Error("task execution failure");
    const failing = defineScheduledTask({ id: "failure", schedule: every({ seconds: 1, start: "immediate" }), handler: () => { throw error; } });
    const { runtime, logger } = await setup([failing]);
    const scheduler = runtime.buildScheduler();
    try {
      expect(await scheduler.runOnce()).toBe(1);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({ err: error }, expect.stringContaining("Scheduled task"));
    } finally { await scheduler.stop(); }
  });
});


it("forwards the configured default state and coordination into its scheduler", async () => {
  const handler = vi.fn();
  const task = defineScheduledTask({ id: "forward-defaults", schedule: every({ seconds: 1, start: "immediate" }), handler });
  // Empty/omitted policies fall through to persistent/local; use the opposite combination.
  const { runtime, adapter, locks } = await setup([task], { ...config, defaultState: "memory", defaultCoordination: "distributed" });
  vi.mocked(locks.tryAcquire).mockResolvedValue({
    key: `scheduled-task:${task.id}`, expiresAt: new Date(Date.now() + config.leaseMs), fencingToken: 1n,
    extend: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
  });
  const reconcile = vi.spyOn(adapter, "reconcile");
  const scheduler = runtime.buildScheduler();
  try {
    expect(await scheduler.runOnce()).toBe(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(locks.tryAcquire).toHaveBeenCalledExactlyOnceWith(`scheduled-task:${task.id}`, { ttlMs: config.leaseMs });
  } finally { await scheduler.stop(); }
});

it("propagates fatal polling completion through supervision and removes signal listeners", async () => {
  const { app, runtime, adapter, locks } = await setup();
  const failure = new Error("fatal polling completion");
  const scheduler = new ScheduledTaskScheduler(app, { persistent: adapter }, locks, tasks, {
    slots: 1, leaseMs: 1_000, defaultRuntime: { state: "persistent", coordination: "local" }, sleep: async () => { throw failure; },
  });
  vi.spyOn(runtime, "buildScheduler").mockReturnValue(scheduler);
  const once = vi.spyOn(process, "once");
  const before = process.listenerCount("SIGTERM");
  const outcomes: Array<{ status: string; reason?: unknown }> = [];
  const running = runtime.run();
  void running.then(() => outcomes.push({ status: "fulfilled" }), (reason: unknown) => outcomes.push({ status: "rejected", reason }));
  try {
    // The controlled sleep rejects immediately; one turn drains this finite startup chain.
    await setImmediate();
    expect(outcomes).toEqual([{ status: "rejected", reason: failure }]);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  } finally {
    once.mock.calls.find(([event]) => event === "SIGTERM")?.[1]();
    await runtime.stop();
    await running.catch(() => undefined);
    once.mockRestore();
  }
});
