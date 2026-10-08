import {
  describe,
  expect,
  it,
} from "vitest";

import { App } from "../app/index.js";
import { WorkerClient } from "./client.js";
import type { WorkersConfig } from "./configuration.js";
import { workerClientDependency } from "./dependencies.js";
import { WorkerProvider } from "./provider.js";
import { memoryWorkers } from "./adapters/memory/index.js";
import { defineWorkerAdapter } from "./adapter_definition.js";
import { dep } from "../di/index.js";

const workersConfig: WorkersConfig = {
  slots: 2,
  leaseMs: 30_000,
  reservationLimit: 10,
  pollIntervalMs: 100,
  readyQueueRefreshMs: 100,
  ackBufferSize: 10,
  ackFlushIntervalMs: 10,
  deferBufferSize: 10,
  deferFlushIntervalMs: 10,
  shutdownBehavior: "wait",
};

describe("WorkerProvider", () => {
  it("accepts an adapter that does not depend on PostgreSQL", async () => {
    const app = new App({ name: "test" });
    const adapter = memoryWorkers();

    app.register(new WorkerProvider(workersConfig, adapter));

    const client = app.container.resolve(workerClientDependency);
    expect(client).toBeInstanceOf(WorkerClient);
    expect(app.container.hasRegistration("database")).toBe(false);
    await app.dispose();
  });

  it("resolves an external backend once, after its infrastructure is registered", async () => {
    const connection = dep<{ calls: number }>("externalQueue");
    let created = 0;
    const app = new App({ name: "test" }).register(new WorkerProvider(workersConfig, defineWorkerAdapter({
      dependencies: { connection },
      capabilities: {},
      create: ({ connection }) => {
        connection.calls++;
        created++;
        return {} as import("./types.js").WorkerAdapter;
      },
    })));
    try {
      expect(created).toBe(0);
      const client = { calls: 0 };
      app.container.registerValue(connection.id, client);
      const first = app.container.resolve(workerClientDependency);
      expect(app.container.resolve(workerClientDependency)).toBe(first);
      expect(client.calls).toBe(1);
      expect(created).toBe(1);
    } finally { await app.dispose(); }
  });
});
