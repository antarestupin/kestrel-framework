# Cache

[Usage index](./README.md) · [Implementation and adapter contracts](../implementation/cache.md)

Use the cache for recomputable JSON-compatible data. Memory, PostgreSQL and Redis share the basic facade; memory and PostgreSQL additionally support tags.

## Configure a cache and load on a miss

Cache an expensive read when its result can be reused briefly and recomputed if absent. The example injects a memory cache into an action and loads a greeting only on a miss.

```ts
import { z } from "zod";
import { defineAction } from "@kestrel/framework/actions";
import { App } from "@kestrel/framework/app";
import { cacheConfigBase, cacheDependency, CacheProvider, MemoryCacheAdapter } from "@kestrel/framework/cache";
import { configure, createConfigurationApi } from "@kestrel/framework/configuration";

const configuration = createConfigurationApi({ environments: ["test"], defaultEnvironment: "test" });
const config = configuration.resolveConfig({
  cache: configure(cacheConfigBase, { namespace: "example", defaultTtlSeconds: 60 }),
}, { environment: "test", env: {} });
const adapter = new MemoryCacheAdapter({
  maxEntries: 1_000, maxSizeBytes: 4_194_304, maxEntrySizeBytes: 65_536,
});
const app = new App(config).register(new CacheProvider(config.cache, adapter));

const readGreeting = defineAction({
  name: "greeting.cached",
  input: z.object({ name: z.string() }),
  output: z.string(),
  dependencies: { cache: cacheDependency },
  handler: ({ name }, { cache }) => cache.remember(
    `greeting:${name}`,
    async () => `Hello, ${name}!`,
    // This entry overrides the provider's default TTL for a shorter reuse window.
    { ttlSeconds: 30 },
  ),
});
```

Run the action in the composed application. Omit the adapter for the provider's PostgreSQL default, after registering a database provider and installing the cache schema. Memory is process-local; use shared storage across processes. Ordinary `remember` calls coalesce concurrent loads inside one pool.

## Install PostgreSQL storage

Add these objects to the application's global Drizzle schema and to the `schema` object passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Re-export the library objects so their SQL contributions remain attached.
export { cacheEntries } from "@kestrel/framework/cache";
export { utilsSchema } from "@kestrel/framework/db";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using the PostgreSQL adapter. The library declares `SET UNLOGGED` and database comments with its table, so installation requires no manually authored custom SQL. Keep historical cache migrations in existing applications. PostgreSQL may discard unlogged cache contents after a crash; only store recomputable data. Memory and Redis adapters do not require this schema.

## Read, write and invalidate explicitly

Manage entries directly when a mutation makes cached data stale. Delete a known key for one value, or invalidate matching tags when several entries depend on the same records.

```ts
import type { Cache, TagAwareCache } from "@kestrel/framework/cache";

async function updateGreeting(cache: Cache): Promise<void> {
  await cache.set("greeting:Sam", "Welcome, Sam!", { ttlSeconds: 60 });
  const greeting = await cache.get<string>("greeting:Sam");
  // Remove the known entry when its source data changes.
  await cache.delete("greeting:Sam");
}

async function invalidateProfile(cache: TagAwareCache): Promise<void> {
  await cache.set("profile:42", { name: "Sam" }, { tags: ["profiles", "account:42"] });
  // Multiple tags use AND semantics: the entry must contain every supplied tag.
  await cache.invalidateAllTags(["profiles", "account:42"]);
}
```

Inject `tagAwareCacheDependency` when tags are required; resolution fails if the selected backend lacks that capability. `undefined` means a miss and cannot be stored; `null` can. The generic read type does not validate stored data.

## Use Redis or coordinate loaders across processes

Use shared cache storage when several processes should reuse the same results. Add shared locking when concurrent cache misses must also coordinate their loaders.

```ts
import { RedisCacheAdapter, type RedisCacheClient, type CacheConfig } from "@kestrel/framework/cache";

function redisProvider(client: RedisCacheClient, config: CacheConfig) {
  // The caller supplies a connected client and owns its errors and shutdown.
  return new CacheProvider(config, new RedisCacheAdapter(client, {
    keyPrefix: "example-cache:", maxEntrySizeBytes: config.maxEntrySizeBytes,
  }));
}
```

Redis has native expiry but no tag, reset or prune capability. Configure connection/command timeouts on the borrowed client. For shared single-flight loading, register `LockProvider` and use `remember(key, loader, { lock: true })` or explicit lock options.

Cache storage failures normally degrade to misses or skipped writes. Loader errors propagate; cache locks follow the lock library's failure policy. Do not use cache success as a correctness guarantee. TTL and entry-size limits are enforced; capacity and pruning settings depend on the adapter.

## Use cases still to document

- Schedule PostgreSQL cache pruning.
- Compose shared locking for remember calls and handle loader or lock failures.
- Inject tag-aware caching into an action and invalidate entries after a mutation.
- Own a Redis connection from application startup through shutdown.
