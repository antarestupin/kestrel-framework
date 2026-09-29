import type { LockRunOptions } from "../lock/index.js";
import type { CacheInstrumentation } from "./observations.js";

export interface CacheWriteOptions {
  ttlSeconds?: number;
  /** Tags require the explicit TagAwareCache capability, even in variables. */
  tags?: never;
}

export interface CacheRememberOptions extends CacheWriteOptions {
  /** Enables distributed single-flight loading with optional lock overrides. */
  lock?: boolean | LockRunOptions;
}

/** Public cache operations used by application services and actions. */
export interface Cache {
  get<Value>(key: string): Promise<Value | undefined>;
  set<Value>(
    key: string,
    value: Value,
    options?: CacheWriteOptions,
  ): Promise<void>;
  remember<Value>(
    key: string,
    loader: () => Promise<Value>,
    options?: CacheRememberOptions,
  ): Promise<Value>;
  delete(key: string): Promise<boolean>;
}

export interface TagAwareCacheWriteOptions extends Omit<CacheWriteOptions, "tags"> {
  tags?: readonly string[];
}

export interface TagAwareCacheRememberOptions extends TagAwareCacheWriteOptions {
  lock?: boolean | LockRunOptions;
}

/** Services using tags must explicitly require this stronger cache contract. */
export interface TagAwareCache extends Cache {
  set<Value>(key: string, value: Value, options?: TagAwareCacheWriteOptions): Promise<void>;
  remember<Value>(
    key: string,
    loader: () => Promise<Value>,
    options?: TagAwareCacheRememberOptions,
  ): Promise<Value>;
  invalidateAllTags(tags: readonly string[]): Promise<number>;
}

/** Internal value and metadata exchanged with storage adapters. */
export interface CacheEntry {
  value: unknown;
  expiresAt: Date;
  tags: readonly string[];
  createdAt: Date;
  sizeBytes: number;
}

export interface CacheAdapter {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface CachePruneOptions {
  limit?: number;
}

export interface PrunableCacheAdapter extends CacheAdapter {
  prune(options: CachePruneOptions): Promise<number>;
}

export interface ResettableCacheAdapter extends CacheAdapter {
  reset(): Promise<number>;
}

export interface TagAwareCacheAdapter extends CacheAdapter {
  invalidateAllTags(tags: readonly string[]): Promise<number>;
}

export type CacheStorageOperation = "get" | "set";

export interface CacheStorageError {
  error: unknown;
  key: string;
  operation: CacheStorageOperation;
}

export interface CachePoolOptions {
  namespace: string;
  /** Separates cache-fill leases from other lock use cases. */
  lockKeyPrefix?: string;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  maxEntrySizeBytes: number;
  instrumentation?: CacheInstrumentation;
  formatObservationKey?: (key: string) => string;
  monotonicNow?: () => number;
  now?: () => Date;
  reportStorageError?: (failure: CacheStorageError) => void;
}
