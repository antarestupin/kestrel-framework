import { describe, expect, test } from "vitest";
import { createRedisTestContext, type RedisTestContext } from "../../../testing/redis.js";
import { ThrottlingDefinitionConflictError } from "../../errors.js";
import type { RateLimitLeaseRequest, RateLimitReservationRequest } from "../../types.js";
import { RedisRateLimitAdapter } from "./adapter.js";

const it = test.extend<{ redis: RedisTestContext }>({
  redis: async ({}, use) => {
    const redis = await createRedisTestContext();
    try { await use(redis); } finally { await redis.dispose(); }
  },
});
const request = (key = "quota", overrides: Partial<RateLimitReservationRequest> = {}): RateLimitReservationRequest => ({
  key, limit: 0.001, periodMs: 60_000, burst: 10, cost: 1, ...overrides,
});
const leased = (key = "quota", overrides: Partial<RateLimitLeaseRequest> = {}): RateLimitLeaseRequest => ({
  ...request(key), coordination: { strategy: "leased", maxLeaseUnits: 4, leaseMs: 60_000, maxOutstandingUnits: 8, guardBandUnits: 1 }, ...overrides,
});
const bucketKey = (prefix: string, key = "quota") => `${prefix}{throttling}:${Buffer.from(key).toString("base64url")}`;

