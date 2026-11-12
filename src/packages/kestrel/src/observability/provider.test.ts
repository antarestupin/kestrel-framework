import { defineObservationAdapter, type ObservationAdapter } from "./adapter_definition.js";
import { postgresObservations } from "./adapters/postgres/index.js";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import { dep, type AdapterRegistration } from "../di/index.js";
import type { ObservationConfig } from "./configuration.js";
import { PostgresObservationStore } from "./adapters/postgres/adapter.js";
import {
  DelegatingObservationRecorder,
  type ObservationEvent,
  type ObservationRecorder,
  type Observer,
} from "./observer.js";
import type { ObserverContext } from "./context.js";
import { ObservationProvider } from "./provider.js";
import { defineObservation } from "./definitions.js";
import { observationRecorderDependency, observerDependency } from "./dependencies.js";
import type { DevObservationSource } from "./source.js";

const config: ObservationConfig = {
  enabled: true,
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
    super(
      providerConfig,
      defineObservationAdapter({
        dependencies: {},
        capabilities: { query: true },
        create: () => ({ writer: store, source: store, available: true as boolean }),
        initialize: async (backend) => {
          try {
            await store.prepare(7);
          } catch (error) {
            if ((error as { code?: string }).code !== "42P01") throw error;
            backend.available = false;
          }
        },
      }),
    );
  }
}

