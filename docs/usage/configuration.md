# Configuration

[Usage index](./README.md) · [Implementation and source resolution](../implementation/configuration.md)

Resolve configuration once at the application boundary. Pass each provider its resolved section; actions and services receive values through dependency injection.

## Configure a library and select deployment values

Resolve library settings at application startup when deployments need different values. This example combines cache defaults, an explicit environment variable and a deployment-specific debug flag.

```ts
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { cacheConfigBase } from "@kestreljs/framework/cache";

const configuration = createConfigurationApi({
  environments: ["development", "test", "production"],
  defaultEnvironment: "development",
  environmentOverrides: { prefix: "APP_CONFIG" },
});
const { defineConfig, envVar, fromEnv } = configuration;
const definition = defineConfig({
  cache: configure(cacheConfigBase, {
    namespace: "example",
    // The library schema validates the raw variable and supplies its default.
    defaultTtlSeconds: envVar("CACHE_TTL_SECONDS"),
  }),
  features: defineConfig({
    // Select application behavior from the resolved deployment environment.
    debug: fromEnv({ development: true, test: true, default: false }),
  }),
});

export const config = configuration.resolveConfig(definition, {
  environment: configuration.resolveEnvironment(process.env.ENVIRONMENT),
  env: process.env,
});
export type AppConfig = typeof config;
```

Only the application boundary reads `process.env`. Kestrel libraries receive abstract settings such as `debug`, `enabled` or `devMode`; they do not know application environment names. A missing variable preserves the library schema's default; required values fail with their configuration path.

## Override a library setting without another binding

Use conventional overrides when a deployment needs to adjust a supported library setting without changing application code. With the prefix above, configuration can set a schema leaf:

```sh
# Override a supported library schema leaf through the configured prefix.
APP_CONFIG__CACHE__MAX_ENTRIES=20000
# This setting uses the explicit envVar binding declared above.
CACHE_TTL_SECONDS=120
```

Explicit bindings are authoritative: setting both `CACHE_TTL_SECONDS` and `APP_CONFIG__CACHE__DEFAULT_TTL_SECONDS` fails. Unknown conventional paths also fail. Conventional overrides cover library schema leaves, not arbitrary application fields, arrays or polymorphic objects.

## Add an application setting with validation

Add a validated application field when a setting does not belong to a library. Here, startup must reject a support address that is missing or is not a valid email address.

```ts
import { z } from "zod";

const applicationDefinition = defineConfig({
  ...definition,
  // Validate the deployment value while resolving configuration at startup.
  supportAddress: envVar("SUPPORT_ADDRESS", z.email()),
});
// Resolve this assembled definition instead of the earlier one when using it.
```

