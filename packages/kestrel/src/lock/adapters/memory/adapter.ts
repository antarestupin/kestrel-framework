import type {
  LockAcquireRequest,
  LockAdapter,
  LockExtendRequest,
  LockLease,
  LockPruneOptions,
  LockReleaseRequest,
  PrunableLockAdapter,
} from "../../types.js";

export interface MemoryLockAdapterOptions {
  now?: () => Date;
}

/** Process-local adapter with the same ownership semantics as shared stores. */
export class MemoryLockAdapter implements LockAdapter, PrunableLockAdapter {
  private readonly leases = new Map<string, LockLease>();

  private readonly now: () => Date;

  private fencingToken = 0n;

  public constructor(options: MemoryLockAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  public async tryAcquire(
    request: LockAcquireRequest,
  ): Promise<LockLease | undefined> {
    const now = this.now();
    const current = this.leases.get(request.key);

    if (current !== undefined && current.expiresAt > now) {
      return undefined;
    }

    const lease = this.createLease(request, now);
    this.leases.set(request.key, lease);

    return lease;
  }

  /** Acquires a complete batch without exposing partial ownership. */
  public async tryAcquireMany(
    requests: readonly LockAcquireRequest[],
  ): Promise<readonly LockLease[] | undefined> {
    validateUniqueRequests(requests);
    const now = this.now();

    for (const request of requests) {
      const current = this.leases.get(request.key);

      if (current !== undefined && current.expiresAt > now) {
        return undefined;
      }
    }

    return requests.map((request) => {
      const lease = this.createLease(request, now);
      this.leases.set(request.key, lease);
      return lease;
    });
  }

  public async extend(
    request: LockExtendRequest,
  ): Promise<LockLease | undefined> {
    const now = this.now();
    const current = this.leases.get(request.key);

    if (
      current === undefined
      || current.ownerId !== request.ownerId
      || current.expiresAt <= now
    ) {
      return undefined;
    }

    const lease: LockLease = {
      ...current,
      expiresAt: new Date(now.getTime() + request.ttlMs),
    };
    this.leases.set(request.key, lease);

    return lease;
  }

  /** Extends a complete batch without exposing partial lease updates. */
  public async extendMany(
    requests: readonly LockExtendRequest[],
  ): Promise<readonly LockLease[] | undefined> {
    validateUniqueRequests(requests);
    const now = this.now();

    for (const request of requests) {
      const current = this.leases.get(request.key);

      if (
        current === undefined
        || current.ownerId !== request.ownerId
        || current.expiresAt <= now
      ) {
        return undefined;
      }
    }

    return requests.map((request) => {
      const current = this.leases.get(request.key)!;
      const lease: LockLease = {
        ...current,
        expiresAt: new Date(now.getTime() + request.ttlMs),
      };
      this.leases.set(request.key, lease);
      return lease;
    });
  }

  public async release(request: LockReleaseRequest): Promise<boolean> {
    const current = this.leases.get(request.key);

    if (current === undefined || current.ownerId !== request.ownerId) {
      return false;
    }

    return this.leases.delete(request.key);
  }

  /** Removes a bounded number of leases that can no longer exclude callers. */
  public async prune(options: LockPruneOptions): Promise<number> {
    const limit = validateLimit(options.limit ?? 100);
    const now = this.now();
    let removed = 0;

    for (const [key, lease] of this.leases) {
      if (removed >= limit) {
        break;
      }

      if (lease.expiresAt <= now) {
        this.leases.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  private createLease(
    request: LockAcquireRequest,
    now: Date,
  ): LockLease {
    this.fencingToken += 1n;

    return {
      key: request.key,
      ownerId: request.ownerId,
      expiresAt: new Date(now.getTime() + request.ttlMs),
      fencingToken: this.fencingToken,
    };
  }
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("Lock prune limit must be a positive integer.");
  }

  return limit;
}

function validateUniqueRequests(
  requests: readonly LockAcquireRequest[],
): void {
  if (new Set(requests.map((request) => request.key)).size !== requests.length) {
    throw new TypeError("Lock batches require unique keys.");
  }
}
