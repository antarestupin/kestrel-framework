import type { Locks } from "../lock/index.js";
import { CacheLockUnavailableError } from "./errors.js";
import type {
  CacheAccessOperation,
  CacheAccessPhase,
  CacheInstrumentation,
  CacheInstrumentationEvent,
  CacheLoadCoordination,
  CacheWriteOperation,
} from "./observations.js";
import {
  getUtf8Size,
  serializeCacheValue,
} from "./serialization.js";
import type {
  Cache,
  CacheAdapter,
  CacheEntry,
  CachePoolOptions,
  CacheRememberOptions,
  CacheWriteOptions,
  TagAwareCache,
  TagAwareCacheAdapter,
  TagAwareCacheRememberOptions,
  TagAwareCacheWriteOptions,
} from "./types.js";

/** Coordinates cache policy independently from the selected storage backend. */
export class CachePool implements Cache {
  private readonly inFlightLoads = new Map<
    string,
    Promise<unknown>
  >();

  private readonly now: () => Date;

  private readonly lockKeyPrefix: string;

  private readonly instrumentation: CacheInstrumentation | undefined;

  private readonly formatObservationKey: (key: string) => string;

  private readonly monotonicNow: () => number;

  public constructor(
    private readonly adapter: CacheAdapter,
    private readonly options: CachePoolOptions,
    private readonly locks?: Pick<Locks, "runExclusive">,
  ) {
    validatePoolOptions(options);
    this.now = options.now ?? (() => new Date());
    this.lockKeyPrefix = options.lockKeyPrefix ?? "cache-fill";
    this.instrumentation = options.instrumentation;
    this.formatObservationKey = options.formatObservationKey
      ?? ((key) => key);
    this.monotonicNow = options.monotonicNow
      ?? (() => performance.now());
  }

  /** Returns a stored value without invoking a loader on a miss. */
  public async get<Value>(key: string): Promise<Value | undefined> {
    const storageKey = this.composeKey(key);

    return this.read<Value>(storageKey, "get");
  }

  /** Reads one already-composed key according to the cache fail-open policy. */
  private async read<Value>(
    storageKey: string,
    operation: CacheAccessOperation,
    phase?: CacheAccessPhase,
  ): Promise<Value | undefined> {
    const startedAt = this.measureTime();

    try {
      const entry = await this.adapter.get(storageKey);

      this.recordInstrumentation({
        type: "access",
        outcome: "success",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          key: storageKey,
          operation,
          result: entry === undefined ? "miss" : "hit",
          ...(phase === undefined ? {} : { phase }),
        },
      });

      return entry?.value as Value | undefined;
    } catch (error) {
      this.reportStorageError({
        error,
        key: storageKey,
        operation: "get",
      });

      this.recordInstrumentation({
        type: "access",
        outcome: "failure",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          key: storageKey,
          operation,
          result: "error",
          ...(phase === undefined ? {} : { phase }),
        },
      });

