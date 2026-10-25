import type { RedisClientType } from "@redis/client";
import { z } from "zod";
import { uuidV7 } from "../../../utils/uuid.js";
import { ThrottlingBackendUnavailableError, ThrottlingDefinitionConflictError } from "../../errors.js";
import type {
  LeasableRateLimitAdapter, RateLimitBatchReservationResult, RateLimitInspectionResult,
  RateLimitLeaseBatchResult, RateLimitLeaseRequest, RateLimitLeaseReturn,
  RateLimitReconciliationRequest, RateLimitReservationRequest, RateLimitReservationResult,
} from "../../types.js";
import { redisThrottlingConfigBase, type RedisThrottlingConfig } from "./configuration.js";
import { rateLimitScript } from "./scripts.js";

const finite = z.union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/).transform(Number)]).pipe(z.number().finite());
const resultSchema = z.object({
  admitted: z.boolean(), remaining: z.record(z.string(), finite),
  retryDelayMs: finite.pipe(z.number().nonnegative()), returned: z.number().int().nonnegative(),
  serverNow: finite,
  allocations: z.record(z.string(), z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("exact"), remaining: finite }),
    z.object({ mode: z.literal("lease"), remaining: finite, leaseId: z.string(), units: finite.pipe(z.number().positive()), expiresAt: finite }),
  ])),
  // Lua encodes an empty table as an object; only inspection calls read this field.
  inspections: z.unknown(),
});

/** Atomic Redis token buckets, with optional block leasing and no pruning timer. */
export class RedisRateLimitAdapter implements LeasableRateLimitAdapter {
  private readonly prefix: string;

  public constructor(
    private readonly client: Pick<RedisClientType, "eval">,
    settings: RedisThrottlingConfig = redisThrottlingConfigBase.schema.parse({}),
  ) {
    if (!settings.keyPrefix) throw new TypeError("Redis throttling key prefixes cannot be empty.");
    this.prefix = `${settings.keyPrefix}{throttling}:`;
  }

  public async reserve(request: RateLimitReservationRequest): Promise<RateLimitReservationResult> {
    const result = await this.reserveMany([request]);
    return result.admitted
      ? { admitted: true, remaining: result.remaining[request.key]!, source: "authoritative" }
      : { admitted: false, remaining: result.remaining[request.key]!, retryAt: result.retryAt, source: "authoritative" };
  }

  public async reserveMany(requests: readonly RateLimitReservationRequest[]): Promise<RateLimitBatchReservationResult> {
    validateRequests(requests);
    if (!requests.length) return { admitted: true, remaining: {}, source: "authoritative" };
    const result = await this.execute("reserve", requests);
    return result.admitted
      ? { admitted: true, remaining: result.remaining, source: "authoritative" }
      : { admitted: false, remaining: result.remaining, retryAt: new Date(Date.now() + result.retryDelayMs), source: "authoritative" };
  }

  public async reconcile(requests: readonly RateLimitReconciliationRequest[]): Promise<Readonly<Record<string, number>>> {
    validateRequests(requests);
    for (const request of requests) {
      if (![request.actualCost, request.estimatedCost].every((value) => Number.isFinite(value) && value >= 0)) {
        throw new TypeError("Actual and estimated costs must be non-negative and finite.");
      }
      validateRefillDuration((request.burst + request.actualCost) / (request.limit / request.periodMs));
    }
    if (!requests.length) return {};
    return (await this.execute("reconcile", requests)).remaining;
  }

  public async inspectMany(requests: readonly RateLimitReservationRequest[]): Promise<readonly RateLimitInspectionResult[]> {
    validateRequests(requests);
    if (!requests.length) return [];
    const result = await this.execute("inspect", requests);
    const inspected = z.array(z.object({ available: z.boolean(), remaining: finite, retryDelayMs: finite })).length(requests.length).parse(result.inspections);
    return inspected.map((item) => ({
      available: item.available, remaining: item.remaining, source: "authoritative",
      ...(item.available ? {} : { retryAt: new Date(Date.now() + item.retryDelayMs) }),
    }));
  }

