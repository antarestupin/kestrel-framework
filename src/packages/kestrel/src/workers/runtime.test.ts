import { expect, it, vi } from "vitest";
import { App, defineCatalog } from "../app/index.js";
import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { workersConfigBase } from "./configuration.js";
import { WorkerRuntime } from "./runtime.js";
import { defineWorker } from "./worker.js";

it("retains borrowed infrastructure until pre-scope storage settles even with release shutdown", async () => {
  const worker = defineWorker({ name: "drain.storage", queue: "drain", handler: () => undefined });
  const app = new App({}, { catalog: defineCatalog({ runtime: { workers: { worker } } }) });
  const close = vi.fn();
  app.container.registerValue("resource", {}, { dispose: close });
  const adapter = new MemoryWorkerAdapter();
  const storageStarted = Promise.withResolvers<void>();
  const storageFinished = Promise.withResolvers<readonly string[]>();
  const released = Promise.withResolvers<void>();
  vi.spyOn(adapter, "listReadyQueues").mockImplementation(() => {
    storageStarted.resolve();
    return storageFinished.promise;
  });
  const originalRelease = adapter.release.bind(adapter);
  vi.spyOn(adapter, "release").mockImplementation(async (reservations) => {
    const result = await originalRelease(reservations);
    released.resolve();
    return result;
  });
  const runtime = new WorkerRuntime(app, adapter, workersConfigBase.schema.parse({ shutdownBehavior: "release" }),
    { error: vi.fn() } as never);
  await app.start();
  runtime.start();
  await storageStarted.promise;
  const disposing = app.dispose();
  try {
    await released.promise;
    // Run the rest of the current cleanup turn before examining ownership.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).not.toHaveBeenCalled();
    storageFinished.resolve([]);
    await disposing;
    expect(close).toHaveBeenCalledOnce();
    expect(app.state).toBe("disposed");
  } finally { storageFinished.resolve([]); await disposing; }
});