      return undefined;
    }
  }

  /** Serializes and stores a value according to the configured TTL policy. */
  public async set<Value>(
    key: string,
    value: Value,
    options: CacheWriteOptions = {},
  ): Promise<void> {
    rejectUnsupportedTags(options);
    return this.setValue(key, value, options);
  }

  /** Shares write policy with the tag-aware facade. */
  protected async setValue<Value>(
    key: string,
    value: Value,
    options: TagAwareCacheWriteOptions,
  ): Promise<void> {
    const storageKey = this.composeKey(key);
    const startedAt = this.measureTime();
    let entry: CacheEntry;

    try {
      entry = this.createEntry(storageKey, value, options);
    } catch (error) {
      this.recordWriteFailure(storageKey, "set", startedAt);
      throw error;
    }

    if (entry.sizeBytes > this.options.maxEntrySizeBytes) {
      this.recordWrite(
        storageKey,
        "set",
        "oversized",
        entry,
        startedAt,
      );
      return;
    }

    await this.write(storageKey, entry, "set", startedAt);
  }

  /** Loads a miss once locally and, when requested, across app processes. */
  public async remember<Value>(
    key: string,
    loader: () => Promise<Value>,
    options: CacheRememberOptions = {},
  ): Promise<Value> {
    // Validate capability usage before a hit or loader can hide a caller error.
    rejectUnsupportedTags(options);
    return this.rememberValue(key, loader, options);
  }

  /** Shares read-through policy with the tag-aware facade. */
  protected async rememberValue<Value>(
    key: string,
    loader: () => Promise<Value>,
    options: TagAwareCacheRememberOptions,
  ): Promise<Value> {
    const storageKey = this.composeKey(key);
    const startedAt = this.measureTime();
    const cached = await this.read<Value>(
      storageKey,
      "remember",
      "initial",
    );

    if (cached !== undefined) {
      return cached;
    }

    const activeLoad = this.inFlightLoads.get(storageKey);

    if (activeLoad !== undefined) {
      this.recordInstrumentation({
        type: "access",
        outcome: "success",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          key: storageKey,
          operation: "remember",
          result: "local-coalesced",
          phase: "initial",
        },
      });
      return activeLoad as Promise<Value>;
    }

    const load = this.loadMissing(storageKey, loader, options);
    this.inFlightLoads.set(storageKey, load);

    try {
      return await load;
    } finally {
      // Only remove the promise installed by this call. This protects a future
      // load if cleanup and a new miss ever overlap.
      if (this.inFlightLoads.get(storageKey) === load) {
        this.inFlightLoads.delete(storageKey);
      }
    }
  }

  /** Deletes one namespaced key and propagates storage failures. */
  public async delete(key: string): Promise<boolean> {
    const storageKey = this.composeKey(key);
    const startedAt = this.measureTime();

    try {
      const deleted = await this.adapter.delete(storageKey);

      this.recordInstrumentation({
        type: "invalidation",
        outcome: "success",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          operation: "delete",
          result: deleted ? "deleted" : "not-found",
          key: storageKey,
          affectedEntries: deleted ? 1 : 0,
        },
      });

      return deleted;
    } catch (error) {
      this.recordInstrumentation({
        type: "invalidation",
        outcome: "failure",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          operation: "delete",
          result: "error",
          key: storageKey,
        },
      });

      throw error;
    }
  }

  /** Invalidates entries containing every requested tag in this namespace. */
  protected async invalidateTags(
    tags: readonly string[],
  ): Promise<number> {
    const normalizedTags = normalizeTags(tags, true);
    const startedAt = this.measureTime();

    if (!isTagAwareAdapter(this.adapter)) {
      this.recordInstrumentation({
        type: "invalidation",
        outcome: "failure",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          operation: "invalidate-all-tags",
          result: "error",
          tagCount: normalizedTags.length,
        },
      });
      throw new Error(
        "The configured cache adapter does not support tag invalidation.",
      );
    }

    try {
      const affectedEntries = await this.adapter.invalidateAllTags(
        normalizedTags.map((tag) => this.composeTag(tag)),
      );

      this.recordInstrumentation({
        type: "invalidation",
        outcome: "success",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          operation: "invalidate-all-tags",
          result: "completed",
          tagCount: normalizedTags.length,
          affectedEntries,
        },
      });

      return affectedEntries;
    } catch (error) {
      this.recordInstrumentation({
        type: "invalidation",
        outcome: "failure",
        durationMs: getDuration(startedAt, this.measureTime()),
        data: {
          operation: "invalidate-all-tags",
          result: "error",
          tagCount: normalizedTags.length,
        },
      });

      throw error;
    }
  }

  private composeKey(key: string): string {
    if (key.length === 0) {
      throw new TypeError("Cache keys cannot be empty.");
    }

    return `${this.options.namespace}:${key}`;
  }

  private composeTag(tag: string): string {
    return `${this.options.namespace}:${tag}`;
  }

  private composeLoadLockKey(storageKey: string): string {
    return `${this.lockKeyPrefix}:${storageKey}`;
  }

  private loadMissing<Value>(
    storageKey: string,
    loader: () => Promise<Value>,
    options: TagAwareCacheRememberOptions,
  ): Promise<Value> {
    if (options.lock === undefined || options.lock === false) {
      return this.loadAndCache(
        storageKey,
        loader,
        options,
        "none",
      );
    }

    if (this.locks === undefined) {
      throw new CacheLockUnavailableError();
    }

    const lockOptions = options.lock === true ? {} : options.lock;

    return this.locks.runExclusive(
      this.composeLoadLockKey(storageKey),
      async () => {
        // Another process may have filled the cache while this caller waited.
        const cached = await this.read<Value>(
          storageKey,
          "remember",
          "after-lock",
        );

        if (cached !== undefined) {
          return cached;
        }

        return this.loadAndCache(
          storageKey,
          loader,
          options,
          "lock",
        );
      },
      lockOptions,
    );
  }

  private createEntry(
    key: string,
    value: unknown,
    options: TagAwareCacheWriteOptions,
  ): CacheEntry {
    const ttlSeconds = this.getTtlSeconds(options.ttlSeconds);
    const createdAt = this.now();
    const serialized = serializeCacheValue(value);
    const tags = normalizeTags(options.tags ?? [], false)
      .map((tag) => this.composeTag(tag));
    const metadataSize = getUtf8Size(key)
      + getUtf8Size(JSON.stringify(tags));

    return {
      value: serialized.value,
      sizeBytes: serialized.sizeBytes + metadataSize,
      tags,
      createdAt,
      expiresAt: new Date(
        createdAt.getTime() + ttlSeconds * 1_000,
      ),
    };
  }

  private getTtlSeconds(ttlSeconds?: number): number {
    const effectiveTtl = ttlSeconds
      ?? this.options.defaultTtlSeconds;

    if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) {
      throw new TypeError(
        "Cache TTL must be a positive finite number of seconds.",
      );
    }

    return Math.min(effectiveTtl, this.options.maxTtlSeconds);
  }

  private async loadAndCache<Value>(
    key: string,
    loader: () => Promise<Value>,
    options: TagAwareCacheWriteOptions,
    coordination: CacheLoadCoordination,
  ): Promise<Value> {
    const loadStartedAt = this.measureTime();
    let value: Value;

    try {
      value = await loader();
      this.recordInstrumentation({
        type: "load",
        outcome: "success",
        durationMs: getDuration(loadStartedAt, this.measureTime()),
        data: {
          key,
          result: "loaded",
          coordination,
        },
      });
    } catch (error) {
      this.recordInstrumentation({
        type: "load",
        outcome: "failure",
        durationMs: getDuration(loadStartedAt, this.measureTime()),
        data: {
          key,
          result: "error",
          coordination,
        },
      });

      throw error;
    }

    const writeStartedAt = this.measureTime();

    try {
      const entry = this.createEntry(key, value, options);

      if (entry.sizeBytes <= this.options.maxEntrySizeBytes) {
        await this.write(key, entry, "remember", writeStartedAt);
      } else {
        this.recordWrite(
          key,
          "remember",
          "oversized",
          entry,
          writeStartedAt,
        );
      }
    } catch (error) {
      // Cache preparation must not turn a successful source load into an
      // application failure. Explicit set() remains strict for invalid input.
      this.reportStorageError({
        error,
        key,
        operation: "set",
      });
      this.recordWriteFailure(key, "remember", writeStartedAt);
    }

    return value;
  }

  private async write(
    key: string,
    entry: CacheEntry,
    operation: CacheWriteOperation,
    startedAt: number,
  ): Promise<void> {
    try {
      await this.adapter.set(key, entry);
      this.recordWrite(
        key,
        operation,
        "stored",
        entry,
        startedAt,
      );
    } catch (error) {
      this.reportStorageError({
        error,
        key,
        operation: "set",
      });
      this.recordWriteFailure(key, operation, startedAt, entry);
    }
  }

  private recordWrite(
    key: string,
    operation: CacheWriteOperation,
    result: "oversized" | "stored",
    entry: CacheEntry,
    startedAt: number,
  ): void {
    this.recordInstrumentation({
      type: "write",
      outcome: "success",
      durationMs: getDuration(startedAt, this.measureTime()),
      data: {
        key,
        operation,
        result,
        ttlSeconds: Math.max(
          0,
          (entry.expiresAt.getTime() - entry.createdAt.getTime()) / 1_000,
        ),
        sizeBytes: entry.sizeBytes,
        tagCount: entry.tags.length,
      },
    });
  }

  private recordWriteFailure(
    key: string,
    operation: CacheWriteOperation,
    startedAt: number,
    entry?: CacheEntry,
  ): void {
    this.recordInstrumentation({
      type: "write",
      outcome: "failure",
      durationMs: getDuration(startedAt, this.measureTime()),
      data: {
        key,
        operation,
        result: "error",
        ...(entry === undefined
          ? {}
          : {
              ttlSeconds: Math.max(
                0,
                (entry.expiresAt.getTime() - entry.createdAt.getTime())
                  / 1_000,
              ),
              sizeBytes: entry.sizeBytes,
              tagCount: entry.tags.length,
            }),
      },
    });
  }

  private measureTime(): number {
    if (this.instrumentation === undefined) {
      return 0;
    }

    try {
      const value = this.monotonicNow();

      return Number.isFinite(value) ? value : performance.now();
    } catch {
      // Faulty instrumentation clocks must not affect cache semantics.
      return performance.now();
    }
  }

  private recordInstrumentation(event: CacheInstrumentationEvent): void {
    if (this.instrumentation === undefined) {
      return;
    }

    try {
      if (event.type === "access") {
        this.instrumentation.record({
          ...event,
          data: {
            ...event.data,
            key: this.formatObservationKey(event.data.key),
          },
        });
      } else if (event.type === "load") {
        this.instrumentation.record({
          ...event,
          data: {
            ...event.data,
            key: this.formatObservationKey(event.data.key),
          },
        });
      } else if (event.type === "write") {
        this.instrumentation.record({
          ...event,
          data: {
            ...event.data,
            key: this.formatObservationKey(event.data.key),
          },
        });
      } else if (event.data.key !== undefined) {
        this.instrumentation.record({
          ...event,
          data: {
            ...event.data,
            key: this.formatObservationKey(event.data.key),
          },
        });
      } else {
        this.instrumentation.record(event);
      }
    } catch {
      // Observability must never change cache behavior or its fail-open policy.
    }
  }

  private reportStorageError(
    failure: Parameters<
      NonNullable<CachePoolOptions["reportStorageError"]>
    >[0],
  ): void {
    try {
      this.options.reportStorageError?.(failure);
    } catch {
      // Diagnostics must never change the fail-open cache policy.
    }
  }
}

