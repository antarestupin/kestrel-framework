// Owns the application's native node-redis client independently of its consumers.
// Register this provider before features that borrow redisDependency.

import { createClient, type RedisClientType } from "@redis/client";
import type { Provider, ProviderBootApp, ProviderCompositionApp } from "@kestreljs/framework/app";
import { dep, type RegisteredDependencyDescriptor } from "@kestreljs/framework/di";
import { applicationLoggerDependency } from "@kestreljs/framework/log";
import type { RedisConfig } from "../config/redis.js";

/** Consumers receive the native client; connection ownership stays with this provider. */
export type RedisClient = RedisClientType;
export const redisDependency = dep<RedisClient>("redis");

/** Registers one lazy singleton per connection without a command transport wrapper. */
export class RedisProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly config: RedisConfig,
    private readonly connection: RegisteredDependencyDescriptor<RedisClient> = redisDependency,
  ) {}

  protected createClient(onError: (error: Error) => void): RedisClient {
    const client = createClient({
      url: this.config.url,
      socket: { connectTimeout: this.config.connectTimeoutMs, reconnectStrategy: false },
      commandOptions: { timeout: this.config.connectTimeoutMs },
      // Never replay a delayed security mutation after an ambiguous disconnect.
      disableOfflineQueue: true,
    });
    client.on("error", onError);
    return client;
  }

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(this.connection.id, () => this.createClient(
      (error) => app.container.resolve(applicationLoggerDependency)
        .warn({ err: error }, "Redis connection failed"),
    ), {
      lifetime: "singleton",
      dispose: (client) => { if (client.isOpen) client.destroy(); },
    });
  }

  /** Infrastructure is ready before execution-scoped adapters can use its native commands. */
  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    if (app.bootPlan.runningMode === "minimal") return;
    const client = app.container.resolve(this.connection);
    if (!client.isOpen) await client.connect();
  }
}
