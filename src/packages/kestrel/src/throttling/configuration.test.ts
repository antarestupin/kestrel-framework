import { describe, expect, it } from "vitest";

import { postgresThrottlingConfigBase } from "./adapters/postgres/configuration.js";
import { redisThrottlingConfigBase } from "./adapters/redis/configuration.js";
import { throttlingConfigBase } from "./configuration.js";

describe("throttling failure policy configuration", () => {
  it("defaults to rejecting requests when the backend fails", () => {
    expect(throttlingConfigBase.schema.parse({ namespace: "test" }).backendFailurePolicy)
      .toEqual({ strategy: "reject" });
  });

  // Parse explicit strategies: an omitted value can bypass union validation via a default.
  it.each([
    { strategy: "reject" },
    { strategy: "emergency-local", capacity: 5, periodMs: 1_000 },
  ])("preserves an explicitly configured failure policy %j", (backendFailurePolicy) => {
    expect(throttlingConfigBase.schema.parse({ namespace: "test", backendFailurePolicy }).backendFailurePolicy)
      .toEqual(backendFailurePolicy);
  });

  it.each(["", "unsupported"])("rejects an unknown strategy %j", (strategy) => {
    expect(() => throttlingConfigBase.schema.parse({
      namespace: "test", backendFailurePolicy: { strategy },
    })).toThrow();
  });
});

it("parses resource pressure and storage settings at their supported boundaries", () => {
  const parsed = throttlingConfigBase.schema.parse({ namespace: "test", resourcePressureSampling: {
    healthyIntervalMs: "100", nearThresholdIntervalMs: "50", pressuredIntervalMs: "25", nearThresholdRatio: "0",
  } });
  expect(parsed.resourcePressureSampling).toEqual({
    healthyIntervalMs: 100, nearThresholdIntervalMs: 50, pressuredIntervalMs: 25, nearThresholdRatio: 0,
  });
  expect(throttlingConfigBase.schema.parse({ namespace: "test" }).resourcePressureSampling).toEqual({
    healthyIntervalMs: 1_000, nearThresholdIntervalMs: 500, pressuredIntervalMs: 250, nearThresholdRatio: 0.2,
  });
  expect(throttlingConfigBase.schema.parse({ namespace: "test", resourcePressureSampling: { nearThresholdRatio: "0.25" } })
    .resourcePressureSampling.nearThresholdRatio).toBe(0.25);
  expect(() => throttlingConfigBase.schema.parse({ namespace: "test", resourcePressureSampling: { nearThresholdRatio: -0.1 } })).toThrow();
  expect(() => throttlingConfigBase.schema.parse({ namespace: "test", resourcePressureSampling: { nearThresholdRatio: 1 } })).toThrow();
  expect(postgresThrottlingConfigBase.schema.parse({})).toEqual({
    maxConcurrentReservations: 8, maxPendingReservations: 1_000, storageWaitTimeoutMs: 1_000,
  });
  expect(postgresThrottlingConfigBase.schema.parse({
    maxConcurrentReservations: "1", maxPendingReservations: 0, storageWaitTimeoutMs: "100",
  })).toEqual({ maxConcurrentReservations: 1, maxPendingReservations: 0, storageWaitTimeoutMs: 100 });
  for (const options of [{ maxConcurrentReservations: 0 }, { maxPendingReservations: -1 }, { storageWaitTimeoutMs: 0 }]) {
    expect(() => postgresThrottlingConfigBase.schema.parse(options)).toThrow();
  }
  expect(redisThrottlingConfigBase.schema.parse({})).toEqual({ keyPrefix: "kestrel:throttling:" });
  expect(redisThrottlingConfigBase.schema.parse({ keyPrefix: "partner:quota:" })).toEqual({ keyPrefix: "partner:quota:" });
  expect(() => redisThrottlingConfigBase.schema.parse({ keyPrefix: "" })).toThrow();
});
