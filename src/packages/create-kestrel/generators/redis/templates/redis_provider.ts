// Owns the application's shared Redis connection independently of its consumers.
// Features borrow redisDependency; only this provider closes the socket.

import { createClient } from "@redis/client";
import type { Provider, ProviderCompositionApp } from "@kestreljs/framework/app";
import { dep, type RegisteredDependencyDescriptor } from "@kestreljs/framework/di";
import { applicationLoggerDependency } from "@kestreljs/framework/log";
import type { RedisConfig } from "../config/redis.js";

/** Borrowed transport: consumers can issue commands but do not own connection cleanup. */
export interface RedisClient {
  sendCommand(arguments_: string[]): Promise<unknown>;
}
export const redisDependency = dep<RedisClient>("redis");

/** Small owned transport contract, also usable with injected clients in unit tests. */
export interface RedisConnectionClient extends RedisClient {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  destroy(): void;
}
interface RedisConnection extends RedisClient { close(): void; }

/** Coalesce first-use connections and prevent a disposed connection from reopening its socket. */
export function createRedisConnection(client: RedisConnectionClient): RedisConnection {
  let connecting: Promise<unknown> | undefined;
  let connected = false;
  let closed = false;
  return {
    async sendCommand(arguments_) {
      if (closed) throw new Error("Redis connection is closed.");
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
      if (closed) throw new Error("Redis connection is closed.");
      return client.sendCommand(arguments_);
    },
    close() {
      closed = true;
      // Destroy also interrupts an in-flight connection; there is no reconnect timer to retain.
      if (client.isOpen) client.destroy();
    },
  };
}

/** Register one lazy singleton per connection; all default consumers share redisDependency. */
export class RedisProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly config: RedisConfig,
    private readonly connection: RegisteredDependencyDescriptor<RedisClient> = redisDependency,
  ) {}

  /** Applications and unit tests can supply a compatible client without changing ownership. */
  protected createClient(onError: (error: Error) => void): RedisConnectionClient {
    const client = createClient({
      url: this.config.url,
      socket: { connectTimeout: this.config.connectTimeoutMs, reconnectStrategy: false },
      disableOfflineQueue: true,
    });
    // Node Redis emits errors in addition to rejecting commands; keep both paths handled.
    client.on("error", onError);
    return client;
  }

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(this.connection.id, () => createRedisConnection(this.createClient(
      (error) => app.container.resolve(applicationLoggerDependency)
        .warn({ err: error }, "Redis connection failed"),
    )), { lifetime: "singleton", dispose: (resource) => resource.close() });
  }
}
