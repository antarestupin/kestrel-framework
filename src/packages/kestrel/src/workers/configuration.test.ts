import { describe, expect, it } from "vitest";

import { workersConfigBase } from "./configuration.js";

const schema = workersConfigBase.schema;
const numericKeys = ["slots", "leaseMs", "reservationLimit", "pollIntervalMs", "readyQueueRefreshMs", "ackBufferSize", "ackFlushIntervalMs", "deferBufferSize", "deferFlushIntervalMs"] as const;

describe("worker configuration", () => {
  it("provides runtime defaults without inventing publication limits", () => {
    expect(schema.parse({})).toEqual({ slots: 10, leaseMs: 300_000, reservationLimit: 100, pollIntervalMs: 1_000, readyQueueRefreshMs: 1_000, ackBufferSize: 100, ackFlushIntervalMs: 10, deferBufferSize: 100, deferFlushIntervalMs: 10, shutdownBehavior: "wait" });
    expect(schema.parse({ publication: {} }).publication).toEqual({});
  });

  it("coerces numeric application values and keeps independent publication limits", () => {
    const input = Object.fromEntries(numericKeys.map((key, index) => [key, String(index + 1)]));
    const output = Object.fromEntries(numericKeys.map((key, index) => [key, index + 1]));
    expect(schema.parse({ ...input, publication: { maxJobBytes: "11", maxBatchBytes: "12", maxBatchSize: "13" } })).toEqual({ ...output, shutdownBehavior: "wait", publication: { maxJobBytes: 11, maxBatchBytes: 12, maxBatchSize: 13 } });
  });

  it.each(numericKeys)("requires a positive whole %s", (key) => {
    // Check fields independently so one invalid setting cannot mask another.
    for (const value of [0, -1, 1.5, NaN, Infinity, "invalid", false, null, ""]) {
      expect(schema.safeParse({ [key]: value }).success, `${key}: ${String(value)}`).toBe(false);
    }
  });

  it.each(["maxJobBytes", "maxBatchBytes", "maxBatchSize"])("requires a positive whole publication %s", (key) => {
    for (const value of [0, -1, 1.5, NaN, Infinity, "invalid", false, null, ""]) {
      expect(schema.safeParse({ publication: { [key]: value } }).success).toBe(false);
    }
  });

  it.each(["wait", "release", "expire"])("accepts the %s shutdown policy", (shutdownBehavior) => {
    expect(schema.parse({ shutdownBehavior }).shutdownBehavior).toBe(shutdownBehavior);
  });

  it("rejects empty and unknown shutdown policies", () => {
    for (const shutdownBehavior of ["", "unknown", false, null]) expect(schema.safeParse({ shutdownBehavior }).success).toBe(false);
  });
});