/** Exposes tag operations only when construction supplies a capable adapter. */
export class TagAwareCachePool extends CachePool implements TagAwareCache {
  public constructor(
    adapter: TagAwareCacheAdapter,
    options: CachePoolOptions,
    locks?: Pick<Locks, "runExclusive">,
  ) {
    // Keep JavaScript and dynamically composed dependencies honest as well.
    if (!isTagAwareAdapter(adapter)) {
      throw new TypeError("The configured cache adapter does not support tag invalidation.");
    }
    super(adapter, options, locks);
  }

  public override set<Value>(
    key: string,
    value: Value,
    options: TagAwareCacheWriteOptions = {},
  ): Promise<void> {
    return this.setValue(key, value, options);
  }

  public override remember<Value>(
    key: string,
    loader: () => Promise<Value>,
    options: TagAwareCacheRememberOptions = {},
  ): Promise<Value> {
    return this.rememberValue(key, loader, options);
  }

  public invalidateAllTags(tags: readonly string[]): Promise<number> {
    return this.invalidateTags(tags);
  }
}

/** Narrows dynamically selected adapters without assuming their backend. */
export function isTagAwareAdapter(adapter: CacheAdapter): adapter is TagAwareCacheAdapter {
  return "invalidateAllTags" in adapter
    && typeof adapter.invalidateAllTags === "function";
}