describe("RedisRateLimitAdapter", () => {
  it("shares fractional quotas across clients without oversubscription", async ({ redis }) => {
    const other = await createRedisTestContext();
    try {
      const adapters = [redis.client, other.client].map((client) => new RedisRateLimitAdapter(client, { keyPrefix: redis.keyPrefix }));
      const results = await Promise.all(Array.from({ length: 25 }, (_, index) => adapters[index % 2]!.reserve(request("quota", { cost: 0.5 }))));
      expect(results.filter(({ admitted }) => admitted)).toHaveLength(20);
      const rejected = results.find((result) => !result.admitted)!;
      expect(rejected.admitted).toBe(false);
      if (!rejected.admitted) expect(rejected.retryAt.getTime()).toBeGreaterThan(Date.now());
    } finally { await other.dispose(); }
  });

  it("rejects a composed admission without consuming other dimensions", async ({ redis }) => {
    const adapter = new RedisRateLimitAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    await adapter.reserve(request("busy", { cost: 10 }));
    await expect(adapter.reserveMany([request("free"), request("busy")])).resolves.toMatchObject({ admitted: false });
    expect(await redis.client.get(bucketKey(redis.keyPrefix, "free"))).toBeNull();
    await expect(adapter.inspectMany([request("free")])).resolves.toMatchObject([{ available: true, remaining: 10 }]);
    expect(await redis.client.get(bucketKey(redis.keyPrefix, "free"))).toBeNull();
  });

  it("detects conflicting definitions before applying any batch mutation", async ({ redis }) => {
    const adapter = new RedisRateLimitAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    await adapter.reserve(request());
    await expect(adapter.reserveMany([request("free"), request("quota", { burst: 20 })])).rejects.toBeInstanceOf(ThrottlingDefinitionConflictError);
    expect(await redis.client.get(bucketKey(redis.keyPrefix, "free"))).toBeNull();
    await expect(adapter.reserve(leased())).rejects.toBeInstanceOf(ThrottlingDefinitionConflictError);
  });

  it("reconciles actual costs as debt and refunds atomically", async ({ redis }) => {
    const adapter = new RedisRateLimitAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    await adapter.reserve(request());
    const remaining = await adapter.reconcile([{ ...request(), actualCost: 15, estimatedCost: 1 }]);
    expect(remaining.quota).toBeCloseTo(-5, 3);
    await expect(adapter.reserve(request())).resolves.toMatchObject({ admitted: false });
    const refunded = await adapter.reconcile([{ ...request(), actualCost: 0, estimatedCost: 15 }]);
    expect(refunded.quota).toBeCloseTo(10, 3);
  });

  it("allocates bounded leases, falls back to exact, and refunds each grant once", async ({ redis }) => {
    const adapter = new RedisRateLimitAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const first = await adapter.allocateLeases("one", [leased()]);
    expect(first).toMatchObject({ admitted: true, allocations: { quota: { mode: "lease", units: 4 } } });
    const second = await adapter.allocateLeases("two", [leased()]);
    expect(second).toMatchObject({ admitted: true, allocations: { quota: { mode: "lease", units: 4 } } });
    expect(await adapter.allocateLeases("three", [leased()])).toMatchObject({ admitted: true, allocations: { quota: { mode: "exact" } } });
    if (!first.admitted || first.allocations.quota?.mode !== "lease") throw new Error("Expected a lease.");
    const grant = { key: "quota", leaseId: first.allocations.quota.leaseId, remaining: 3 };
    await expect(adapter.returnLeases([grant])).resolves.toBe(1);
    await expect(adapter.returnLeases([grant])).resolves.toBe(0);
    const inspected = await adapter.inspectMany([leased()]);
    expect(inspected[0]!.remaining).toBeCloseTo(4, 3);
  });

  it("refunds completed grants even when replenishment is denied", async ({ redis }) => {
    const adapter = new RedisRateLimitAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const result = await adapter.allocateLeases("one", [leased()]);
    if (!result.admitted || result.allocations.quota?.mode !== "lease") throw new Error("Expected a lease.");
    const returned = { key: "quota", leaseId: result.allocations.quota.leaseId, remaining: 1 };
    const denied = await adapter.allocateLeases("one", [leased("quota", { cost: 10 })], [returned]);
    expect(denied.admitted).toBe(false);
    await expect(adapter.returnLeases([returned])).resolves.toBe(0);
    expect((await adapter.inspectMany([leased()]))[0]!.remaining).toBeCloseTo(7, 3);
  });

  it("retains full buckets while grants are live and expires ordinary buckets natively", async ({ redis }) => {
    const adapter = new RedisRateLimitAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const fast = leased("quota", { limit: 100_000, periodMs: 1_000 });
    await adapter.allocateLeases("one", [fast]);
    expect(await redis.client.pTTL(bucketKey(redis.keyPrefix))).toBeGreaterThan(50_000);
    await adapter.reserve(request("short", { limit: 1_000, periodMs: 100, burst: 1 }));
    await expect.poll(() => redis.client.get(bucketKey(redis.keyPrefix, "short"))).toBeNull();
    expect("prune" in adapter).toBe(false);
  });

  it("does not refund an expired lease or change state after invalid input", async ({ redis }) => {
    const adapter = new RedisRateLimitAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const result = await adapter.allocateLeases("one", [leased()]);
    if (!result.admitted || result.allocations.quota?.mode !== "lease") throw new Error("Expected a lease.");
    const id = result.allocations.quota.leaseId;
    const raw = JSON.parse((await redis.client.get(bucketKey(redis.keyPrefix)))!);
    raw.leases[id].expiresAt = Date.now() - 1;
    await redis.client.set(bucketKey(redis.keyPrefix), JSON.stringify(raw));
    await expect(adapter.returnLeases([{ key: "quota", leaseId: id, remaining: 4 }])).resolves.toBe(0);
    expect((await adapter.inspectMany([leased()]))[0]!.remaining).toBeCloseTo(6, 3);
    await expect(adapter.reserveMany([request("a"), request("a")])).rejects.toThrow("unique");
    await expect(adapter.reserve(request("invalid", { cost: Infinity }))).rejects.toThrow();
  });

  it("round-trips fractional arithmetic state without cjson precision loss", async ({ redis }) => {
    const adapter = new RedisRateLimitAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const cost = 0.12345678901234567;
    const result = await adapter.reserve(request("precise", { burst: 1, cost }));
    expect(result.remaining).toBe(1 - cost);
    const stored = JSON.parse((await redis.client.get(bucketKey(redis.keyPrefix, "precise")))!);
    expect(Number(stored.tokens)).toBe(1 - cost);
  });
});
