import { describe, expect, it } from "vitest";

import { scheduledTasksConfigBase } from "./configuration.js";

const schema = scheduledTasksConfigBase.schema;

describe("scheduled task configuration", () => {
  it("provides the complete runtime and maintenance defaults", () => {
    expect(schema.parse({})).toEqual({ slots: 10, leaseMs: 300_000, pollIntervalMs: 1_000, defaultState: "persistent", defaultCoordination: "distributed", expiredRunPruneBatchSize: 1_000, expiredRunPruneIntervalSeconds: 60 });
  });

  it("coerces numeric application inputs and accepts every supported policy", () => {
    expect(schema.parse({ slots: "2", leaseMs: "3", pollIntervalMs: "4", expiredRunPruneBatchSize: "5", expiredRunPruneIntervalSeconds: "0", defaultState: "memory", defaultCoordination: "local" })).toEqual({ slots: 2, leaseMs: 3, pollIntervalMs: 4, expiredRunPruneBatchSize: 5, expiredRunPruneIntervalSeconds: 0, defaultState: "memory", defaultCoordination: "local" });
  });

  it.each(["slots", "leaseMs", "pollIntervalMs", "expiredRunPruneBatchSize"])("requires a positive whole %s without coercing unrelated input types", (key) => {
    // Validate independently: another invalid field must not hide an accepted bad value.
    for (const value of [0, -1, 1.5, NaN, Infinity, "invalid", false, null]) {
      expect(schema.safeParse({ [key]: value }).success, `${key}: ${String(value)}`).toBe(false);
    }
  });

  it("requires a non-negative whole pruning interval", () => {
    for (const value of [-1, 1.5, NaN, Infinity, "invalid", false, null]) {
      expect(schema.safeParse({ expiredRunPruneIntervalSeconds: value }).success).toBe(false);
    }
    expect(schema.parse({ expiredRunPruneIntervalSeconds: 0 }).expiredRunPruneIntervalSeconds).toBe(0);
  });

  it.each(["defaultState", "defaultCoordination"])("rejects unknown or empty %s policies", (key) => {
    for (const value of ["", "unknown", false, null]) expect(schema.safeParse({ [key]: value }).success).toBe(false);
  });
});
