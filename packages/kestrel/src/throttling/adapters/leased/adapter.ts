import { createUuid } from "../../../utils/uuid.js";
import {
  ThrottlingAdapterCapabilityError,
  ThrottlingBackendUnavailableError,
} from "../../errors.js";
import type {
  ThrottlingInstrumentation,
  ThrottlingLeaseObservationData,
} from "../../observations.js";
import type {
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter,
  RateLimitBatchReservationResult,
  RateLimitInspectionResult,
  RateLimitLeaseAllocation,
  RateLimitLeaseRequest,
  RateLimitLeaseReturn,
  RateLimitPruneOptions,
  RateLimitReconciliationRequest,
  RateLimitReservationRequest,
  RateLimitReservationResult,
} from "../../types.js";

interface LocalLease {
  readonly expiresAt: Date;
  readonly expiresAtMs: number;
  readonly id: string;
  remaining: number;
}

interface CachedLeaseDenial {
  readonly expiresAtMs: number;
  readonly remaining: Readonly<Record<string, number>>;
  readonly retryAt: Date;
}

export interface LeasedRateLimitAdapterOptions {
  readonly monotonicNow?: () => number;
  readonly now?: () => Date;
  readonly ownerId?: string;
  readonly random?: () => number;
  readonly retryJitterRatio?: number;
  readonly instrumentation?: ThrottlingInstrumentation;
  readonly maxCachedDenials?: number;
}

const DEFAULT_RETRY_JITTER_RATIO = 0.1;
const DEFAULT_MAX_CACHED_DENIALS = 10_000;