  public async allocateLeases(ownerId: string, requests: readonly RateLimitLeaseRequest[], completedLeases: readonly RateLimitLeaseReturn[] = []): Promise<RateLimitLeaseBatchResult> {
    validateRequests(requests);
    validateReturns(completedLeases);
    if (!ownerId.trim()) throw new TypeError("Lease owner IDs cannot be empty.");
    if (!requests.length) {
      await this.returnLeases(completedLeases);
      return { admitted: true, allocations: {} };
    }
    if (requests.some((request) => request.coordination.strategy !== "leased")
      || completedLeases.some((lease) => !requests.some((request) => request.key === lease.key))) {
      throw new TypeError("Lease allocation requires leased coordination and matching returned keys.");
    }
    const result = await this.execute("allocate", requests, completedLeases);
    return result.admitted ? {
      admitted: true,
      allocations: Object.fromEntries(Object.entries(result.allocations).map(([key, value]) => [key,
        // Subtract the complete round trip so clock skew cannot extend a server-owned lease.
        value.mode === "exact" ? value : { ...value, expiresAt: new Date(Date.now() + Math.max(0, value.expiresAt - result.serverNow - result.elapsedMs)) },
      ])),
    } : { admitted: false, remaining: result.remaining, retryAt: new Date(Date.now() + result.retryDelayMs) };
  }

  public async returnLeases(leases: readonly RateLimitLeaseReturn[]): Promise<number> {
    validateReturns(leases);
    if (!leases.length) return 0;
    const requests = [...new Set(leases.map((lease) => lease.key))].map((key) => ({ key }));
    return (await this.execute("return", requests, leases)).returned;
  }

  private async execute(mode: string, requests: readonly { readonly key: string }[], returns: readonly RateLimitLeaseReturn[] = []) {
    const payload = requests.map((value) => {
      if (!("limit" in value)) return value;
      const request = value as RateLimitReservationRequest & Partial<RateLimitReconciliationRequest>;
      return {
        ...request,
        signature: JSON.stringify([request.limit, request.periodMs, request.burst, request.coordination?.strategy === "leased"
          ? [request.coordination.maxLeaseUnits, request.coordination.leaseMs, request.coordination.maxOutstandingUnits, request.coordination.guardBandUnits] : "exact"]),
        delta: (request.actualCost ?? 0) - (request.estimatedCost ?? 0),
        leaseId: uuidV7(),
      };
    });
    let reply: unknown;
    const startedAt = performance.now();
    try {
      // Never retry an ambiguous mutation: the primary may already have applied it.
      reply = await this.client.eval(rateLimitScript, {
        keys: requests.map(({ key }) => this.prefix + Buffer.from(key).toString("base64url")),
        arguments: [mode, JSON.stringify(payload), JSON.stringify(returns)],
      });
    } catch (cause) {
      throw new ThrottlingBackendUnavailableError({ cause });
    }
    if (typeof reply !== "string") throw new TypeError("Invalid Redis throttling result.");
    const decoded: unknown = JSON.parse(reply);
    const conflict = z.object({ conflict: z.string() }).safeParse(decoded);
    if (conflict.success) throw new ThrottlingDefinitionConflictError(conflict.data.conflict);
    return { ...resultSchema.parse(decoded), elapsedMs: performance.now() - startedAt };
  }
}

/** Reject invalid arithmetic and duplicate dimensions before contacting Redis. */
function validateRequests(requests: readonly RateLimitReservationRequest[]): void {
  if (new Set(requests.map(({ key }) => key)).size !== requests.length) throw new TypeError("Rate limit keys must be unique.");
  for (const request of requests) {
    if (!request.key || ![request.limit, request.periodMs, request.burst, request.cost].every((value) => Number.isFinite(value) && value > 0)
      || request.cost > request.burst) throw new TypeError("Invalid rate limit request.");
    const refillRate = request.limit / request.periodMs;
    if (!Number.isFinite(refillRate) || refillRate <= 0) throw new TypeError("Rate limit refill rates must be representable.");
    validateRefillDuration(request.burst / refillRate);
    const coordination = request.coordination;
    if (coordination?.strategy === "leased" && (
      ![coordination.maxLeaseUnits, coordination.leaseMs, coordination.maxOutstandingUnits].every((value) => Number.isFinite(value) && value > 0)
      || !Number.isSafeInteger(coordination.leaseMs)
      || Date.now() + coordination.leaseMs > 8_640_000_000_000_000
      || !Number.isFinite(coordination.guardBandUnits) || coordination.guardBandUnits < 0
      || coordination.maxLeaseUnits > request.burst || coordination.maxOutstandingUnits < coordination.maxLeaseUnits
    )) throw new TypeError("Invalid rate limit lease settings.");
  }
}

/** Reject arithmetic that cannot be represented as a Redis/application deadline. */
function validateRefillDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0 || Date.now() + durationMs > 8_640_000_000_000_000) {
    throw new TypeError("Rate limit refill deadlines must be representable.");
  }
}

function validateReturns(leases: readonly RateLimitLeaseReturn[]): void {
  if (new Set(leases.map(({ leaseId }) => leaseId)).size !== leases.length
    || leases.some((lease) => !lease.key || !lease.leaseId || !Number.isFinite(lease.remaining) || lease.remaining < 0)) {
    throw new TypeError("Invalid or duplicate returned rate limit leases.");
  }
}
