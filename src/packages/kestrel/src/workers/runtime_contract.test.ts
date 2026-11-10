import { setImmediate } from "node:timers/promises";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import { defineAdmissionPolicy, localResourcePressure, LocalResourcePressureMonitor, MemoryRateLimitAdapter, ThrottlingManager } from "../throttling/index.js";
import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { workersConfigBase } from "./configuration.js";
import { WorkerRuntime } from "./runtime.js";
import { defineWorker } from "./worker.js";

const config = workersConfigBase.schema.parse({ pollIntervalMs: 10 });

/** Real applications make runtime drain registration part of every fixture. */
async function setup() {
  const app = new App<Record<string, never>>({});
  const adapter = new MemoryWorkerAdapter();
  const logger = { error: vi.fn() };
  const worker = defineWorker({ name: "runtime-contract", queue: "runtime-contract", input: z.null(), handler: (_job, _deps, context) => context.setResult("completed") });
  app.catalog.contribute({ workers: { worker } }, { kind: "application" });
  await app.start();
  return { app, adapter, logger, worker };
}

describe("worker runtime contracts", () => {
  it("coalesces drain ownership and prevents starting after stop", async () => {
    const { app, adapter, logger } = await setup();
    const runtime = new WorkerRuntime(app, adapter, config, logger as unknown as Logger);
    const stop = vi.spyOn(runtime.scheduler, "stop");
    try {
      expect(runtime.completion).toBeUndefined();
      runtime.start();
      expect(runtime.completion).toBeInstanceOf(Promise);
      const first = runtime.stop();
      expect(first).toBeInstanceOf(Promise);
      expect(runtime.stop()).toBe(first);
      await first;
      expect(stop).toHaveBeenCalledOnce();
      await runtime.completion;
      expect(() => runtime.start()).toThrow(Error);
    } finally {
      // Fixture cleanup owns the scheduler independently of the runtime drain
      // under test, including when a broken drain never requests polling stop.
      await runtime.scheduler.stop();
      await app.dispose();
    }
  });

  it("acknowledges a correlated job when no optional completion owner is installed", async () => {
    const { app, adapter, logger, worker } = await setup();
    const runtime = new WorkerRuntime(app, adapter, config, logger as unknown as Logger);
    try {
      await adapter.enqueue([{ queue: worker.queue, payload: null, correlation: { namespace: "external", id: "id" } }]);
      expect(await runtime.scheduler.runOnce()).toBe(1);
      expect(adapter.inspectJobs()).toEqual([]);
    } finally { await app.dispose(); }
  });

  it("reports polling failures and forwards correlated completion to its owner's receiver", async () => {
    const { app, adapter, logger, worker } = await setup();
    const failure = new Error("temporary storage failure");
    const sink = { complete: vi.fn(async function (this: unknown) { expect(this).toBe(sink); }) };
    const runtime = new WorkerRuntime(app, adapter, config, logger as unknown as Logger, undefined, undefined, sink);
    vi.spyOn(adapter, "listReadyQueues").mockRejectedValueOnce(failure);
    try {
      runtime.start();
      await setImmediate();
      await runtime.stop();
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({ err: failure }, expect.any(String));
    } finally { await app.dispose(); }

    // A second application gives the completion owner a fresh admission lifetime.
    const next = await setup();
    const completing = new WorkerRuntime(next.app, next.adapter, config, next.logger as unknown as Logger, undefined, undefined, sink);
    try {
      await next.adapter.enqueue([{ queue: worker.queue, payload: null, correlation: { namespace: "owner", id: "id" } }]);
      expect(await completing.scheduler.runOnce()).toBe(1);
      expect(sink.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "completed", result: "completed" }));
    } finally { await next.app.dispose(); }
  });

  it("passes reservation pressure and its throttling service to admission", async () => {
    const { app, adapter, logger, worker } = await setup();
    const throttling = new ThrottlingManager(new MemoryRateLimitAdapter(), { namespace: "runtime-contract", resourcePressureMonitor: new LocalResourcePressureMonitor([{ supports: (id) => id === "cpu", read: () => 0.95 }]) });
    const pressure = defineAdmissionPolicy({ id: "worker-contract-pressure", limits: [localResourcePressure({ id: "local-worker", signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } } })] });
    const runtime = new WorkerRuntime(app, adapter, config, logger as unknown as Logger, throttling, pressure);
    try {
      await adapter.enqueue([{ queue: worker.queue, payload: null }]);
      expect(await runtime.scheduler.runOnce()).toBe(0);
      expect(adapter.inspectJobs()).toHaveLength(1);
    } finally { await app.dispose(); await throttling.close(); }
  });

  it("aggregates scheduler stop and polling completion failures", async () => {
    const { app, adapter, logger } = await setup();
    const runtime = new WorkerRuntime(app, adapter, config, logger as unknown as Logger);
    const stopFailure = new Error("scheduler stop failed");
    const pollingFailure = new Error("polling failed");
    vi.spyOn(runtime.scheduler, "stop").mockRejectedValue(stopFailure);
    const completion = Promise.reject(pollingFailure);
    void completion.catch(() => undefined);
    vi.spyOn(runtime.scheduler, "completion", "get").mockReturnValue(completion);
    try {
      await expect(runtime.stop()).rejects.toMatchObject({ errors: [stopFailure, pollingFailure] });
      expect(runtime.stop()).toBe(runtime.stop());
    } finally {
      // Disposal still closes the application; its registered drain reports the
      // same deliberately failed runtime rather than swallowing that failure.
      await expect(app.dispose()).rejects.toBeInstanceOf(AggregateError);
      vi.restoreAllMocks();
    }
  });

  it("supervises polling termination and removes its process listeners", async () => {
    const { app, adapter, logger } = await setup();
    const runtime = new WorkerRuntime(app, adapter, config, logger as unknown as Logger);
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const previousListeners = new Set(process.listeners("SIGTERM"));
    const failure = new Error("unexpected polling termination");
    const completion = Promise.reject(failure);
    void completion.catch(() => undefined);
    const start = vi.spyOn(runtime.scheduler, "start").mockImplementation(() => undefined);
    vi.spyOn(runtime.scheduler, "completion", "get").mockReturnValue(completion);
    const stop = vi.spyOn(runtime.scheduler, "stop").mockResolvedValue();
    let settled = false;
    const running = runtime.run().catch((error: unknown) => error).finally(() => { settled = true; });
    const ownedListeners = process.listeners("SIGTERM").filter((listener) => !previousListeners.has(listener));
    try {
      // Wake only this runtime's captured listener after one turn. A mutation
      // that loses its completion promise then fails directly, without waiting
      // for the test timeout or emitting a process-wide signal.
      await setImmediate();
      expect(settled).toBe(true);
      for (const listener of ownedListeners) listener("SIGTERM");
      const result = await running;
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toContain(failure);
      expect(start).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      await setImmediate();
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    } finally {
      for (const listener of ownedListeners) listener("SIGTERM");
      await running;
      await app.dispose().catch(() => undefined);
      vi.restoreAllMocks();
    }
  });
});
