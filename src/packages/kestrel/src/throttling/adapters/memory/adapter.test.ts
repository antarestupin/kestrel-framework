import { describe, expect, it } from "vitest";

import { throttlingConfigBase } from "../../configuration.js";
import { MemoryRateLimitAdapter } from "./adapter.js";
import { memoryThrottling } from "./definition.js";

const singleUnit = { key: "app:api", limit: 1, periodMs: 1_000, burst: 1, cost: 1 };

describe("MemoryRateLimitAdapter", () => {
  it("rejects a tiny positive cost after exhausting its tiny burst", async () => {
    const cost = Number.EPSILON;
    const request = { ...singleUnit, limit: cost, burst: cost, cost };
    const adapter = new MemoryRateLimitAdapter({ now: () => new Date(0) });
    await expect(adapter.reserve(request)).resolves.toEqual({ admitted: true, remaining: 0 });
    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: false, remaining: 0 });
    await expect(adapter.inspectMany([request])).resolves.toMatchObject([{ available: false, remaining: 0 }]);
  });

  it("inspects fractional balances consistently on both sides of the rounding boundary", async () => {
    const adapter = new MemoryRateLimitAdapter({ now: () => new Date(0) });
    const request = { ...singleUnit, burst: 0.3, cost: 0.1 };
    await adapter.reserve(request);

    // One representable rounding step still covers 0.2, but not a larger deficit.
    await expect(adapter.inspectMany([{ ...request, cost: 0.2 }])).resolves.toMatchObject([{ available: true }]);
    await expect(adapter.inspectMany([{ ...request, cost: 0.2 + Number.EPSILON / 2 }]))
      .resolves.toMatchObject([{ available: false }]);
  });

  it("refills a token bucket continuously", async () => {
    let nowMs = 0;
    const adapter = new MemoryRateLimitAdapter({
      now: () => new Date(nowMs),
    });
    const request = {
      key: "app:api",
      limit: 2,
      periodMs: 1_000,
      burst: 2,
      cost: 1,
    };

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 1,
    });
    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 0,
    });
    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: false,
      remaining: 0,
      retryAt: new Date(500),
    });

    nowMs = 500;

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 0,
    });
  });

  it("supports weighted reservations and caps refill at burst capacity", async () => {
    let nowMs = 0;
    const adapter = new MemoryRateLimitAdapter({
      now: () => new Date(nowMs),
    });
    const request = {
      key: "app:weighted",
      limit: 10,
      periodMs: 1_000,
      burst: 5,
      cost: 3,
    };

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 2,
    });

    nowMs = 10_000;

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 2,
    });
  });

  it("keeps buckets independent and does not mint tokens when time moves back", async () => {
    let nowMs = 1_000;
    const adapter = new MemoryRateLimitAdapter({
      now: () => new Date(nowMs),
    });
    const request = {
      key: "app:first",
      limit: 1,
      periodMs: 1_000,
      burst: 1,
      cost: 1,
    };

    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
    });
    await expect(adapter.reserve({ ...request, key: "app:second" }))
      .resolves.toMatchObject({ admitted: true });

    nowMs = 500;

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: false,
      remaining: 0,
      retryAt: new Date(2_000),
    });
  });

  it("rejects malformed adapter requests", async () => {
    const adapter = new MemoryRateLimitAdapter();

    await expect(adapter.reserve({
      key: "",
      limit: 1,
      periodMs: 1_000,
      burst: 1,
      cost: 1,
    })).rejects.toThrow("keys cannot be empty");

    await expect(adapter.reserve({
      key: "app:api",
      limit: 1,
      periodMs: 1_000,
      burst: 1,
      cost: 2,
    })).rejects.toThrow("cost cannot exceed burst");
  });

  it("validates the entire batch before changing bucket state", async () => {
    const adapter = new MemoryRateLimitAdapter({ now: () => new Date(0) });
    const invalid = { ...singleUnit, key: "app:invalid" };

    await expect(adapter.reserveMany([singleUnit, singleUnit])).rejects.toThrow("duplicated");
    await expect(adapter.reserveMany([singleUnit, { ...invalid, limit: 0 }]))
      .rejects.toThrow("limit must be a positive finite number");
    await expect(adapter.reserveMany([singleUnit, { ...invalid, cost: Infinity }]))
      .rejects.toThrow("cost must be a positive finite number");
    await expect(adapter.reconcile([
      { ...singleUnit, actualCost: 2, estimatedCost: 1 },
      { ...invalid, actualCost: -1, estimatedCost: 1 },
    ])).rejects.toThrow("actualCost must be a non-negative finite number");
    await expect(adapter.reserve(singleUnit)).resolves.toEqual({ admitted: true, remaining: 0 });
  });

  it("reports every batch dimension and the longest refill wait without consuming the free bucket", async () => {
    let now = 1_000;
    const adapter = new MemoryRateLimitAdapter({ now: () => new Date(now) });
    const fast = { ...singleUnit, key: "fast", periodMs: 400 };
    const slow = { ...singleUnit, key: "slow", periodMs: 800 };
    const free = { ...singleUnit, key: "free" };
    await adapter.reserveMany([fast, slow]);
    now += 200;

    await expect(adapter.reserveMany([fast, free, slow])).resolves.toEqual({
      admitted: false, remaining: { fast: 0.5, free: 1, slow: 0.25 },
      retryAt: new Date(1_800), source: "local",
    });
    await expect(adapter.inspectMany([fast, free, slow])).resolves.toEqual([
      { available: false, remaining: 0.5, retryAt: new Date(1_400), source: "local" },
      { available: true, remaining: 1, source: "local" },
      { available: false, remaining: 0.25, retryAt: new Date(1_800), source: "local" },
    ]);
    await expect(adapter.reserve(free)).resolves.toEqual({ admitted: true, remaining: 0 });
    await expect(adapter.inspectMany([fast, { ...slow, cost: 0 }])).rejects.toThrow("cost must be a positive finite number");
    await expect(adapter.reconcile([{ ...fast, cost: 0, actualCost: 1, estimatedCost: 1 }])).rejects.toThrow("cost must be a positive finite number");
  });

  it("leaves buckets unchanged when the clock cannot supply a valid timestamp", async () => {
    let nowMs = NaN;
    const adapter = new MemoryRateLimitAdapter({ now: () => new Date(nowMs) });

    await expect(adapter.reserve(singleUnit)).rejects.toThrow("clock returned an invalid date");
    nowMs = 0;
    await expect(adapter.reserve(singleUnit)).resolves.toEqual({ admitted: true, remaining: 0 });
  });

  it("constructs independent process-local stores through the default definition", async () => {
    const definition = memoryThrottling();
    const config = throttlingConfigBase.schema.parse({ namespace: "test" });
    const noDependency = () => { throw new Error("Memory throttling needs no dependency"); };
    const first = definition.create(noDependency, { config });
    const second = definition.create(noDependency, { config });
    // A low refill rate keeps this test independent from real clock movement between calls.
    const quota = { ...singleUnit, limit: 0.0001, periodMs: 60_000 };

    expect(definition.capabilities.prune).toBe(false);
    await expect(first.reserve(quota)).resolves.toMatchObject({ admitted: true });
    await expect(first.reserve(quota)).resolves.toMatchObject({ admitted: false });
    await expect(second.reserve(quota)).resolves.toMatchObject({ admitted: true });
  });
});
