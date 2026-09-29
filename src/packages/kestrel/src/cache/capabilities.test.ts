import { describe, expect, it } from "vitest";

import { RedisCacheAdapter, MemoryCacheAdapter } from "./adapters/index.js";
import { CachePool, TagAwareCachePool, isTagAwareCache } from "./cache_pool.js";
import type { Cache, CachePoolOptions, TagAwareCache } from "./types.js";

const options: CachePoolOptions = {
  namespace: "test", defaultTtlSeconds: 60, maxTtlSeconds: 120, maxEntrySizeBytes: 1_024,
};

// TypeScript checks this function without executing intentionally invalid calls.
function checkPublicContracts(cache: Cache, tagged: TagAwareCache, redis: RedisCacheAdapter) {
  const taggedOptions = { tags: ["group"], ttlSeconds: 60 };
  cache.set("key", "value", { ttlSeconds: 60 });
  // @ts-expect-error A basic cache does not expose tag invalidation.
  cache.invalidateAllTags(["group"]);
  // @ts-expect-error Variables with tag options must not bypass excess-property checks.
  cache.set("key", "value", taggedOptions);
  // @ts-expect-error Read-through calls cannot silently ignore tags either.
  cache.remember("key", async () => "value", taggedOptions);
  tagged.set("key", "value", taggedOptions);
  tagged.remember("key", async () => "value", taggedOptions);
  tagged.invalidateAllTags(["group"]);
  // @ts-expect-error Redis cannot construct a facade promising tags.
  new TagAwareCachePool(redis, options);
  const basicPool = new CachePool(redis, options);
  // @ts-expect-error The concrete Redis pool must not expose tag invalidation.
  basicPool.invalidateAllTags(["group"]);

}
void checkPublicContracts;

describe("Cache capabilities", () => {
  it("narrows dynamically selected facades and preserves common operations", async () => {
    const cache: Cache = new TagAwareCachePool(new MemoryCacheAdapter({
      maxEntries: 10, maxSizeBytes: 10_000, maxEntrySizeBytes: 1_024,
    }), options);
    expect(isTagAwareCache(cache)).toBe(true);
    if (!isTagAwareCache(cache)) throw new Error("Expected tag support");
    await cache.remember("key", async () => "value", { tags: ["group"] });
    await expect(cache.invalidateAllTags(["group"])).resolves.toBe(1);
    await expect(cache.get("key")).resolves.toBeUndefined();
  });

  it("rejects an untyped attempt to wrap Redis in a tag-aware facade", () => {
    const adapter = new RedisCacheAdapter({ sendCommand: async () => null }, {
      maxEntrySizeBytes: 1_024,
    });
    expect(isTagAwareCache(new CachePool(adapter, options))).toBe(false);
    // @ts-expect-error Validate the runtime boundary for JavaScript consumers.
    expect(() => new TagAwareCachePool(adapter, options)).toThrow("does not support tag invalidation");
  });
});
