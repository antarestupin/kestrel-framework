import type { Pool } from "pg";
import type { Logger } from "pino";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import type { ObservationConfig } from "./configuration.js";
import { PostgresObservationStore } from "./db/observation_store.js";
import {
  DelegatingObservationRecorder,
  type ObservationEvent,
  type ObservationRecorder,
  type Observer,
} from "./observer.js";
import type { ObserverContext } from "./context.js";
import { ObservationProvider } from "./provider.js";

const config: ObservationConfig = {
  enabled: true,
  retentionDays: 7,
  overflowPolicy: "drop-new",
  failurePolicy: "best-effort",
  buffer: {
    batchSize: 50,
    flushIntervalMs: 100,
    maxQueueSize: 10_000,
  },
  retry: {
    maxAttempts: 5,
    initialDelayMs: 100,
    maxDelayMs: 5_000,
  },
};

class TestObservationProvider<Config> extends ObservationProvider<Config> {
  public constructor(
    providerConfig: ObservationConfig,
    private readonly store: PostgresObservationStore,
  ) {
    super(providerConfig);
  }

  protected override createStore(_pool: Pool): PostgresObservationStore {
    return this.store;
  }
}

describe("ObservationProvider", () => {
  it("registers observation infrastructure without preparing storage", async () => {
    const app = new App({ name: "test" }).register(
      new ObservationProvider(config),
    );
    const recorder = app.container.resolve(
      dep<ObservationRecorder>("observationRecorder"),
    );

    expect(recorder).toBeInstanceOf(DelegatingObservationRecorder);
    expect(app.container.hasRegistration("observationSource")).toBe(true);
    await app.dispose();
  });

  it("skips persistent storage in minimal mode", async () => {
    const app = new App({ name: "test" }).register(
      new ObservationProvider(config),
    );

    app.prepareBootPlan([], "minimal");

    await expect(app.start()).resolves.toBeUndefined();
    await app.dispose();
  });

  it("keeps bootstrapping when optional storage is absent", async () => {
    const missingTable = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    const store = {
      prepare: vi.fn(async () => Promise.reject(missingTable)),
    } as unknown as PostgresObservationStore;
    const app = new App({ name: "test" });

    app.container.registerValue("databaseClient", { pool: {} as Pool });
    app.register(new TestObservationProvider(config, store));

    await expect(app.start()).resolves.toBeUndefined();
    expect(store.prepare).toHaveBeenCalledWith(7);
    await app.dispose();
  });

  it("suppresses ambient observations while persisting an event batch", async () => {
    let observerContext: ObserverContext | undefined;
    const append = vi.fn(async () => {
      expect(observerContext?.get()).toBeUndefined();
    });
    const store = {
      prepare: vi.fn(async () => undefined),
      append,
    } as unknown as PostgresObservationStore;
    const app = new App({ name: "test" });

    app.container.registerValue("databaseClient", { pool: {} as Pool });
    app.container.registerValue("applicationLogger", {
      warn: vi.fn(),
    } as unknown as Logger);
    app.register(new TestObservationProvider(config, store));
    await app.start();

    observerContext = app.container.resolve(dep<ObserverContext>(
      "observerContext",
    ));
    const recorder = app.container.resolve(
      dep<ObservationRecorder>("observationRecorder"),
    );
    const observer = { record: vi.fn() } as unknown as Observer;

    await observerContext.run(observer, async () => {
      recorder.enqueue(createObservationEvent());
      await recorder.flush();
    });

    expect(append).toHaveBeenCalledOnce();
    await app.dispose();
  });

  it("applies recorder policy and reports storage failures to the application logger", async () => {
    const failure = new Error("Unavailable");
    const warn = vi.fn();
    const store = {
      prepare: vi.fn(async () => undefined),
      append: vi.fn(async () => Promise.reject(failure)),
    } as unknown as PostgresObservationStore;
    const app = new App({ name: "test" });

    app.container.registerValue("databaseClient", { pool: {} as Pool });
    app.container.registerValue("applicationLogger", {
      warn,
    } as unknown as Logger);
    app.register(new TestObservationProvider({
      ...config,
      buffer: { ...config.buffer, batchSize: 1 },
      retry: { ...config.retry, maxAttempts: 1 },
    }, store));
    await app.start();

    const recorder = app.container.resolve(
      dep<ObservationRecorder>("observationRecorder"),
    );
    recorder.enqueue(createObservationEvent());
    await recorder.flush();

    expect(warn).toHaveBeenCalledWith({
      err: failure,
      observationRecorder: {
        attempt: 1,
        batchSize: 1,
        policy: "best-effort",
        terminal: true,
      },
    }, "Observation storage write failed");
    expect(recorder.getHealth()).toMatchObject({
      status: "degraded",
      droppedByStorageFailure: 1,
    });
    await app.dispose();
  });

  it("reports recorder saturation to the application logger", async () => {
    const write = Promise.withResolvers<void>();
    const warn = vi.fn();
    const store = {
      prepare: vi.fn(async () => undefined),
      append: vi.fn(async () => write.promise),
    } as unknown as PostgresObservationStore;
    const app = new App({ name: "test" });

    app.container.registerValue("databaseClient", { pool: {} as Pool });
    app.container.registerValue("applicationLogger", {
      warn,
    } as unknown as Logger);
    app.register(new TestObservationProvider({
      ...config,
      buffer: {
        ...config.buffer,
        batchSize: 1,
        maxQueueSize: 1,
      },
    }, store));
    await app.start();

    const recorder = app.container.resolve(
      dep<ObservationRecorder>("observationRecorder"),
    );
    recorder.enqueue(createObservationEvent());
    await vi.waitFor(() => expect(store.append).toHaveBeenCalledOnce());
    recorder.enqueue({ ...createObservationEvent(), id: "event-2" });

    expect(warn).toHaveBeenCalledWith({
      observationRecorder: {
        status: "degraded",
        pendingCount: 1,
        droppedCount: 1,
        droppedByOverflow: 1,
        droppedByStorageFailure: 0,
        consecutiveStorageFailures: 0,
        oldestPendingAgeMs: expect.any(Number),
      },
    }, "Observation recorder queue is full");

    write.resolve();
    await app.dispose();
  });
});

/** Creates one complete event without coupling this test to a scoped observer. */
function createObservationEvent(): ObservationEvent {
  return {
    id: "event-1",
    executionId: "execution-1",
    occurredAt: new Date(),
    name: "test.event",
    category: "test",
    schemaVersion: 1,
    data: {},
  };
}
