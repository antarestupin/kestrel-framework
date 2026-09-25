import {
  describe,
  expect,
  it,
} from "vitest";

import { App } from "../app/index.js";
import type {
  PostgresWorkerAdapter,
  PostgresWorkerDatabase,
} from "./adapters/index.js";
import { WorkerClient } from "./client.js";
import type { WorkersConfig } from "./configuration.js";
import { workerClientDependency } from "./dependencies.js";
import { WorkerProvider } from "./provider.js";
import { MemoryWorkerAdapter } from "./adapters/memory/index.js";

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

class CustomizedWorkerProvider extends WorkerProvider<{ name: string }> {
  public adapterCreated = false;
  public clientCreated = false;

  public get configuredSlots(): number {
    return this.config.slots;
  }

  protected override createAdapter(
    _database: PostgresWorkerDatabase,
  ): PostgresWorkerAdapter {
    this.adapterCreated = true;
    return {} as PostgresWorkerAdapter;
  }

  protected override createClient(
    _adapter: PostgresWorkerAdapter,
  ): WorkerClient {
    this.clientCreated = true;
    return {} as WorkerClient;
  }
}

describe("WorkerProvider", () => {
  it("accepts an adapter that does not depend on PostgreSQL", async () => {
    const app = new App({ name: "test" });
    const adapter = new MemoryWorkerAdapter();

    app.register(new WorkerProvider(workersConfig, { adapter }));

    const client = app.container.resolve(workerClientDependency);
    expect(client).toBeInstanceOf(WorkerClient);
    expect(app.container.hasRegistration("database")).toBe(false);
    await app.dispose();
  });

  it("accepts dedicated configuration and protected construction overrides", async () => {
    const app = new App({ name: "test" });
    const provider = new CustomizedWorkerProvider(workersConfig);

    app.container.registerValue(
      "database",
      {} as PostgresWorkerDatabase,
    );
    app.register(provider);

    expect(app.container.resolve(workerClientDependency)).toEqual({});
    expect(provider.adapterCreated).toBe(true);
    expect(provider.clientCreated).toBe(true);
    expect(provider.configuredSlots).toBe(2);

    await app.dispose();
  });
});
