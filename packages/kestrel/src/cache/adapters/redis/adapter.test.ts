import { describe, expect, test } from "vitest";

import { createRedisTestContext, type RedisTestContext } from "../../../testing/redis.js";
import { CachePool } from "../../cache_pool.js";
import type { CacheEntry } from "../../types.js";
import { RedisCacheAdapter, type RedisCacheAdapterOptions } from "./adapter.js";

// Each test owns a real connection and a unique prefix, also with --no-isolate.
const it = test.extend<{ redis: RedisTestContext }>({
  redis: async ({}, use) => {
    const context = await createRedisTestContext();
    try {
      await use(context);
    } finally {
      await context.dispose();
    }
  },
});

function createAdapter(redis: RedisTestContext, overrides: Partial<RedisCacheAdapterOptions> = {}) {
  return new RedisCacheAdapter(redis.client, {
    keyPrefix: redis.keyPrefix,
    maxEntrySizeBytes: 1_024,
    ...overrides,
  });
}

function entry(value: unknown = { count: 2 }, expiresAt = new Date(Date.now() + 60_000)): CacheEntry {
  return { value, tags: [], sizeBytes: 20, createdAt: new Date(), expiresAt };
}

/** Produces raw backend data for corruption and expiration-boundary scenarios. */
function envelope(value: CacheEntry): string {
  return JSON.stringify({
    version: 1,
    value: value.value,
    sizeBytes: value.sizeBytes,
    createdAt: value.createdAt.toISOString(),
    expiresAt: value.expiresAt.toISOString(),
  });
}

