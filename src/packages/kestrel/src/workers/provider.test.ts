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
import { z } from "zod";
import { defineWorker } from "./worker.js";
import { postgresWorkers } from "./adapters/postgres/index.js";
import type { PostgresWorkerDatabase } from "./adapters/postgres/index.js";
import type { WorkerAdapter } from "./types.js";

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
  it.each(["memory", "postgres"] as const)("passes publication limits to the %s adapter and client", async (backend) => {
    const app = new App({ name: "test" });
    const database = dep<PostgresWorkerDatabase>("publicationDatabase");
    // Rejection must happen before any PostgreSQL operation is attempted.
    app.container.registerValue(database.id, {} as PostgresWorkerDatabase);
    app.register(new WorkerProvider({ ...workersConfig, publication: { maxBatchSize: 1 } },
      backend === "memory" ? memoryWorkers() : postgresWorkers(database)));
    try {
      const adapter = app.container.resolve(dep<WorkerAdapter>("workerAdapter"));
      await expect(adapter.enqueue([
        { queue: "test", payload: 1 }, { queue: "test", payload: 2 },
      ])).rejects.toMatchObject({ budget: "maxBatchSize" });
      let validations = 0;
      const worker = defineWorker({
        name: "test", queue: "test",
        input: z.number().transform((value) => { validations++; return value; }),
        handler: () => {},
      });
      const client = app.container.resolve(workerClientDependency);
      await expect(client.enqueueMany(worker, [1, 2])).rejects.toMatchObject({ budget: "maxBatchSize" });
      expect(validations).toBe(0);
    } finally { await app.dispose(); }
  });

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
