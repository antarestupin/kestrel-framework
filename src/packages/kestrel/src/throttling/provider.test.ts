import { describe, expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { MemoryRateLimitAdapter, postgresThrottling } from "./adapters/index.js";
import type { ThrottlingConfig } from "./configuration.js";
import { defineThrottlingAdapter } from "./adapter_definition.js";
import { throttlingDependency } from "./dependencies.js";
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

function testAdapter() {
  return defineThrottlingAdapter({
    dependencies: {},
    capabilities: { prune: true },
    create: () => {
      const memory = new MemoryRateLimitAdapter();
      return { reserve: memory.reserve.bind(memory), prune: async () => 0 };
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