Split larger definitions into focused factories receiving the same specialized configuration API. Composition uses normal object construction, with no implicit deep merge. Custom configuration bases and future source types belong in the [implementation reference](../implementation/configuration.md#library-configuration-bases).

## Use cases still to document

- Split configuration into typed factories sharing one configuration API.
- Combine environment selections, fallbacks and explicit variable bindings.
- Diagnose missing values, validation errors and conflicting overrides from concrete examples.

## Configure providers and their backends

Cache, throttling, workers and workflows require an explicit adapter definition. Providers own the feature facade, runtime integration and maintenance; adapter definitions describe construction, declared dependencies, capabilities and optional resource lifecycle hooks. Built-in and third-party backends use the same contract. See [provider lifecycle](../implementation/app.md#adapter-definitions-and-resource-ownership).

New providers with interchangeable backends follow the same [provider adapter convention](../implementation/app.md#provider-adapter-convention): pass the adapter directly after the common feature configuration, or first when there is no common configuration. Any remaining provider options follow it; backend dependency descriptors and backend settings remain separate factory arguments.

Keep validated values in the application configuration and dependency wiring in `app.ts` or an imported composition module. A feature configuration can include a nested adapter contribution without extending the framework's common schema:

```ts
// config/cache.ts: one contribution contains feature and storage settings.
import { configure } from "@kestreljs/framework/configuration";
import { cacheConfigBase, redisCacheConfigBase } from "@kestreljs/framework/cache";

export function createCacheConfig() {
  return configure(cacheConfigBase, {
    namespace: "my-app",
    defaultTtlSeconds: 3600,
    adapter: configure(redisCacheConfigBase, { keyPrefix: "cache:" }),
  });
}
```

Add `cache: createCacheConfig()` to the existing application configuration definition. With the `APP_CONFIG` override prefix, `APP_CONFIG__CACHE__ADAPTER__KEY_PREFIX` overrides the nested prefix. Connection credentials and timeouts belong to `config/redis.ts`, because several features may share that connection.

```ts
// app.ts: the Redis infrastructure provider owns the borrowed connection.
import { CacheProvider, redisCache } from "@kestreljs/framework/cache";
import { redisDependency } from "./providers/redis_provider.js";

app.register(new CacheProvider(app.config.cache, redisCache(redisDependency, app.config.cache.adapter)));
```

`postgresCacheConfigBase` owns `maxEntries`; `memoryCacheConfigBase` owns `maxEntries` and `maxSizeBytes`; `redisCacheConfigBase` owns `keyPrefix`. Entry-size limits remain shared cache policy and are passed to the adapter by the provider. `postgresThrottlingConfigBase` owns `maxConcurrentReservations`, `maxPendingReservations` and `storageWaitTimeoutMs`. `postgresWorkflowsConfigBase` owns `terminalPollIntervalMs`. Connection-backed helpers take the typed connection descriptor first and resolved backend settings second, retaining the supplied configuration reference without reparsing it. Validate application settings through `configure()` and `resolveConfig()` (or the backend schema for standalone callers). Omitting the second argument uses backend defaults; PostgreSQL workers take only the connection descriptor. Cache construction combines backend settings with common entry-size and pruning policy when the adapter is resolved. There is no empty backend configuration to maintain for PostgreSQL workers.

### External backends

An external package can export a factory returning `CacheAdapterDefinition`, `ThrottlingAdapterDefinition`, `WorkerAdapterDefinition` or `WorkflowAdapterDefinition`. It does not subclass a provider, register a global driver name, or import application code. For example, the following application-local definition adapts an already registered cache implementation:

```ts
import { defineCacheAdapter, type CacheAdapter } from "@kestreljs/framework/cache";
import { dep } from "@kestreljs/framework/di";

// A third-party infrastructure module may export this descriptor instead.
const externalCacheDependency = dep<CacheAdapter>("externalCache");
const externalCache = defineCacheAdapter({
  dependencies: { storage: externalCacheDependency },
  capabilities: { prune: false, tags: false },
  create: ({ storage }) => storage,
  // Borrowed instances have no dispose hook: their original owner releases them.
});
```

For newly constructed resources, `create(dependencies, context)` runs synchronously once per app; use `initialize(adapter)` for asynchronous setup and `dispose(adapter)` for owned resource cleanup. Each feature supplies its context: cache and workers supply their resolved feature config, throttling supplies `{ config, instrumentation }`, and workflows supply `{ activityDispatchMode }`. A factory must not read environment variables, create connections while declaring a definition, or close injected shared connections. The dependency map uses typed `dep<T>()` descriptors. A definition may be reused across apps; construct state inside `create` for isolation.

Declare `prune` and `tags` for cache, `prune` for throttling, `{}` for workers, and `activityDispatchMode` for workflows. Metadata is available during composition and is checked against the constructed backend. Custom throttling definitions own any backend-specific coordination and failure-policy decorators; the PostgreSQL helper composes denial caching, backend failure policy and leases using the supplied context. Runtime atomic reservation and leasing contracts remain mandatory for the policies using them.

### Migration

All four providers require an adapter definition as a direct constructor argument: `CacheProvider(config, adapter)`, `ThrottlingProvider(config, adapter, options?)`, `WorkerProvider(config, adapter, options?)` and `WorkflowProvider(adapter, options?)`. Optional provider settings remain separate from backend selection. Replace implicit PostgreSQL defaults with `postgresCache`, `postgresThrottling`, `postgresWorkers` or `postgresWorkflows`, passing an explicit typed database descriptor. Replace `new CacheProvider(config, instance)` and worker instance options with a definition; wrapping an existing instance in `create: () => instance` borrows it unless a disposal hook explicitly transfers ownership. Replace adapter-only provider subclasses with `define*Adapter` factories. Existing standalone adapter constructors remain available.

Move `cache.maxEntries` into the PostgreSQL or memory adapter contribution. Move throttling storage concurrency and wait settings into its PostgreSQL adapter contribution; configure `maxPendingReservations` separately from the facade's `maxPendingAcquisitions`. For worker-backed workflows, select an outbox adapter explicitly with `postgresWorkflows(database, { activityDispatchMode: "outbox" })` and set `activityTransport: "worker"` on the provider.