describe("ObservationProvider", () => {
  it("registers observation infrastructure without preparing storage", async () => {
    const app = new App({ name: "test" }).register(
      new ObservationProvider(
        config,
        postgresObservations(dep("databaseClient"), { retentionDays: 7 }),
      ),
    );
    const recorder = app.container.resolve(dep<ObservationRecorder>("observationRecorder"));

    expect(recorder).toBeInstanceOf(DelegatingObservationRecorder);
    expect(app.container.hasRegistration("observationSource")).toBe(true);
    await app.dispose();
  });

  it("skips persistent storage in minimal mode", async () => {
    const app = new App({ name: "test" }).register(
      new ObservationProvider(
        config,
        postgresObservations(dep("databaseClient"), { retentionDays: 7 }),
      ),
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

    observerContext = app.container.resolve(dep<ObserverContext>("observerContext"));
    const recorder = app.container.resolve(dep<ObservationRecorder>("observationRecorder"));
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
    app.register(
      new TestObservationProvider(
        {
          ...config,
          buffer: { ...config.buffer, batchSize: 1 },
          retry: { ...config.retry, maxAttempts: 1 },
        },
        store,
      ),
    );
    await app.start();

    const recorder = app.container.resolve(dep<ObservationRecorder>("observationRecorder"));
    recorder.enqueue(createObservationEvent());
    await recorder.flush();

    expect(warn).toHaveBeenCalledWith(
      {
        err: failure,
        observationRecorder: {
          attempt: 1,
          batchSize: 1,
          policy: "best-effort",
          terminal: true,
        },
      },
      "Observation storage write failed",
    );
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
    app.register(
      new TestObservationProvider(
        {
          ...config,
          buffer: {
            ...config.buffer,
            batchSize: 1,
            maxQueueSize: 1,
          },
        },
        store,
      ),
    );
    await app.start();

    const recorder = app.container.resolve(dep<ObservationRecorder>("observationRecorder"));
    recorder.enqueue(createObservationEvent());
    await vi.waitFor(() => expect(store.append).toHaveBeenCalledOnce());
    recorder.enqueue({ ...createObservationEvent(), id: "event-2" });

    expect(warn).toHaveBeenCalledWith(
      {
        observationRecorder: {
          status: "degraded",
          pendingCount: 1,
          droppedCount: 1,
          droppedByOverflow: 1,
          droppedByStorageFailure: 0,
          consecutiveStorageFailures: 0,
          oldestPendingAgeMs: expect.any(Number),
        },
      },
      "Observation recorder queue is full",
    );

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

it("flushes a writer-only external backend before disposal without requiring a query source", async () => {
  const order: string[] = [];
  const app = new App({}).register(
    new ObservationProvider(
      config,
      defineObservationAdapter({
        dependencies: {},
        capabilities: { query: false },
        create: () => ({
          writer: {
            append: async () => {
              order.push("write");
            },
          },
        }),
        dispose: async () => {
          order.push("dispose");
        },
      }),
    ),
  );
  app.container.registerValue("applicationLogger", { warn: vi.fn() });
  try {
    expect(app.container.hasRegistration("observationSource")).toBe(false);
    await app.start();
    app.container
      .resolve(dep<ObservationRecorder>("observationRecorder"))
      .enqueue(createObservationEvent());
  } finally {
    await app.dispose();
  }
  expect(order).toEqual(["write", "dispose"]);
});

it("does not construct a backend when observations are disabled", async () => {
  const create = vi.fn(() => ({ writer: { append: async () => {} }, source: {} as DevObservationSource }));
  const app = new App({}).register(new ObservationProvider({ ...config, enabled: false }, defineObservationAdapter({
    dependencies: {}, capabilities: { query: true }, create,
  })));
  try {
    expect(app.container.hasRegistration("observationAdapter")).toBe(false);
    await app.start();
    expect(app.container.hasRegistration("observationSource")).toBe(false);
    expect(create).not.toHaveBeenCalled();
  } finally {
    await app.dispose();
  }
});

it("shares the recorder across scopes while binding each observer to its own execution", async () => {
  const append = vi.fn(async () => {});
  const provider = new ObservationProvider(config, defineObservationAdapter({
    dependencies: {}, capabilities: { query: false }, create: () => ({ writer: { append } }),
  }));
  const app = new App({}).register(provider);
  app.container.registerValue("applicationLogger", { warn: vi.fn() });

  try {
    await app.start();
    const recorder = app.container.resolve(observationRecorderDependency);
    const first = await app.createExecutionScope("first-execution");
    const second = await app.createExecutionScope("second-execution");
    try {
      const firstObserver = first.container.resolve(observerDependency);
      const secondObserver = second.container.resolve(observerDependency);
      expect(first.container.resolve(observationRecorderDependency)).toBe(recorder);
      expect(second.container.resolve(observationRecorderDependency)).toBe(recorder);
      expect(first.container.resolve(observerDependency)).toBe(firstObserver);
      expect(secondObserver).not.toBe(firstObserver);
      const definition = defineObservation({ name: "test.event", category: "test" });
      firstObserver.record(definition, { value: "first" });
      secondObserver.record(definition, { value: "second" });
      // Repeated initialization must keep the existing recorder and its admitted events.
      await provider.boot(app);
      await recorder.flush();
      expect(append).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ executionId: "first-execution", data: { value: "first" } }),
        expect.objectContaining({ executionId: "second-execution", data: { value: "second" } }),
      ]);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  } finally {
    await app.dispose();
  }
});

it("resolves one advertised query source and releases it even before recorder creation", async () => {
  const source = {} as DevObservationSource;
  const readSource = vi.fn(() => source);
  const dispose = vi.fn(async () => {});
  const app = new App({}).register(new ObservationProvider(config, defineObservationAdapter({
    dependencies: {}, capabilities: { query: true }, dispose,
    create: () => ({ writer: { append: async () => {} }, get source() { return readSource(); } }),
  })));

  try {
    const dependency = dep<DevObservationSource>("observationSource");
    expect(app.container.resolve(dependency)).toBe(source);
    expect(app.container.resolve(dependency)).toBe(source);
    // Capability validation and the first source resolution each read the source once.
    expect(readSource).toHaveBeenCalledTimes(2);
    const adapter = app.container.resolve(dep<AdapterRegistration<ObservationAdapter>>("observationAdapterRegistration"));
    await adapter.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    await app.dispose();
  }
});

it("rejects an adapter whose query capability does not match its runtime shape", async () => {
  const app = new App({}).register(new ObservationProvider(config, defineObservationAdapter({
    dependencies: {}, capabilities: { query: true }, create: () => ({ writer: { append: async () => {} } }),
  })));
  try {
    await expect(app.start()).rejects.toThrow("Observation query capability does not match its implementation");
  } finally {
    await app.dispose();
  }
});

it("drains the recorder before releasing the adapter independently of application flush", async () => {
  const writeStarted = Promise.withResolvers<void>();
  const write = Promise.withResolvers<void>();
  const dispose = vi.fn(async () => {});
  const append = vi.fn(async () => {
    writeStarted.resolve();
    await write.promise;
  });
  const app = new App({}).register(new ObservationProvider(config, defineObservationAdapter({
    dependencies: {}, capabilities: { query: false }, create: () => ({ writer: { append } }), dispose,
  })));
  app.container.registerValue("applicationLogger", { warn: vi.fn() });

  try {
    await app.start();
    const recorder = app.container.resolve(dep<ObservationRecorder>("observationRecorder"));
    const adapter = app.container.resolve(dep<AdapterRegistration<ObservationAdapter>>("observationAdapterRegistration"));
    recorder.enqueue(createObservationEvent());
    const closing = adapter.dispose();

    await writeStarted.promise;
    expect(dispose).not.toHaveBeenCalled();
    write.resolve();
    await closing;
    expect(dispose).toHaveBeenCalledOnce();
    expect(recorder.getHealth()).toMatchObject({ status: "healthy", pendingCount: 0 });
    recorder.enqueue(createObservationEvent());
    await recorder.flush();
    expect(append).toHaveBeenCalledOnce();
  } finally {
    write.resolve();
    await app.dispose();
  }
});

it("reports a fail-fast write failure once and still releases its adapter", async () => {
  const failure = new Error("observation writer offline");
  const append = vi.fn(async () => { throw failure; });
  const dispose = vi.fn(async () => {});
  const warn = vi.fn();
  const app = new App({}).register(new ObservationProvider({
    ...config, failurePolicy: "fail-fast", retry: { ...config.retry, maxAttempts: 1 },
  }, defineObservationAdapter({
    dependencies: {}, capabilities: { query: false }, create: () => ({ writer: { append } }), dispose,
  })));
  app.container.registerValue("applicationLogger", { warn });

  try {
    await app.start();
    const recorder = app.container.resolve(observationRecorderDependency);
    recorder.enqueue(createObservationEvent());
    // Count the original error even if another lifecycle layer wraps it.
    const failures = await app.dispose().then(() => [], leafFailures);
    expect(failures).toEqual([failure]);
    expect(failures[0]).toBe(failure);
    expect(append).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(recorder.getHealth()).toMatchObject({ status: "healthy", pendingCount: 0 });
  } finally {
    await app.dispose().catch(() => undefined);
  }
});

function leafFailures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(leafFailures) : [error];
}
