import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { App, defineCatalog } from "../app/index.js";
import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { workersConfigBase } from "./configuration.js";
import { WorkerRuntime } from "./runtime.js";
import { defineWorker } from "./worker.js";

it("retains borrowed infrastructure until pre-scope storage settles even with release shutdown", async () => {
  // This shutdown fixture does not consume a job payload.
  const worker = defineWorker({ name: "drain.storage", queue: "drain", input: z.object({}), handler: () => undefined });
  const cleanupBudgetMs = 100;
  const app = new App({}, {
    catalog: defineCatalog({ runtime: { workers: { worker } } }),
    shutdown: { timeoutMs: cleanupBudgetMs },
  });
  const close = vi.fn();
  app.container.registerValue("resource", {}, { dispose: close });
  const adapter = new MemoryWorkerAdapter();
  const storageFinished = Promise.withResolvers<readonly string[]>();
  const list = vi.spyOn(adapter, "listReadyQueues").mockReturnValue(storageFinished.promise);
  const runtime = new WorkerRuntime(app, adapter, workersConfigBase.schema.parse({ shutdownBehavior: "release" }),
    { error: vi.fn() } as never);
  const stop = runtime.scheduler.stop.bind(runtime.scheduler);
  let schedulerStopped = false;
  vi.spyOn(runtime.scheduler, "stop").mockImplementation(async (behavior) => {
    await stop(behavior);
    schedulerStopped = true;
  });
  const outcomes: PromiseSettledResult<void>[] = [];
  let disposing: Promise<void> | undefined;
  vi.useFakeTimers();
  try {
    await app.start();
    runtime.start();
    await setImmediate();
    expect(list).toHaveBeenCalledOnce();
    disposing = app.dispose();
    void disposing.then(
      (value) => outcomes.push({ status: "fulfilled", value }),
      (reason: unknown) => outcomes.push({ status: "rejected", reason }),
    );
    await setImmediate();
    expect(schedulerStopped).toBe(true);
    expect(close).not.toHaveBeenCalled();
    storageFinished.resolve([]);
    await setImmediate();
    expect(outcomes).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(close).toHaveBeenCalledOnce();
    expect(app.state).toBe("disposed");
  } finally {
    storageFinished.resolve([]);
    try {
      // Release the fixture even when the mutated scheduler never exits polling.
      disposing ??= app.dispose();
      void disposing.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(cleanupBudgetMs);
      await disposing.catch(() => undefined);
      // A simulated deadline can end App.dispose before it reaches the container.
      await app.container.dispose();
    } finally {
      vi.useRealTimers();
    }
  }
});
