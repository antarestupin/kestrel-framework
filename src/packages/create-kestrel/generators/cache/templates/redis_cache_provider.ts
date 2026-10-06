// Composes the cache facade with a borrowed Redis connection.
// RedisProvider owns the default connection and its lifecycle for every feature.

import type { Provider, ProviderBootApp, ProviderCompositionApp } from "@kestreljs/framework/app";
import { CacheProvider, RedisCacheAdapter, type CacheConfig } from "@kestreljs/framework/cache";
import type { RegisteredDependencyDescriptor } from "@kestreljs/framework/di";
import { redisDependency, type RedisClient } from "./redis_provider.js";

/** Use the shared connection by default, or inject an application-defined connection. */
export class RedisCacheProvider<Config> implements Provider<Config> {
  private cacheProvider?: CacheProvider<Config>;

  public constructor(
    private readonly cache: CacheConfig,
    private readonly connection: RegisteredDependencyDescriptor<RedisClient> = redisDependency,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    const adapter = new RedisCacheAdapter({
      sendCommand: (arguments_) => app.container.resolve(this.connection).sendCommand(arguments_),
    }, { maxEntrySizeBytes: this.cache.maxEntrySizeBytes });
    this.cacheProvider = new CacheProvider(this.cache, adapter);
    this.cacheProvider.register(app);
  }

  public boot(app: ProviderBootApp<Config>): void {
    this.cacheProvider?.boot(app);
  }
}
