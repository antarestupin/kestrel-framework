import { z } from "zod";

import type { CacheAdapter, CacheEntry } from "../../types.js";

/** Borrowed command transport, compatible with a standard node-redis client. */
export interface RedisCacheClient {
  sendCommand(arguments_: string[]): Promise<unknown>;
}

export interface RedisCacheAdapterOptions {
  maxEntrySizeBytes: number;
  /** Isolates cache data from other Redis users, before the pool namespace. */
  keyPrefix?: string;
  now?: () => Date;
}

// A versioned envelope prevents malformed or incompatible data becoming hits.
const storedEntrySchema = z.object({
  version: z.literal(1),
  value: z.json(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  sizeBytes: z.number().int().nonnegative(),
});

/** Minimal Redis cache: native absolute expiration, without tags or maintenance. */
export class RedisCacheAdapter implements CacheAdapter {
  private readonly keyPrefix: string;
  private readonly now: () => Date;

  public constructor(
    private readonly client: RedisCacheClient,
    private readonly options: RedisCacheAdapterOptions,
  ) {
    if (!Number.isSafeInteger(options.maxEntrySizeBytes)
      || options.maxEntrySizeBytes <= 0) {
      throw new TypeError("maxEntrySizeBytes must be a positive safe integer.");
    }
    this.keyPrefix = options.keyPrefix ?? "kestrel:cache:";
    if (this.keyPrefix.length === 0) {
      throw new TypeError("Redis cache key prefixes cannot be empty.");
    }
    this.now = options.now ?? (() => new Date());
  }

  public async get(key: string): Promise<CacheEntry | undefined> {
    const reply = await this.client.sendCommand(["GET", this.keyPrefix + key]);
    if (reply === null) return undefined;
    if (typeof reply !== "string") {
      throw new TypeError("Redis cache GET must return a string or null.");
    }

    const stored = storedEntrySchema.parse(JSON.parse(reply));
    const expiresAt = new Date(stored.expiresAt);
    // Do not delete here: a concurrent writer may already have replaced the key.
    if (expiresAt.getTime() <= this.now().getTime()) return undefined;

    return {
      value: stored.value,
      createdAt: new Date(stored.createdAt),
      expiresAt,
      sizeBytes: stored.sizeBytes,
      tags: [],
    };
  }

  public async set(key: string, entry: CacheEntry): Promise<void> {
    if (entry.tags.length > 0) {
      throw new TypeError("RedisCacheAdapter does not support cache tags.");
    }
    if (entry.sizeBytes > this.options.maxEntrySizeBytes) return;

    const stored = storedEntrySchema.parse({
      version: 1,
      value: entry.value,
      createdAt: entry.createdAt.toISOString(),
      expiresAt: entry.expiresAt.toISOString(),
      sizeBytes: entry.sizeBytes,
    });
    if (entry.expiresAt.getTime() <= this.now().getTime()) {
      // An expired replacement must not leave the previous value accessible.
      await this.delete(key);
      return;
    }

    // One command installs both the value and its original absolute deadline.
    const reply = await this.client.sendCommand([
      "SET", this.keyPrefix + key, JSON.stringify(stored),
      "PXAT", String(entry.expiresAt.getTime()),
    ]);
    if (reply !== "OK") {
      throw new TypeError("Redis cache SET must return OK.");
    }
  }

  public async delete(key: string): Promise<boolean> {
    const reply = await this.client.sendCommand(["DEL", this.keyPrefix + key]);
    if (reply !== 0 && reply !== 1) {
      throw new TypeError("Redis cache DEL must return zero or one.");
    }
    return reply === 1;
  }
}
