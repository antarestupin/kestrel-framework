import {
  and,
  arrayContains,
  count,
  eq,
  gt,
  sql,
} from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { cacheEntries } from "../../postgres_schema.js";
import type {
  CacheEntry,
  CachePruneOptions,
  PrunableCacheAdapter,
  ResettableCacheAdapter,
  TagAwareCacheAdapter,
} from "../../types.js";

export type PostgresCacheDatabase = PgDatabase<
  NodePgQueryResultHKT,
  Record<string, unknown>
>;

export interface PostgresCacheAdapterOptions {
  maxEntries: number;
  maxEntrySizeBytes: number;
  defaultPruneLimit?: number;
  now?: () => Date;
}

/** Shared cache storage implemented with PostgreSQL and bounded maintenance. */
export class PostgresCacheAdapter implements
  PrunableCacheAdapter,
  ResettableCacheAdapter,
  TagAwareCacheAdapter
{
  private readonly now: () => Date;

  private readonly defaultPruneLimit: number;

  public constructor(
    private readonly database: PostgresCacheDatabase,
    private readonly options: PostgresCacheAdapterOptions,
    private readonly table: typeof cacheEntries = cacheEntries,
  ) {
    validateAdapterOptions(options);
    this.now = options.now ?? (() => new Date());
    this.defaultPruneLimit = options.defaultPruneLimit ?? 1_000;
  }

  /** Reads only entries whose absolute expiration is still in the future. */
  public async get(
    key: string,
  ): Promise<CacheEntry | undefined> {
    const [entry] = await this.database
      .select({
        value: this.table.value,
        tags: this.table.tags,
        expiresAt: this.table.expiresAt,
        createdAt: this.table.createdAt,
        sizeBytes: this.table.sizeBytes,
      })
      .from(this.table)
      .where(and(
        eq(this.table.key, key),
        gt(this.table.expiresAt, this.now()),
      ))
      .limit(1);

    return entry;
  }

  /** Upserts an entry without changing its absolute expiration semantics. */
  public async set(
    key: string,
    entry: CacheEntry,
  ): Promise<void> {
    if (entry.sizeBytes > this.options.maxEntrySizeBytes) {
      return;
    }

    await this.database
      .insert(this.table)
      .values({
        key,
        value: entry.value,
        tags: [...entry.tags],
        expiresAt: entry.expiresAt,
        createdAt: entry.createdAt,
        sizeBytes: entry.sizeBytes,
      })
      .onConflictDoUpdate({
        target: this.table.key,
        set: {
          value: entry.value,
          tags: [...entry.tags],
          expiresAt: entry.expiresAt,
          createdAt: entry.createdAt,
          sizeBytes: entry.sizeBytes,
        },
      });
  }

  public async delete(key: string): Promise<boolean> {
    const deleted = await this.database
      .delete(this.table)
      .where(eq(this.table.key, key))
      .returning({ key: this.table.key });

    return deleted.length > 0;
  }

  public async reset(): Promise<number> {
    const deleted = await this.database
      .delete(this.table)
      .returning({ key: this.table.key });

    return deleted.length;
  }

  public async invalidateAllTags(
    tags: readonly string[],
  ): Promise<number> {
    if (tags.length === 0) {
      throw new TypeError("At least one cache tag is required.");
    }

    const deleted = await this.database
      .delete(this.table)
      .where(arrayContains(this.table.tags, [...tags]))
      .returning({ key: this.table.key });

    return deleted.length;
  }

  /**
   * Removes expired rows first, then evicts overflow by expiration and age.
   * Both phases claim a bounded batch so multiple app instances can cooperate.
   */
  public async prune(options: CachePruneOptions): Promise<number> {
    const limit = validatePruneLimit(
      options.limit ?? this.defaultPruneLimit,
    );
    const expired = await this.deleteExpired(limit);
    const remainingLimit = limit - expired;

    if (remainingLimit === 0) {
      return expired;
    }

    const overflow = await this.deleteOverflow(remainingLimit);

    return expired + overflow;
  }

  private async deleteExpired(
    limit: number,
  ): Promise<number> {
    const result = await this.database.execute(sql`
      WITH candidates AS (
        SELECT ${this.table.key}
        FROM ${this.table}
        WHERE ${this.table.expiresAt} <= ${this.now()}
        ORDER BY ${this.table.expiresAt}, ${this.table.key}
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM ${this.table}
      USING candidates
      WHERE ${this.table.key} = candidates.key
      RETURNING ${this.table.key}
    `);

    return result.rows.length;
  }

  private async deleteOverflow(
    limit: number,
  ): Promise<number> {
    const [current] = await this.database
      .select({ count: count() })
      .from(this.table);
    const overflow = Math.max(
      (current?.count ?? 0) - this.options.maxEntries,
      0,
    );
    const evictionLimit = Math.min(limit, overflow);

    if (evictionLimit === 0) {
      return 0;
    }

    const result = await this.database.execute(sql`
      WITH candidates AS (
        SELECT ${this.table.key}
        FROM ${this.table}
        ORDER BY
          ${this.table.expiresAt},
          ${this.table.createdAt},
          ${this.table.key}
        LIMIT ${evictionLimit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM ${this.table}
      USING candidates
      WHERE ${this.table.key} = candidates.key
      RETURNING ${this.table.key}
    `);

    return result.rows.length;
  }
}

function validateAdapterOptions(
  options: PostgresCacheAdapterOptions,
): void {
  for (const [name, value] of [
    ["maxEntries", options.maxEntries],
    ["maxEntrySizeBytes", options.maxEntrySizeBytes],
    ["defaultPruneLimit", options.defaultPruneLimit ?? 1_000],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }
}

function validatePruneLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("Cache prune limit must be a positive integer.");
  }

  return limit;
}
