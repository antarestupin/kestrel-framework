import { describe, expect, it } from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { MemoryRateLimitAdapter } from "./adapters/index.js";
import type { ThrottlingConfig } from "./configuration.js";
import { throttlingDependency } from "./dependencies.js";
import {
  ThrottlingProvider,
  type ThrottlingResource,
} from "./provider.js";
import type {
  PrunableRateLimitAdapter,
  RateLimitPruneOptions,
} from "./types.js";

const throttlingConfig: ThrottlingConfig = {
  namespace: "test",
  maxPendingAcquisitions: 100,
  maxConcurrentReservations: 2,
  storageWaitTimeoutMs: 100,
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

class MemoryThrottlingProvider<Config> extends ThrottlingProvider<Config> {
  protected override createAdapter(): PrunableRateLimitAdapter {
    const memory = new MemoryRateLimitAdapter();

    return {
      reserve: (request) => memory.reserve(request),
      prune: async (_options: RateLimitPruneOptions) => 0,
    };
  }
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
    }));

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
  return app.register(new MemoryThrottlingProvider(throttlingConfig));
}
