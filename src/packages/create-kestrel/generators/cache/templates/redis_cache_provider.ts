import { createClient } from "@redis/client";
import type { Provider, ProviderBootApp, ProviderCompositionApp } from "@kestrel/framework/app";
import { CacheProvider, RedisCacheAdapter, type CacheConfig, type RedisCacheClient } from "@kestrel/framework/cache";
import { dep } from "@kestrel/framework/di";
import { applicationLoggerDependency } from "@kestrel/framework/log";
import type { RedisConfig } from "../config/redis.js";

/** Small owned transport contract, also usable with injected clients in unit tests. */
export interface RedisConnectionClient extends RedisCacheClient {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  destroy(): void;
}
interface RedisCacheConnection extends RedisCacheClient { close(): void; }

/** Coalesce first-use connections and prevent a disposed cache from reopening its socket. */
export function createRedisCacheConnection(client: RedisConnectionClient): RedisCacheConnection {
  let connecting: Promise<unknown> | undefined;
  let connected = false;
  let closed = false;
  return {
    async sendCommand(arguments_) {
      if (closed) throw new Error("Redis cache connection is closed.");
      // A later request may recover a lost socket without background reconnect timers.
      if (connected && !client.isOpen) {
        connected = false;
        connecting = undefined;
      }
      connecting ??= client.connect().then(() => { connected = true; }, (error) => {
        connecting = undefined;
        throw error;
      });
      await connecting;
      if (closed) throw new Error("Redis cache connection is closed.");
      return client.sendCommand(arguments_);
    },
    close() {
      closed = true;
      // Destroy also interrupts an in-flight connection; there is no reconnect timer to retain.
      if (client.isOpen) client.destroy();
    },
  };
}

/** The application owns Redis sockets; the framework cache borrows its command transport. */
export class RedisCacheProvider<Config> implements Provider<Config> {
  private cacheProvider?: CacheProvider<Config>;

  public constructor(private readonly cache: CacheConfig, private readonly redis: RedisConfig) {}

  public register(app: ProviderCompositionApp<Config>): void {
    const connection = dep<RedisCacheConnection>("redisCacheConnection");
    app.container.registerFactory("redisCacheConnection", () => {
      const client = createClient({
        url: this.redis.url,
        socket: { connectTimeout: this.redis.connectTimeoutMs, reconnectStrategy: false },
        disableOfflineQueue: true,
      });
      // Node Redis emits errors in addition to rejecting commands; keep both paths handled.
      client.on("error", (error) => app.container.resolve(applicationLoggerDependency)
        .warn({ err: error }, "Redis cache connection failed"));
      return createRedisCacheConnection(client);
    }, { lifetime: "singleton", dispose: (resource) => resource.close() });
    const adapter = new RedisCacheAdapter({
      sendCommand: (arguments_) => app.container.resolve(connection).sendCommand(arguments_),
    }, { maxEntrySizeBytes: this.cache.maxEntrySizeBytes });
    this.cacheProvider = new CacheProvider(this.cache, adapter);
    this.cacheProvider.register(app);
  }

  public boot(app: ProviderBootApp<Config>): void {
    this.cacheProvider?.boot(app);
  }
}
