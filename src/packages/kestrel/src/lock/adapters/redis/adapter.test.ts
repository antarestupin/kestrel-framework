import { describe, expect, test, vi } from "vitest";
import { createRedisTestContext, type RedisTestContext } from "../../../testing/redis.js";
import { RedisLockAdapter } from "./adapter.js";

// Every test owns its connection and keyspace, including under --no-isolate.
const it = test.extend<{ redis: RedisTestContext }>({
  redis: async ({}, use) => {
    const redis = await createRedisTestContext();
    try { await use(redis); } finally { await redis.dispose(); }
  },
});
const request = (key = "resource", ownerId = "first") => ({ key, ownerId, ttlMs: 60_000 });
const leaseKey = (prefix: string, key = "resource") => `${prefix}{locks}:lease:${Buffer.from(key).toString("base64url")}`;

describe("RedisLockAdapter", () => {
  it("shares leases across independent clients and rejects stale ownership", async ({ redis }) => {
    const other = await createRedisTestContext();
    try {
      const first = new RedisLockAdapter(redis.client, { keyPrefix: redis.keyPrefix });
      const second = new RedisLockAdapter(other.client, { keyPrefix: redis.keyPrefix });
      const lease = await first.tryAcquire(request());
      expect(lease?.fencingToken).toBe(1n);
      expect(await redis.client.pTTL(leaseKey(redis.keyPrefix))).toBeGreaterThan(0);
      await expect(second.tryAcquire(request("resource", "second"))).resolves.toBeUndefined();
      await expect(second.extend(request("resource", "second"))).resolves.toBeUndefined();
      const extended = await first.extend({ ...request(), ttlMs: 120_000 });
      expect(extended).toMatchObject({ ownerId: "first", fencingToken: lease!.fencingToken });
      expect(extended!.expiresAt.getTime()).toBeGreaterThan(lease!.expiresAt.getTime());
      await expect(second.release(request("resource", "second"))).resolves.toBe(false);
      await expect(first.release(request())).resolves.toBe(true);
      const successor = await second.tryAcquire(request("resource", "second"));
      expect(successor!.fencingToken).toBeGreaterThan(lease!.fencingToken);
      await expect(first.release(request())).resolves.toBe(false);
    } finally { await other.dispose(); }
  });

  it("admits only one concurrent owner", async ({ redis }) => {
    const adapter = new RedisLockAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const leases = await Promise.all(Array.from({ length: 20 }, (_, index) => adapter.tryAcquire(request("resource", String(index)))));
    expect(leases.filter(Boolean)).toHaveLength(1);
  });

  it("acquires and extends batches without partial mutations", async ({ redis }) => {
    const adapter = new RedisLockAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    await adapter.tryAcquire(request("busy", "other"));
    await expect(adapter.tryAcquireMany([request("free"), request("busy")])).resolves.toBeUndefined();
    expect(await redis.client.get(leaseKey(redis.keyPrefix, "free"))).toBeNull();
    const leases = await adapter.tryAcquireMany([request("a"), request("b")]);
    expect(leases?.map(({ key }) => key)).toEqual(["a", "b"]);
    const before = await redis.client.get(leaseKey(redis.keyPrefix, "a"));
    await expect(adapter.extendMany([{ ...request("a"), ttlMs: 10 }, request("b", "wrong")])).resolves.toBeUndefined();
    expect(await redis.client.get(leaseKey(redis.keyPrefix, "a"))).toBe(before);
    const extended = await adapter.extendMany([request("a"), request("b")]);
    expect(extended?.map(({ fencingToken }) => fencingToken)).toEqual(leases?.map(({ fencingToken }) => fencingToken));
  });

  it("preserves fencing values beyond JavaScript number precision and after native expiry", async ({ redis }) => {
    const adapter = new RedisLockAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    await redis.client.set(`${redis.keyPrefix}{locks}:sequence`, "9007199254740992");
    const first = await adapter.tryAcquire(request());
    expect(first!.fencingToken).toBe(9007199254740993n);
    await redis.client.pExpire(leaseKey(redis.keyPrefix), 1);
    await expect.poll(() => redis.client.get(leaseKey(redis.keyPrefix))).toBeNull();
    await expect(adapter.extend(request())).resolves.toBeUndefined();
    expect((await adapter.tryAcquire(request()))!.fencingToken).toBe(9007199254740994n);
    expect(await redis.client.pTTL(`${redis.keyPrefix}{locks}:sequence`)).toBe(-1);
  });

  it("does not partially acquire when the fencing sequence overflows", async ({ redis }) => {
    const adapter = new RedisLockAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    await redis.client.set(`${redis.keyPrefix}{locks}:sequence`, "9223372036854775807");
    await expect(adapter.tryAcquireMany([request("a"), request("b")])).rejects.toThrow();
    expect(await redis.client.exists(leaseKey(redis.keyPrefix, "a"))).toBe(0);
    expect(await redis.client.exists(leaseKey(redis.keyPrefix, "b"))).toBe(0);
  });

  it("rejects expiry outside the Date range at Redis time before reserving a fencing token", async ({ redis }) => {
    const adapter = new RedisLockAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    // A skewed process clock cannot validate an absolute expiry computed by Redis.
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await expect(adapter.tryAcquireMany([
        request("valid"), { ...request("out-of-range"), ttlMs: 8_640_000_000_000_000 },
      ])).rejects.toThrow();
    } finally {
      clock.mockRestore();
    }
    expect(await redis.client.get(leaseKey(redis.keyPrefix, "valid"))).toBeNull();
    expect(await redis.client.get(leaseKey(redis.keyPrefix, "out-of-range"))).toBeNull();
    expect(await redis.client.get(`${redis.keyPrefix}{locks}:sequence`)).toBeNull();
  });

  it("validates persisted fencing values before extending any batch member", async ({ redis }) => {
    const adapter = new RedisLockAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    await adapter.tryAcquireMany([request("valid"), request("corrupt")]);
    const validKey = leaseKey(redis.keyPrefix, "valid");
    const corruptKey = leaseKey(redis.keyPrefix, "corrupt");
    const before = await redis.client.get(validKey);
    const corrupt = JSON.parse((await redis.client.get(corruptKey))!);
    await redis.client.set(corruptKey, JSON.stringify({ ...corrupt, fencingToken: "not-a-token" }), { KEEPTTL: true });

    // Redis scripts have no rollback after a write, so every reply must be validated first.
    await expect(adapter.extendMany([
      { ...request("valid"), ttlMs: 120_000 }, request("corrupt"),
    ])).rejects.toThrow();
    expect(await redis.client.get(validKey)).toBe(before);
  });

  it("isolates adapter prefixes and validates requests before mutation", async ({ redis }) => {
    const adapter = new RedisLockAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const other = new RedisLockAdapter(redis.client, { keyPrefix: `${redis.keyPrefix}other:` });
    await expect(adapter.tryAcquire(request())).resolves.toBeDefined();
    await expect(other.tryAcquire(request())).resolves.toBeDefined();
    await expect(adapter.tryAcquireMany([request("a"), request("a")])).rejects.toThrow("unique");
    await expect(adapter.tryAcquire({ ...request("a"), ttlMs: 0 })).rejects.toThrow("TTL");
    await expect(adapter.tryAcquireMany([])).resolves.toEqual([]);
  });
});
