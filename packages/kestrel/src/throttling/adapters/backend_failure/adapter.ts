import {
  ThrottlingAdapterCapabilityError,
  ThrottlingBackendUnavailableError,
  ThrottlingCostExceedsBurstError,
} from "../../errors.js";
import type {
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter,
  RateLimitBatchReservationResult,
  RateLimitInspectionResult,
  RateLimitLeaseBatchResult,
  RateLimitLeaseRequest,
  RateLimitLeaseReturn,
  RateLimitPruneOptions,
  RateLimitReconciliationRequest,
  RateLimitReservationRequest,
  RateLimitReservationResult,
  ThrottlingBackendFailurePolicy,
} from "../../types.js";
import { MemoryRateLimitAdapter } from "../memory/index.js";

export interface BackendFailureRateLimitAdapterOptions {
  readonly fallback?: MemoryRateLimitAdapter;
}

/** Applies an explicit bounded policy when authoritative storage fails. */
export class BackendFailureRateLimitAdapter implements
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter {
  private readonly fallback: MemoryRateLimitAdapter;

  public constructor(
    private readonly authoritative: PrunableRateLimitAdapter,
    private readonly policy: ThrottlingBackendFailurePolicy,
    options: BackendFailureRateLimitAdapterOptions = {},
  ) {
    validatePolicy(policy);
    this.fallback = options.fallback ?? new MemoryRateLimitAdapter();
  }

  public async reserve(
    request: RateLimitReservationRequest,
  ): Promise<RateLimitReservationResult> {
    try {
      return await this.authoritative.reserve(request);
    } catch (error) {
      if (!(error instanceof ThrottlingBackendUnavailableError)) throw error;
      if (this.policy.strategy === "reject") throw error;

      this.assertFallbackFits(request);
      const result = await this.fallback.reserve(
        this.createFallbackRequest(request),
      );

      return { ...result, source: "emergency-local" };
    }
  }

  public async reserveMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<RateLimitBatchReservationResult> {
    try {
      if (this.authoritative.reserveMany === undefined) {
        throw new ThrottlingAdapterCapabilityError("atomic batch reservation");
      }

      return await this.authoritative.reserveMany(requests);
    } catch (error) {
      if (!(error instanceof ThrottlingBackendUnavailableError)) throw error;
      if (this.policy.strategy === "reject") throw error;

      for (const request of requests) this.assertFallbackFits(request);
      const fallbackRequests = requests.map((request) =>
        this.createFallbackRequest(request));
      const result = await this.fallback.reserveMany(fallbackRequests);

      return {
        ...result,
        remaining: Object.fromEntries(requests.map((request) => [
          request.key,
          result.remaining[`emergency:${request.key}`] ?? 0,
        ])),
        source: "emergency-local",
      };
    }
  }

  public async reconcile(
    requests: readonly RateLimitReconciliationRequest[],
  ): Promise<Readonly<Record<string, number>>> {
    const emergency = requests.filter(
      (request) => request.reservationSource === "emergency-local",
    );
    const authoritative = requests.filter(
      (request) => request.reservationSource !== "emergency-local",
    );
    const remaining: Record<string, number> = {};

    if (authoritative.length > 0) {
      if (this.authoritative.reconcile === undefined) {
        throw new ThrottlingAdapterCapabilityError("cost reconciliation");
      }

      Object.assign(
        remaining,
        await this.authoritative.reconcile(authoritative),
      );
    }

    if (emergency.length > 0) {
      const fallbackRequests = emergency.map((request) => ({
        ...this.createFallbackRequest(request),
        actualCost: request.actualCost,
        estimatedCost: request.estimatedCost,
        ...(request.reservationSource === undefined
          ? {}
          : { reservationSource: request.reservationSource }),
      }));
      const reconciled = await this.fallback.reconcile(fallbackRequests);

      for (const request of emergency) {
        remaining[request.key] = reconciled[`emergency:${request.key}`] ?? 0;
      }
    }

    return remaining;
  }

  public async inspectMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<readonly RateLimitInspectionResult[]> {
    try {
      if (this.authoritative.inspectMany === undefined) {
        throw new ThrottlingAdapterCapabilityError("advisory inspection");
      }

      return await this.authoritative.inspectMany(requests);
    } catch (error) {
      if (!(error instanceof ThrottlingBackendUnavailableError)) throw error;
      if (this.policy.strategy === "reject") throw error;

      return Promise.all(requests.map(async (request) => {
        if (
          this.policy.strategy === "emergency-local"
          && request.cost > this.policy.capacity
        ) {
          return {
            available: false,
            remaining: this.policy.capacity,
            source: "emergency-local" as const,
          };
        }

        const [result] = await this.fallback.inspectMany([
          this.createFallbackRequest(request),
        ]);

        return { ...result!, source: "emergency-local" as const };
      }));
    }
  }

  public async allocateLeases(
    ownerId: string,
    requests: readonly RateLimitLeaseRequest[],
    completedLeases: readonly RateLimitLeaseReturn[] = [],
  ): Promise<RateLimitLeaseBatchResult> {
    const leasable = this.authoritative as Partial<LeasableRateLimitAdapter>;

    if (leasable.allocateLeases === undefined) {
      throw new ThrottlingAdapterCapabilityError("leased coordination");
    }

    try {
      return await leasable.allocateLeases(
        ownerId,
        requests,
        completedLeases,
      );
    } catch (error) {
      if (!(error instanceof ThrottlingBackendUnavailableError)) throw error;
      if (this.policy.strategy === "reject") throw error;

      for (const request of requests) this.assertFallbackFits(request);
      const fallbackRequests = requests.map((request) =>
        this.createFallbackRequest(request));
      const result = await this.fallback.reserveMany(fallbackRequests);

      if (!result.admitted) {
        return {
          admitted: false,
          remaining: Object.fromEntries(requests.map((request) => [
            request.key,
            result.remaining[`emergency:${request.key}`] ?? 0,
          ])),
          retryAt: result.retryAt,
          source: "emergency-local",
        };
      }

      return {
        admitted: true,
        allocations: Object.fromEntries(requests.map((request) => [
          request.key,
          {
            mode: "exact" as const,
            remaining: result.remaining[`emergency:${request.key}`] ?? 0,
          },
        ])),
        source: "emergency-local",
      };
    }
  }

  public returnLeases(leases: readonly RateLimitLeaseReturn[]): Promise<number> {
    const leasable = this.authoritative as Partial<LeasableRateLimitAdapter>;

    if (leasable.returnLeases === undefined) {
      throw new ThrottlingAdapterCapabilityError("leased coordination");
    }

    return leasable.returnLeases(leases);
  }

  public close(): Promise<void> {
    return this.authoritative.close?.() ?? Promise.resolve();
  }

  /** Maintenance remains authoritative and never silently degrades. */
  public prune(options: RateLimitPruneOptions): Promise<number> {
    return this.authoritative.prune(options);
  }

  private createFallbackRequest(
    request: RateLimitReservationRequest,
  ): RateLimitReservationRequest {
    if (this.policy.strategy !== "emergency-local") {
      throw new TypeError("Emergency throttling is not configured.");
    }

    return {
      ...request,
      key: `emergency:${request.key}`,
      limit: this.policy.capacity,
      periodMs: this.policy.periodMs,
      burst: this.policy.capacity,
    };
  }

  private assertFallbackFits(request: RateLimitReservationRequest): void {
    if (
      this.policy.strategy === "emergency-local"
      && request.cost > this.policy.capacity
    ) {
      throw new ThrottlingCostExceedsBurstError(
        request.key,
        request.cost,
        this.policy.capacity,
      );
    }
  }
}

function validatePolicy(policy: ThrottlingBackendFailurePolicy): void {
  if (policy.strategy === "reject") return;

  if (!Number.isFinite(policy.capacity) || policy.capacity < 1) {
    throw new TypeError("Emergency throttling capacity must be at least one.");
  }

  if (!Number.isFinite(policy.periodMs) || policy.periodMs <= 0) {
    throw new TypeError(
      "Emergency throttling periodMs must be positive and finite.",
    );
  }
}
