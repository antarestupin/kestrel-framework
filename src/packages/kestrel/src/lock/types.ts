import type { LockInstrumentation } from "./observations.js";

export type Awaitable<Value> = Value | Promise<Value>;

/** Atomic lease data exchanged between the manager and storage adapters. */
export interface LockLease {
  key: string;
  ownerId: string;
  expiresAt: Date;
  fencingToken: bigint;
}

export interface LockAcquireRequest {
  key: string;
  ownerId: string;
  ttlMs: number;
}

export type LockExtendRequest = LockAcquireRequest;

export interface LockReleaseRequest {
  key: string;
  ownerId: string;
}

/** Store contract whose ownership checks must be implemented atomically. */
export interface LockAdapter {
  tryAcquire(
    request: LockAcquireRequest,
  ): Promise<LockLease | undefined>;
  /** Atomically acquires every request, or returns undefined without changes. */
  tryAcquireMany?(
    requests: readonly LockAcquireRequest[],
  ): Promise<readonly LockLease[] | undefined>;
  extend(
    request: LockExtendRequest,
  ): Promise<LockLease | undefined>;
  /** Atomically extends every request, or returns undefined without changes. */
  extendMany?(
    requests: readonly LockExtendRequest[],
  ): Promise<readonly LockLease[] | undefined>;
  release(request: LockReleaseRequest): Promise<boolean>;
}

export interface LockPruneOptions {
  limit?: number;
}

export interface PrunableLockAdapter extends LockAdapter {
  prune(options: LockPruneOptions): Promise<number>;
}

export interface LockAcquireOptions {
  ttlMs?: number;
}

export interface LockWaitOptions extends LockAcquireOptions {
  waitTimeoutMs?: number;
  retryIntervalMs?: number;
  signal?: AbortSignal;
}

export type LockRunOptions = LockWaitOptions;

/** Cooperative cancellation context for an exclusive lock handler. */
export interface LockRunContext {
  readonly signal: AbortSignal;
}

/** An acquired lease that can only be changed by its current owner. */
export interface LockHandle {
  readonly key: string;
  readonly expiresAt: Date;
  readonly fencingToken: bigint;
  extend(ttlMs?: number): Promise<void>;
  release(): Promise<void>;
}

/** Public lock operations used by application services and actions. */
export interface Locks {
  tryAcquire(
    key: string,
    options?: LockAcquireOptions,
  ): Promise<LockHandle | undefined>;
  acquire(
    key: string,
    options?: LockWaitOptions,
  ): Promise<LockHandle>;
  acquireMany(
    keys: readonly string[],
    options?: LockWaitOptions,
  ): Promise<readonly LockHandle[]>;
  runExclusive<Value>(
    key: string,
    handler: (
      lock: LockHandle,
      context: LockRunContext,
    ) => Awaitable<Value>,
    options?: LockRunOptions,
  ): Promise<Value>;
  runExclusiveMany<Value>(
    keys: readonly string[],
    handler: (
      locks: readonly LockHandle[],
      context: LockRunContext,
    ) => Awaitable<Value>,
    options?: LockRunOptions,
  ): Promise<Value>;
}

export interface LockManagerOptions {
  namespace: string;
  defaultTtlMs: number;
  maxTtlMs: number;
  defaultWaitTimeoutMs: number;
  retryIntervalMs: number;
  retryJitterRatio?: number;
  instrumentation?: LockInstrumentation;
  formatObservationKey?: (key: string) => string;
  monotonicNow?: () => number;
  now?: () => Date;
  createOwnerId?: () => string;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}
