import { describe, expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { loggerDependency } from "../log/index.js";
import { AsyncLocalObserverContext, type Observer } from "../observability/index.js";
import { memoryThrottling, MemoryRateLimitAdapter, postgresThrottling } from "./adapters/index.js";
import type { ThrottlingConfig } from "./configuration.js";
import { defineThrottlingAdapter } from "./adapter_definition.js";
import { defineAdmissionPolicy, defineRateLimit, localResourcePressure } from "./definitions.js";
import { throttlingDependency } from "./dependencies.js";
import { seconds } from "./duration.js";
import { ThrottlingResourcePressureError } from "./errors.js";
import { processCpuPressureSignal } from "./resource_pressure/index.js";
import {
  ThrottlingProvider,
  type ThrottlingResource,
} from "./provider.js";
const throttlingConfig: ThrottlingConfig = {
  namespace: "test",
  maxPendingAcquisitions: 100,
  backendFailurePolicy: { strategy: "reject" },
  pruneBatchSize: 10,
  pruneIntervalSeconds: 0,
  resourcePressureSampling: {
    healthyIntervalMs: 1_000,
    nearThresholdIntervalMs: 500,
    pressuredIntervalMs: 250,
    nearThresholdRatio: 0.2,
  },
};

function testAdapter(prune = async (_options: { limit: number }) => 0) {
  return defineThrottlingAdapter({
    dependencies: {},
    capabilities: { prune: true },
    create: () => {
      const memory = new MemoryRateLimitAdapter();
      return { reserve: memory.reserve.bind(memory), prune };
    },
  });
}

describe("ThrottlingProvider", () => {
  it("registers one disposable throttling resource", async () => {
    const app = createTestApp();
    const throttling = app.container.resolve(throttlingDependency);
    const resource = app.container.resolve(
      dep<ThrottlingResource>("throttlingResource"),
    );

    expect(app.container.resolve(throttlingDependency)).toBe(throttling);
    expect(resource.throttling).toBe(throttling);
    expect(resource.prune).toEqual(expect.any(Function));

    await app.dispose();
  });

  it("contributes configured bounded maintenance", async () => {
    const app = new App({ name: "test" }).register(new ThrottlingProvider({
      ...throttlingConfig,
      pruneIntervalSeconds: 60,
    }, postgresThrottling(dep("database"))));

    expect(app.catalog.scheduledTasks.registrations).toMatchObject([{
      task: {
        id: "maintenance.throttling-prune",
        groups: ["maintenance"],
        // Every replica contributes the same task, with storage-owned scheduling and overlap control.
        overlap: "skip",
        runtime: { state: "persistent", coordination: "distributed" },
        dependencies: { logger: loggerDependency, throttlingResource: dep("throttlingResource") },
        executionLog: false,
        observe: false,
      },
      source: { kind: "provider", provider: "ThrottlingProvider" },
    }]);

    await app.dispose();
  });

  it("does not resolve PostgreSQL infrastructure in minimal mode", async () => {
    const app = createTestApp();

    app.prepareBootPlan([], "minimal");

    await expect(app.start()).resolves.toBeUndefined();
    expect(app.container.hasRegistration("throttlingResource")).toBe(true);
    await app.dispose();
  });

  it("fails boot if a backend claims pruning but does not implement it", async () => {
    const adapter = defineThrottlingAdapter({
      dependencies: {}, capabilities: { prune: true }, create: () => new MemoryRateLimitAdapter(),
    });
    const app = new App({}).register(new ThrottlingProvider(throttlingConfig, adapter));
    try {
      // Detect a malformed adapter before its maintenance task can run.
      await expect(app.start()).rejects.toThrow("pruning capability does not match its implementation");
    } finally {
      await app.dispose();
    }
  });

  it("prunes in configured batches and logs only completed removals", async () => {
    const prune = vi.fn(async (_options: { limit: number }) => 0).mockResolvedValueOnce(3);
    const debug = vi.fn();
    const app = new App({}).register(new ThrottlingProvider({
      ...throttlingConfig, pruneIntervalSeconds: 60,
    }, testAdapter(prune)));
    try {
      const task = app.catalog.scheduledTasks.registrations[0]!.task;
      const throttlingResource = app.container.resolve(dep<ThrottlingResource>("throttlingResource"));
      const execution = {
        signal: new AbortController().signal,
        scheduledAt: new Date(0),
        trigger: "scheduled" as const,
        deferNextRun: () => undefined,
      };

      await task.handler({ logger: { debug }, throttlingResource }, execution);
      await task.handler({ logger: { debug }, throttlingResource }, execution);
      expect(prune.mock.calls).toEqual([[{ limit: 10 }], [{ limit: 10 }]]);
      expect(debug).toHaveBeenCalledExactlyOnceWith({ removed: 3 }, "Pruned fully refilled throttling buckets");
    } finally {
      await app.dispose();
    }
  });

  it("prioritizes custom pressure readings and forwards observations only in an active execution", async () => {
    const observerContext = new AsyncLocalObserverContext();
    const record = vi.fn<Observer["record"]>();
    const close = vi.fn();
    const read = vi.fn(() => 1);
    const app = new App({});
    app.container.registerValue("observerContext", observerContext);
    app.register(new ThrottlingProvider(throttlingConfig, memoryThrottling(), {
      resourcePressureSources: [{ supports: (signal) => signal === processCpuPressureSignal, read, close }],
    }));
    const pressure = defineAdmissionPolicy({
      id: "cpu-bound",
      limits: [localResourcePressure({
        id: "process",
        signals: { [processCpuPressureSignal]: { degradedAt: 0.8, limitedAt: 0.9 } },
      })],
    });
    const operation = vi.fn(async () => "ok");
    try {
      const throttling = app.container.resolve(throttlingDependency);
      await expect(observerContext.run({ record }, () => throttling.run(pressure, operation)))
        .rejects.toBeInstanceOf(ThrottlingResourcePressureError);
      expect(read).toHaveBeenCalledExactlyOnceWith(processCpuPressureSignal);
      expect(operation).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ name: "throttling.pressure" }),
        expect.objectContaining({ operation: "rejection", state: "limited", value: 1 }),
        expect.objectContaining({ outcome: "failure" }),
      );
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ name: "throttling.acquisition" }),
        expect.objectContaining({ key: "cpu-bound", result: "rejected" }),
        expect.objectContaining({ outcome: "failure" }),
      );
      record.mockClear();

      // The same provider can run without an ambient observer.
      const limit = defineRateLimit({ id: "outside-execution", requests: 1, per: seconds(1) });
      await expect(throttling.run(limit, operation)).resolves.toBe("ok");
      expect(record).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
    expect(close).toHaveBeenCalledOnce();
  });
});

function createTestApp(): App<{ name: string }> {
  const app = new App({ name: "test" });

  app.container.registerValue("database", {});
  return app.register(new ThrottlingProvider(throttlingConfig, testAdapter()));
}

it("supports a non-prunable external backend and closes it once after draining", async () => {
  const close = vi.fn(async () => {});
  const adapter = defineThrottlingAdapter({
    dependencies: {}, capabilities: { prune: false },
    create: () => Object.assign(new MemoryRateLimitAdapter(), { close }),
    dispose: (value) => value.close(),
  });
  const app = new App({}).register(new ThrottlingProvider({
    ...throttlingConfig, pruneIntervalSeconds: 60,
  }, adapter));
  try {
    expect(app.catalog.scheduledTasks.registrations).toEqual([]);
    await app.start();
    const throttling = app.container.resolve(throttlingDependency);
    await throttling.close();
    expect(close).not.toHaveBeenCalled();
  } finally { await app.dispose(); }
  expect(close).toHaveBeenCalledOnce();
});
