import { randomUUID } from "node:crypto";
import { createClient } from "@redis/client";

/** Creates an isolated keyspace on the framework's dedicated Redis database. */
export async function createRedisTestContext(options: { url?: string } = {}) {
  const url = new URL(options.url
    ?? process.env.KESTREL_TEST_REDIS_URL
    ?? `redis://127.0.0.1:${process.env.KESTREL_REDIS_PORT ?? 56379}/2`);
  // Never inherit REDIS_URL: it can select an application database.
  if (!["redis:", "rediss:"].includes(url.protocol) || url.pathname !== "/2") {
    throw new TypeError("Kestrel Redis tests require a redis:// or rediss:// URL selecting database 2.");
  }

  const client = createClient({
    url: url.toString(),
    database: 2,
    disableOfflineQueue: true,
    socket: { connectTimeout: 3_000, reconnectStrategy: false },
    commandOptions: { timeout: 3_000 },
  });
  const keyPrefix = `kestrel:test:${randomUUID()}:`;
  const errors: Error[] = [];
  const onError = (error: Error) => errors.push(error);
  client.on("error", onError);

  try {
    await client.connect();
  } catch (error) {
    if (client.isOpen) client.destroy();
    client.off("error", onError);
    throw new Error("Cannot connect to the Kestrel Redis test database (db2). Check the Redis service and KESTREL_TEST_REDIS_URL.", { cause: error });
  }

  return {
    client,
    keyPrefix,
    /** Remove only this test's keys, including after failed assertions. */
    async dispose(): Promise<void> {
      try {
        for await (const keys of client.scanIterator({ MATCH: `${keyPrefix}*`, COUNT: 100 })) {
          if (keys.length > 0) await client.unlink(keys);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Redis emitted errors during the integration test.");
        }
      } finally {
        // Commands have settled; force closure so failed tests cannot leak sockets.
        if (client.isOpen) client.destroy();
        client.off("error", onError);
      }
    },
  };
}

export type RedisTestContext = Awaited<ReturnType<typeof createRedisTestContext>>;