/** Narrows the public capability when the backend is selected at runtime. */
export function isTagAwareCache(cache: Cache): cache is TagAwareCache {
  return "invalidateAllTags" in cache
    && typeof cache.invalidateAllTags === "function";
}

function rejectUnsupportedTags(options: TagAwareCacheWriteOptions): void {
  if (options.tags !== undefined) {
    throw new TypeError("Cache tags require a TagAwareCache.");
  }
}

function validatePoolOptions(options: CachePoolOptions): void {
  if (options.namespace.length === 0) {
    throw new TypeError("Cache namespaces cannot be empty.");
  }

  if (options.namespace.includes(":")) {
    throw new TypeError("Cache namespaces cannot contain a colon.");
  }

  const lockKeyPrefix = options.lockKeyPrefix ?? "cache-fill";

  if (lockKeyPrefix.length === 0) {
    throw new TypeError("Cache lock key prefixes cannot be empty.");
  }

  if (lockKeyPrefix.includes(":")) {
    throw new TypeError(
      "Cache lock key prefixes cannot contain a colon.",
    );
  }

  for (const [name, value] of [
    ["defaultTtlSeconds", options.defaultTtlSeconds],
    ["maxTtlSeconds", options.maxTtlSeconds],
    ["maxEntrySizeBytes", options.maxEntrySizeBytes],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number.`);
    }
  }
}

function normalizeTags(
  tags: readonly string[],
  requireTag: boolean,
): string[] {
  const normalized = [...new Set(tags)];

  if (requireTag && normalized.length === 0) {
    throw new TypeError("At least one cache tag is required.");
  }

  if (normalized.some((tag) => tag.length === 0)) {
    throw new TypeError("Cache tags cannot be empty.");
  }

  return normalized;
}

/** Returns a non-negative duration even when a custom clock moves backwards. */
function getDuration(startedAt: number, completedAt: number): number {
  return Math.max(0, completedAt - startedAt);
}
