import type {
  CacheEntry,
  CachePruneOptions,
  PrunableCacheAdapter,
  ResettableCacheAdapter,
  TagAwareCacheAdapter,
} from "../../types.js";

export interface MemoryCacheAdapterOptions {
  maxEntries: number;
  maxSizeBytes: number;
  maxEntrySizeBytes: number;
  pruneBatchSize?: number;
  now?: () => Date;
}

/** Bounded process-local cache using least-recently-used eviction. */
export class MemoryCacheAdapter implements
  PrunableCacheAdapter,
  ResettableCacheAdapter,
  TagAwareCacheAdapter
{
  private readonly entries = new Map<string, CacheEntry>();

  private readonly now: () => Date;

  private readonly pruneBatchSize: number;

  private sizeBytes = 0;

  public constructor(
    private readonly options: MemoryCacheAdapterOptions,
  ) {
    validateOptions(options);
    this.now = options.now ?? (() => new Date());
    this.pruneBatchSize = options.pruneBatchSize ?? 100;
  }

  /** Returns a fresh entry and promotes it to the LRU position. */
  public async get(
    key: string,
  ): Promise<CacheEntry | undefined> {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiresAt.getTime() <= this.now().getTime()) {
      this.remove(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry;
  }

  /** Stores an entry and evicts old entries until every limit is respected. */
  public async set(
    key: string,
    entry: CacheEntry,
  ): Promise<void> {
    if (entry.sizeBytes > this.options.maxEntrySizeBytes) {
      return;
    }

    await this.prune({ limit: this.pruneBatchSize });
    this.remove(key);
    this.entries.set(key, entry);
    this.sizeBytes += entry.sizeBytes;

    while (
      this.entries.size > this.options.maxEntries
      || this.sizeBytes > this.options.maxSizeBytes
    ) {
      const oldestKey = this.entries.keys().next()
        .value as string | undefined;

      if (oldestKey === undefined) {
        break;
      }

      this.remove(oldestKey);
    }
  }

  public async delete(key: string): Promise<boolean> {
    return this.remove(key);
  }

  /** Removes at most limit expired entries after inspecting a bounded batch. */
  public async prune(options: CachePruneOptions): Promise<number> {
    const limit = validateLimit(options.limit ?? this.pruneBatchSize);
    const now = this.now().getTime();
    let examined = 0;
    let removed = 0;

    for (const [key, entry] of this.entries) {
      if (examined >= limit) {
        break;
      }

      examined += 1;

      if (entry.expiresAt.getTime() <= now) {
        this.remove(key);
        removed += 1;
      }
    }

    return removed;
  }

  public async reset(): Promise<number> {
    const removed = this.entries.size;
    this.entries.clear();
    this.sizeBytes = 0;

    return removed;
  }

  public async invalidateAllTags(
    tags: readonly string[],
  ): Promise<number> {
    if (tags.length === 0) {
      throw new TypeError("At least one cache tag is required.");
    }

    let removed = 0;

    for (const [key, entry] of this.entries) {
      if (tags.every((tag) => entry.tags.includes(tag))) {
        this.remove(key);
        removed += 1;
      }
    }

    return removed;
  }

  private remove(key: string): boolean {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return false;
    }

    this.entries.delete(key);
    this.sizeBytes -= entry.sizeBytes;

    return true;
  }
}

function validateOptions(options: MemoryCacheAdapterOptions): void {
  for (const [name, value] of [
    ["maxEntries", options.maxEntries],
    ["maxSizeBytes", options.maxSizeBytes],
    ["maxEntrySizeBytes", options.maxEntrySizeBytes],
    ["pruneBatchSize", options.pruneBatchSize ?? 100],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("Cache prune limit must be a positive integer.");
  }

  return limit;
}
