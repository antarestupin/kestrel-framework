import { ThrottlingAdapterCapabilityError } from "../../errors.js";
import type {
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter,
  RateLimitAdapter,
  RateLimitBatchReservationResult,
  RateLimitInspectionResult,
  RateLimitLeaseBatchResult,
  RateLimitLeaseRequest,
  RateLimitLeaseReturn,
  RateLimitPruneOptions,
  RateLimitReconciliationRequest,
  RateLimitReservationRequest,
  RateLimitReservationResult,
} from "../../types.js";

interface SingleDenial {
  readonly expiresAtMs: number;
  readonly remaining: number;
  readonly retryAt: Date;
  readonly signature: string;
}

interface BatchDenial {
  readonly expiresAtMs: number;
  readonly remaining: Readonly<Record<string, number>>;
  readonly retryAt: Date;
}

export interface DenialCachingRateLimitAdapterOptions {
  readonly maxEntries?: number;
  readonly monotonicNow?: () => number;
  readonly now?: () => Date;
}

const DEFAULT_MAX_ENTRIES = 10_000;

/** Coalesces matching authoritative denials without caching admissions. */
export class DenialCachingRateLimitAdapter
implements LeasableRateLimitAdapter, PrunableRateLimitAdapter {
  private readonly batchDenials = new Map<string, BatchDenial>();

  private readonly serialization = new Map<string, Promise<void>>();

  private readonly singleDenials = new Map<string, SingleDenial>();

  private readonly maxEntries: number;

  private readonly monotonicNow: () => number;

  private readonly now: () => Date;

  public constructor(
    private readonly adapter: RateLimitAdapter,
    options: DenialCachingRateLimitAdapterOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.now = options.now ?? (() => new Date());

    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new TypeError("maxEntries must be a positive integer.");
    }
  }

  public reserve(
    request: RateLimitReservationRequest,
  ): Promise<RateLimitReservationResult> {
    const serializationKey = `single:${request.key}`;

    return this.serialize(serializationKey, async () => {
      const cached = this.getSingleDenial(request);

      if (cached !== undefined) {
        return {
          admitted: false,
          remaining: cached.remaining,
          retryAt: cached.retryAt,
          source: "denial-cache",
        };
      }

      const result = await this.adapter.reserve(request);

      if (result.admitted) {
        this.singleDenials.delete(request.key);
      } else {
        this.cacheSingleDenial(request, result);
      }

      return result;
    });
  }

  public reserveMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<RateLimitBatchReservationResult> {
    if (requests.length === 1) {
      const request = requests[0]!;

      return this.reserve(request).then((result) => result.admitted
        ? {
            admitted: true,
            remaining: { [request.key]: result.remaining },
            ...(result.source === undefined ? {} : { source: result.source }),
          }
        : {
            admitted: false,
            remaining: { [request.key]: result.remaining },
            retryAt: result.retryAt,
            ...(result.source === undefined ? {} : { source: result.source }),
          });
    }

    const signature = batchSignature(requests);

    return this.serialize(`batch:${signature}`, async () => {
      const cached = this.getBatchDenial(signature);

      if (cached !== undefined) {
        return {
          admitted: false,
          remaining: cached.remaining,
          retryAt: cached.retryAt,
          source: "denial-cache",
        };
      }

      if (this.adapter.reserveMany === undefined) {
        throw new ThrottlingAdapterCapabilityError("atomic batch reservation");
      }

      const result = await this.adapter.reserveMany(requests);

      if (result.admitted) {
        this.batchDenials.delete(signature);
      } else {
        this.cacheBatchDenial(signature, result);
      }

      return result;
    });
  }

  public async reconcile(
    requests: readonly RateLimitReconciliationRequest[],
  ): Promise<Readonly<Record<string, number>>> {
    if (this.adapter.reconcile === undefined) {
      throw new ThrottlingAdapterCapabilityError("cost reconciliation");
    }

    const result = await this.adapter.reconcile(requests);

    // An authoritative adjustment can invalidate any composite denial.
    this.singleDenials.clear();
    this.batchDenials.clear();
    return result;
  }

  public async inspectMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<readonly RateLimitInspectionResult[]> {
    const results = new Array<RateLimitInspectionResult>(requests.length);
    const missing: Array<{
      index: number;
      request: RateLimitReservationRequest;
    }> = [];

    requests.forEach((request, index) => {
      const cached = this.getSingleDenial(request);

      if (cached === undefined) {
        missing.push({ index, request });
      } else {
        results[index] = {
          available: false,
          remaining: cached.remaining,
          retryAt: cached.retryAt,
          source: "denial-cache",
        };
      }
    });

    if (missing.length > 0) {
      if (this.adapter.inspectMany === undefined) {
        throw new ThrottlingAdapterCapabilityError("advisory inspection");
      }

      const inspected = await this.adapter.inspectMany(
        missing.map(({ request }) => request),
      );

      if (inspected.length !== missing.length) {
        throw new TypeError(
          "The throttling adapter returned an incomplete inspection.",
        );
      }

      missing.forEach(({ index }, inspectedIndex) => {
        results[index] = inspected[inspectedIndex]!;
      });
    }

    return results;
  }

  public prune(options: RateLimitPruneOptions): Promise<number> {
    const prunable = this.adapter as Partial<PrunableRateLimitAdapter>;

    if (prunable.prune === undefined) {
      throw new ThrottlingAdapterCapabilityError("bounded pruning");
    }

    return prunable.prune(options);
  }

  public allocateLeases(
    ownerId: string,
    requests: readonly RateLimitLeaseRequest[],
    completedLeases: readonly RateLimitLeaseReturn[] = [],
  ): Promise<RateLimitLeaseBatchResult> {
    const leasable = this.adapter as Partial<LeasableRateLimitAdapter>;

    if (leasable.allocateLeases === undefined) {
      throw new ThrottlingAdapterCapabilityError("leased coordination");
    }

    return leasable.allocateLeases(ownerId, requests, completedLeases);
  }

  public returnLeases(leases: readonly RateLimitLeaseReturn[]): Promise<number> {
    const leasable = this.adapter as Partial<LeasableRateLimitAdapter>;

    if (leasable.returnLeases === undefined) {
      throw new ThrottlingAdapterCapabilityError("leased coordination");
    }

    return leasable.returnLeases(leases);
  }

  public close(): Promise<void> {
    return this.adapter.close?.() ?? Promise.resolve();
  }

  private cacheSingleDenial(
    request: RateLimitReservationRequest,
    result: Extract<RateLimitReservationResult, { admitted: false }>,
  ): void {
    const expiresAtMs = this.getExpiration(result.retryAt);

    if (expiresAtMs === undefined) return;
    this.makeSpace();
    this.singleDenials.set(request.key, {
      expiresAtMs,
      remaining: result.remaining,
      retryAt: result.retryAt,
      signature: requestSignature(request),
    });
  }

  private cacheBatchDenial(
    signature: string,
    result: Extract<RateLimitBatchReservationResult, { admitted: false }>,
  ): void {
    const expiresAtMs = this.getExpiration(result.retryAt);

    if (expiresAtMs === undefined) return;
    this.makeSpace();
    this.batchDenials.set(signature, {
      expiresAtMs,
      remaining: result.remaining,
      retryAt: result.retryAt,
    });
  }

  private getSingleDenial(
    request: RateLimitReservationRequest,
  ): SingleDenial | undefined {
    const cached = this.singleDenials.get(request.key);

    if (
      cached !== undefined
      && cached.signature === requestSignature(request)
      && cached.expiresAtMs > this.getMonotonicNow()
    ) {
      return cached;
    }

    this.singleDenials.delete(request.key);
    return undefined;
  }

  private getBatchDenial(signature: string): BatchDenial | undefined {
    const cached = this.batchDenials.get(signature);

    if (cached !== undefined && cached.expiresAtMs > this.getMonotonicNow()) {
      return cached;
    }

    this.batchDenials.delete(signature);
    return undefined;
  }

  private getExpiration(retryAt: Date): number | undefined {
    const waitMs = retryAt.getTime() - this.getNowMs();

    return Number.isFinite(waitMs) && waitMs > 0
      ? this.getMonotonicNow() + waitMs
      : undefined;
  }

  private getNowMs(): number {
    const value = this.now().getTime();

    if (!Number.isFinite(value)) {
      throw new TypeError("The denial cache clock returned an invalid date.");
    }

    return value;
  }

  private getMonotonicNow(): number {
    const value = this.monotonicNow();

    if (!Number.isFinite(value)) {
      throw new TypeError("The denial cache monotonic clock must be finite.");
    }

    return value;
  }

  private makeSpace(): void {
    if (this.singleDenials.size + this.batchDenials.size < this.maxEntries) {
      return;
    }

    const now = this.getMonotonicNow();

    for (const [key, entry] of this.singleDenials) {
      if (entry.expiresAtMs <= now) this.singleDenials.delete(key);
    }

    for (const [key, entry] of this.batchDenials) {
      if (entry.expiresAtMs <= now) this.batchDenials.delete(key);
    }

    if (this.singleDenials.size + this.batchDenials.size < this.maxEntries) {
      return;
    }

    const oldestSingle = this.singleDenials.keys().next().value as
      | string
      | undefined;

    if (oldestSingle !== undefined) {
      this.singleDenials.delete(oldestSingle);
    } else {
      const oldestBatch = this.batchDenials.keys().next().value as
        | string
        | undefined;

      if (oldestBatch !== undefined) this.batchDenials.delete(oldestBatch);
    }
  }

  private async serialize<Value>(
    key: string,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const predecessor = this.serialization.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => lock);

    this.serialization.set(key, tail);
    await predecessor;

    try {
      return await operation();
    } finally {
      release();

      if (this.serialization.get(key) === tail) {
        this.serialization.delete(key);
      }
    }
  }
}

function requestSignature(request: RateLimitReservationRequest): string {
  return [request.limit, request.periodMs, request.burst, request.cost].join(":");
}

function batchSignature(
  requests: readonly RateLimitReservationRequest[],
): string {
  return [...requests]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((request) => `${request.key}:${requestSignature(request)}`)
    .join("|");
}