describe("RedisCacheAdapter on the Kestrel Redis database", () => {
  it("selects db2 and stores the value with its exact absolute expiration", async ({ redis }) => {
    const adapter = createAdapter(redis);
    const stored = entry();
    const key = `${redis.keyPrefix}app:item`;
    await expect(redis.client.sendCommand(["CLIENT", "INFO"])).resolves.toMatch(/\bdb=2\b/);
    await adapter.set("app:item", stored);
    expect(JSON.parse((await redis.client.get(key))!)).toEqual(JSON.parse(envelope(stored)));
    await expect(redis.client.sendCommand(["PEXPIRETIME", key]))
      .resolves.toBe(stored.expiresAt.getTime());
    await expect(adapter.get("app:item")).resolves.toEqual(stored);
  });

  it("distinguishes a cached null from a missing entry", async ({ redis }) => {
    const adapter = createAdapter(redis);
    const stored = entry(null);
    await adapter.set("app:nullable", stored);
    await expect(adapter.get("app:nullable")).resolves.toEqual(stored);
    await expect(adapter.get("app:missing")).resolves.toBeUndefined();
  });

  it("replaces values and deadlines without extending the supplied TTL", async ({ redis }) => {
    const adapter = createAdapter(redis);
    await adapter.set("app:item", entry("first"));
    const replacement = entry("second", new Date(Date.now() + 30_000));
    await adapter.set("app:item", replacement);
    await expect(adapter.get("app:item")).resolves.toEqual(replacement);
    await expect(redis.client.sendCommand(["PEXPIRETIME", `${redis.keyPrefix}app:item`]))
      .resolves.toBe(replacement.expiresAt.getTime());
  });

  it("lets Redis expire the physical key without relying on the adapter clock", async ({ redis }) => {
    const createdAt = new Date();
    const adapter = createAdapter(redis, { now: () => createdAt });
    await adapter.set("app:item", entry("short-lived", new Date(createdAt.getTime() + 500)));
    expect(await redis.client.pTTL(`${redis.keyPrefix}app:item`)).toBeGreaterThan(0);
    // Poll actual Redis time: fake timers cannot advance a remote server's TTL.
    await expect.poll(() => redis.client.get(`${redis.keyPrefix}app:item`), {
      timeout: 3_000, interval: 20,
    }).toBeNull();
    await expect(adapter.get("app:item")).resolves.toBeUndefined();
  });

  it("does not delete a concurrent replacement after reading an expired envelope", async ({ redis }) => {
    const key = `${redis.keyPrefix}app:item`;
    // Deliberately omit native TTL so the adapter must enforce the envelope deadline.
    await redis.client.set(key, envelope(entry("expired", new Date(Date.now() - 1_000))));
    const writer = createAdapter(redis);
    const replacement = entry("replacement");
    const reader = new RedisCacheAdapter({
      sendCommand: async (args) => {
        const reply = await redis.client.sendCommand(args);
        if (args[0] === "GET") await writer.set("app:item", replacement);
        return reply;
      },
    }, { keyPrefix: redis.keyPrefix, maxEntrySizeBytes: 1_024 });
    await expect(reader.get("app:item")).resolves.toBeUndefined();
    await expect(writer.get("app:item")).resolves.toEqual(replacement);
  });

  it("removes a previous value when replaced with an expired entry", async ({ redis }) => {
    const adapter = createAdapter(redis);
    await adapter.set("app:item", entry("previous"));
    await adapter.set("app:item", entry("expired", new Date(Date.now() - 1_000)));
    await expect(redis.client.exists(`${redis.keyPrefix}app:item`)).resolves.toBe(0);
  });

  it("deletes only the requested prefixed key and reports whether it existed", async ({ redis }) => {
    const first = createAdapter(redis, { keyPrefix: `${redis.keyPrefix}first:` });
    const second = createAdapter(redis, { keyPrefix: `${redis.keyPrefix}second:` });
    await first.set("app:item", entry("first"));
    await second.set("app:item", entry("second"));
    await expect(first.delete("app:item")).resolves.toBe(true);
    await expect(first.delete("app:item")).resolves.toBe(false);
    await expect(second.get("app:item")).resolves.toMatchObject({ value: "second" });
  });

  it("does not persist oversized or tagged entries", async ({ redis }) => {
    const adapter = createAdapter(redis);
    await adapter.set("app:item", { ...entry(), sizeBytes: 1_025 });
    await expect(adapter.set("app:tagged", { ...entry(), tags: ["app:tag"] }))
      .rejects.toThrow("does not support cache tags");
    await expect(redis.client.exists([`${redis.keyPrefix}app:item`, `${redis.keyPrefix}app:tagged`]))
      .resolves.toBe(0);
    expect("prune" in adapter).toBe(false);
    expect("reset" in adapter).toBe(false);
    expect("invalidateAllTags" in adapter).toBe(false);
  });

  for (const raw of ["not json", "{}", '{"version":2}', '"value"']) {
    it(`rejects malformed data read from Redis: ${raw}`, async ({ redis }) => {
      await redis.client.set(`${redis.keyPrefix}app:item`, raw);
      await expect(createAdapter(redis).get("app:item")).rejects.toThrow();
    });
  }

  it("validates stored dates and envelope versions", async ({ redis }) => {
    const adapter = createAdapter(redis);
    const stored = JSON.parse(envelope(entry()));
    for (const invalid of [{ ...stored, expiresAt: "invalid" }, { ...stored, version: 2 }]) {
      await redis.client.set(`${redis.keyPrefix}app:item`, JSON.stringify(invalid));
      await expect(adapter.get("app:item")).rejects.toThrow();
    }
  });

  it("propagates real Redis errors for keys of the wrong type", async ({ redis }) => {
    await redis.client.lPush(`${redis.keyPrefix}app:item`, "not-a-string");
    await expect(createAdapter(redis).get("app:item")).rejects.toThrow("WRONGTYPE");
  });

  it("shares cached values between independent connections and pool instances", async ({ redis }) => {
    const peer = await createRedisTestContext();
    try {
      const options = { namespace: "test", defaultTtlSeconds: 60, maxTtlSeconds: 120, maxEntrySizeBytes: 1_024 };
      const first = new CachePool(createAdapter(redis), options);
      const second = new CachePool(createAdapter(peer, { keyPrefix: redis.keyPrefix }), options);
      await first.remember("item", async () => "loaded");
      await expect(second.remember("item", async () => {
        throw new Error("A shared Redis hit must not run the second loader.");
      })).resolves.toBe("loaded");
    } finally {
      await peer.dispose();
    }
  });
});