/** Consumes bounded PostgreSQL grants locally and replenishes them atomically. */
export class LeasedRateLimitAdapter implements
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter {
  private readonly denialCache = new Map<string, CachedLeaseDenial>();

  private readonly leases = new Map<string, LocalLease[]>();

  private readonly locks = new Map<string, Promise<void>>();

  private readonly monotonicNow: () => number;

  private readonly maxCachedDenials: number;

  private readonly now: () => Date;

  private readonly ownerId: string;

  private readonly random: () => number;

  private readonly retryJitterRatio: number;

  private readonly instrumentation: ThrottlingInstrumentation | undefined;

  private closed = false;

  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly authoritative: LeasableRateLimitAdapter,
    options: LeasedRateLimitAdapterOptions = {},
  ) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.maxCachedDenials = options.maxCachedDenials
      ?? DEFAULT_MAX_CACHED_DENIALS;
    this.now = options.now ?? (() => new Date());
    this.ownerId = options.ownerId ?? createUuid();
    this.random = options.random ?? Math.random;
    this.retryJitterRatio = options.retryJitterRatio
      ?? DEFAULT_RETRY_JITTER_RATIO;
    this.instrumentation = options.instrumentation;

    if (this.ownerId.trim().length === 0) {
      throw new TypeError("A leased throttling owner id cannot be empty.");
    }

    if (
      !Number.isFinite(this.retryJitterRatio)
      || this.retryJitterRatio < 0
      || this.retryJitterRatio > 1
    ) {
      throw new TypeError("retryJitterRatio must be between zero and one.");
    }

    if (!Number.isInteger(this.maxCachedDenials) || this.maxCachedDenials <= 0) {
      throw new TypeError("maxCachedDenials must be a positive integer.");
    }
  }

  public async reserve(
    request: RateLimitReservationRequest,
  ): Promise<RateLimitReservationResult> {
    const result = await this.reserveMany([request]);
    const remaining = result.remaining[request.key] ?? 0;

    return result.admitted
      ? {
          admitted: true,
          remaining,
          ...(result.source === undefined ? {} : { source: result.source }),
        }
      : {
          admitted: false,
          remaining,
          retryAt: result.retryAt,
          ...(result.source === undefined ? {} : { source: result.source }),
        };
  }

  public reserveMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<RateLimitBatchReservationResult> {
    this.assertOpen();

    if (requests.length === 0) {
      return Promise.resolve({ admitted: true, remaining: {}, source: "leased" });
    }

    const strategies = new Set(requests.map((request) =>
      request.coordination?.strategy ?? "exact"));

    if (strategies.size > 1) {
      throw new TypeError(
        "One atomic reservation cannot mix exact and leased coordination.",
      );
    }

    if (!strategies.has("leased")) {
      return this.reserveExactly(requests);
    }

    const leasedRequests = requests as readonly RateLimitLeaseRequest[];
    return this.withLocks(
      leasedRequests.map((request) => request.key),
      () => this.reserveFromLeases(leasedRequests),
    );
  }

  public reconcile(
    requests: readonly RateLimitReconciliationRequest[],
  ): Promise<Readonly<Record<string, number>>> {
    if (this.authoritative.reconcile === undefined) {
      throw new ThrottlingAdapterCapabilityError("cost reconciliation");
    }

    // Deltas remain authoritative: grants reserve estimates, while this
    // mutation accounts for actual-minus-estimated usage globally.
    return this.authoritative.reconcile(requests);
  }

  public async inspectMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<readonly RateLimitInspectionResult[]> {
    this.assertOpen();
    const results = new Array<RateLimitInspectionResult>(requests.length);
    const authoritative: Array<{
      index: number;
      request: RateLimitReservationRequest;
    }> = [];
    const nowMs = this.getMonotonicNow();

    requests.forEach((request, index) => {
      if (request.coordination?.strategy !== "leased") {
        authoritative.push({ index, request });
        return;
      }

      this.discardExpired(request.key, nowMs);
      const remaining = this.localRemaining(request.key);

      if (remaining + Number.EPSILON >= request.cost) {
        results[index] = { available: true, remaining, source: "leased" };
      } else {
        authoritative.push({ index, request });
      }
    });

    if (authoritative.length > 0) {
      if (this.authoritative.inspectMany === undefined) {
        throw new ThrottlingAdapterCapabilityError("advisory inspection");
      }

      const inspected = await this.authoritative.inspectMany(
        authoritative.map(({ request }) => request),
      );

      if (inspected.length !== authoritative.length) {
        throw new TypeError(
          "The throttling adapter returned an incomplete inspection.",
        );
      }

      authoritative.forEach(({ index }, inspectedIndex) => {
        results[index] = inspected[inspectedIndex]!;
      });
    }

    return results;
  }

  public allocateLeases(
    ownerId: string,
    requests: readonly RateLimitLeaseRequest[],
    completedLeases: readonly RateLimitLeaseReturn[] = [],
  ) {
    return this.authoritative.allocateLeases(
      ownerId,
      requests,
      completedLeases,
    );
  }

  public returnLeases(leases: readonly RateLimitLeaseReturn[]): Promise<number> {
    return this.authoritative.returnLeases(leases);
  }

  public prune(options: RateLimitPruneOptions): Promise<number> {
    const prunable = this.authoritative as Partial<PrunableRateLimitAdapter>;

    if (prunable.prune === undefined) {
      throw new ThrottlingAdapterCapabilityError("bounded pruning");
    }

    return prunable.prune(options);
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.returnLocalLeases().finally(() =>
      this.authoritative.close?.());
    return this.closePromise;
  }

  private async reserveFromLeases(
    requests: readonly RateLimitLeaseRequest[],
  ): Promise<RateLimitBatchReservationResult> {
    const nowMs = this.getMonotonicNow();
    const signature = batchSignature(requests);
    const cached = this.getCachedDenial(signature, nowMs);

    if (cached !== undefined) {
      return {
        admitted: false,
        remaining: cached.remaining,
        retryAt: cached.retryAt,
        source: "leased",
      };
    }

    for (const request of requests) this.discardExpired(request.key, nowMs);
    const missing = requests.filter((request) =>
      this.localRemaining(request.key) + Number.EPSILON < request.cost);
    const exactFallback = new Map<string, RateLimitLeaseAllocation>();
    let source: RateLimitReservationResult["source"] = "leased";

    if (missing.length > 0) {
      const completed = this.takeCompletedLeases(missing.map(({ key }) => key));
      const allocation = await this.authoritative.allocateLeases(
        this.ownerId,
        missing,
        completed,
      );
      if (allocation.source === "emergency-local") source = allocation.source;

      if (!allocation.admitted) {
        const retryAt = this.addRetryJitter(allocation.retryAt);
        const denial = {
          expiresAtMs: this.getMonotonicNow()
            + Math.max(0, retryAt.getTime() - this.getNowMs()),
          remaining: allocation.remaining,
          retryAt,
        };
        this.cacheDenial(signature, denial);
        for (const current of missing) {
          this.recordLease(current.key, "reject", current.cost, {
            remaining: allocation.remaining[current.key] ?? 0,
          });
        }

        return {
          admitted: false,
          remaining: allocation.remaining,
          retryAt,
          source,
        };
      }

      for (const request of missing) {
        const granted = allocation.allocations[request.key];

        if (granted === undefined) {
          throw new TypeError("The lease adapter returned an incomplete allocation.");
        }

        if (granted.mode === "exact") {
          exactFallback.set(request.key, granted);
          this.recordLease(request.key, "exact-fallback", request.cost, {
            remaining: granted.remaining,
          });
        } else {
          this.addLocalLease(request.key, granted);
        }
      }
    }

    const remaining: Record<string, number> = {};

    for (const request of requests) {
      const exact = exactFallback.get(request.key);

      if (exact !== undefined) {
        remaining[request.key] = exact.remaining;
        continue;
      }

      this.consumeLocally(request.key, request.cost);
      remaining[request.key] = this.localRemaining(request.key);
    }

    this.denialCache.delete(signature);
    return { admitted: true, remaining, source };
  }

  private reserveExactly(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<RateLimitBatchReservationResult> {
    if (requests.length === 1) {
      const request = requests[0]!;

      return this.authoritative.reserve(request).then((result) => {
        const source = result.source === undefined
          ? {}
          : { source: result.source };

        return result.admitted
          ? {
              admitted: true,
              remaining: { [request.key]: result.remaining },
              ...source,
            }
          : {
              admitted: false,
              remaining: { [request.key]: result.remaining },
              retryAt: result.retryAt,
              ...source,
            };
      });
    }

    if (this.authoritative.reserveMany === undefined) {
      throw new ThrottlingAdapterCapabilityError("atomic batch reservation");
    }

    return this.authoritative.reserveMany(requests);
  }

  private addLocalLease(
    key: string,
    allocation: Extract<RateLimitLeaseAllocation, { mode: "lease" }>,
  ): void {
    const durationMs = allocation.expiresAt.getTime() - this.getNowMs();

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new ThrottlingBackendUnavailableError({
        cause: new Error("The authoritative backend returned an expired lease."),
      });
    }

    const leases = this.leases.get(key) ?? [];
    leases.push({
      id: allocation.leaseId,
      remaining: allocation.units,
      expiresAt: allocation.expiresAt,
      expiresAtMs: this.getMonotonicNow() + durationMs,
    });
    leases.sort((left, right) => left.expiresAtMs - right.expiresAtMs);
    this.leases.set(key, leases);
    this.recordLease(key, "issue", allocation.units, {
      remaining: allocation.units,
    });
  }

  private consumeLocally(key: string, cost: number): void {
    let needed = cost;

    for (const lease of this.leases.get(key) ?? []) {
      const consumed = Math.min(lease.remaining, needed);
      lease.remaining -= consumed;
      needed -= consumed;
      if (needed <= Number.EPSILON) {
        this.recordLease(key, "consume", cost, {
          remaining: this.localRemaining(key),
        });
        return;
      }
    }

    throw new TypeError("A leased reservation committed without enough capacity.");
  }

  private localRemaining(key: string): number {
    return (this.leases.get(key) ?? []).reduce(
      (total, lease) => total + lease.remaining,
      0,
    );
  }

  private discardExpired(key: string, nowMs: number): void {
    const leases = this.leases.get(key) ?? [];
    const active = leases.filter(
      (lease) => lease.expiresAtMs > nowMs,
    );
    const expiredUnits = leases
      .filter((lease) => lease.expiresAtMs <= nowMs)
      .reduce((total, lease) => total + lease.remaining, 0);

    if (expiredUnits > Number.EPSILON) {
      this.recordLease(key, "expire", expiredUnits);
    }

    if (active.length === 0) this.leases.delete(key);
    else this.leases.set(key, active);
  }

  private takeCompletedLeases(keys: readonly string[]): RateLimitLeaseReturn[] {
    const completed: RateLimitLeaseReturn[] = [];

    for (const key of keys) {
      const active: LocalLease[] = [];

      for (const lease of this.leases.get(key) ?? []) {
        if (lease.remaining <= Number.EPSILON) {
          completed.push({ key, leaseId: lease.id, remaining: 0 });
        } else {
          active.push(lease);
        }
      }

      if (active.length === 0) this.leases.delete(key);
      else this.leases.set(key, active);
    }

    return completed;
  }

  private async returnLocalLeases(): Promise<void> {
    const nowMs = this.getMonotonicNow();
    const returned: RateLimitLeaseReturn[] = [];

    for (const [key, leases] of this.leases) {
      for (const lease of leases) {
        if (lease.expiresAtMs > nowMs) {
          returned.push({
            key,
            leaseId: lease.id,
            remaining: lease.remaining,
          });
        }
      }
    }

    this.leases.clear();
    if (returned.length === 0) return;

    try {
      await this.authoritative.returnLeases(returned);
      for (const lease of returned) {
        this.recordLease(lease.key, "return", lease.remaining);
      }
    } catch (error) {
      if (!(error instanceof ThrottlingBackendUnavailableError)) throw error;
      // Lost returns only immobilize capacity; they never over-admit work.
    }
  }

  private getCachedDenial(
    signature: string,
    nowMs: number,
  ): CachedLeaseDenial | undefined {
    const denial = this.denialCache.get(signature);

    if (denial !== undefined && denial.expiresAtMs > nowMs) return denial;
    this.denialCache.delete(signature);
    return undefined;
  }

  private cacheDenial(signature: string, denial: CachedLeaseDenial): void {
    if (
      !this.denialCache.has(signature)
      && this.denialCache.size >= this.maxCachedDenials
    ) {
      const oldest = this.denialCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.denialCache.delete(oldest);
    }

    this.denialCache.set(signature, denial);
  }

  private addRetryJitter(retryAt: Date): Date {
    const waitMs = Math.max(0, retryAt.getTime() - this.getNowMs());
    const random = this.random();

    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new TypeError("The throttling random source must return [0, 1].");
    }

    return new Date(
      retryAt.getTime() + Math.ceil(waitMs * this.retryJitterRatio * random),
    );
  }

  private withLocks<Value>(
    keys: readonly string[],
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const ordered = [...new Set(keys)].sort();

    const enter = (index: number): Promise<Value> => {
      const key = ordered[index];

      return key === undefined
        ? operation()
        : this.withLock(key, () => enter(index + 1));
    };

    return enter(0);
  }

  private async withLock<Value>(
    key: string,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const predecessor = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => lock);

    this.locks.set(key, tail);
    await predecessor;

    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private getNowMs(): number {
    const value = this.now().getTime();

    if (!Number.isFinite(value)) {
      throw new TypeError("The leased throttling clock returned an invalid date.");
    }

    return value;
  }

  private getMonotonicNow(): number {
    const value = this.monotonicNow();

    if (!Number.isFinite(value)) {
      throw new TypeError("The leased throttling monotonic clock must be finite.");
    }

    return value;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ThrottlingBackendUnavailableError({
        cause: new Error("The leased throttling adapter is closed."),
      });
    }
  }

  private recordLease(
    key: string,
    operation: ThrottlingLeaseObservationData["operation"],
    units: number,
    extra: { readonly remaining?: number } = {},
  ): void {
    if (this.instrumentation === undefined) return;

    try {
      this.instrumentation.record({
        type: "lease",
        durationMs: 0,
        outcome: operation === "reject" ? "failure" : "success",
        data: { key, operation, units, ...extra },
      });
    } catch {
      // Instrumentation must never alter admission or lease lifecycle behavior.
    }
  }
}

function batchSignature(requests: readonly RateLimitLeaseRequest[]): string {
  return [...requests]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((request) => [
      request.key,
      request.limit,
      request.periodMs,
      request.burst,
      request.cost,
      request.coordination.maxLeaseUnits,
      request.coordination.leaseMs,
      request.coordination.maxOutstandingUnits,
      request.coordination.guardBandUnits,
    ].join(":"))
    .join("|");
}
