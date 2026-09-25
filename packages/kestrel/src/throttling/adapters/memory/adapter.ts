import type {
  RateLimitAdapter,
  RateLimitBatchReservationResult,
  RateLimitInspectionResult,
  RateLimitReconciliationRequest,
  RateLimitReservationRequest,
  RateLimitReservationResult,
} from "../../types.js";

interface TokenBucketState {
  tokens: number;
  refilledAtMs: number;
}

export interface MemoryRateLimitAdapterOptions {
  readonly now?: () => Date;
}

/** Process-local token buckets with atomic in-process batch operations. */
export class MemoryRateLimitAdapter implements RateLimitAdapter {
  private readonly buckets = new Map<string, TokenBucketState>();

  private readonly now: () => Date;

  public constructor(options: MemoryRateLimitAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
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
        }
      : {
          admitted: false,
          remaining,
          retryAt: result.retryAt!,
        };
  }

  /** Commits every requested bucket only when the complete batch fits. */
  public async reserveMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<RateLimitBatchReservationResult> {
    validateRequests(requests);
    const nowMs = this.getNowMs();
    const candidates = requests.map((request) => {
      const state = this.readState(request, nowMs);
      return { request, state };
    });
    const rejected = candidates.filter(
      ({ request, state }) =>
        state.tokens + Number.EPSILON < request.cost,
    );

    if (rejected.length > 0) {
      const retryAtMs = Math.max(...rejected.map(({ request, state }) =>
        state.refilledAtMs + calculateWaitMs(request, state.tokens)));

      return {
        admitted: false,
        remaining: Object.fromEntries(candidates.map(({ request, state }) =>
          [request.key, state.tokens])),
        retryAt: new Date(retryAtMs),
        source: "local",
      };
    }

    const remaining: Record<string, number> = {};

    for (const { request, state } of candidates) {
      const tokens = Math.max(0, state.tokens - request.cost);
      this.buckets.set(request.key, {
        tokens,
        refilledAtMs: state.refilledAtMs,
      });
      remaining[request.key] = tokens;
    }

    return { admitted: true, remaining, source: "local" };
  }

  /** Applies actual-minus-estimated deltas atomically, including rate debt. */
  public async reconcile(
    requests: readonly RateLimitReconciliationRequest[],
  ): Promise<Readonly<Record<string, number>>> {
    validateReconciliationRequests(requests);
    const nowMs = this.getNowMs();
    const states = requests.map((request) => ({
      request,
      state: this.readState(request, nowMs),
    }));
    const remaining: Record<string, number> = {};

    for (const { request, state } of states) {
      const delta = request.actualCost - request.estimatedCost;
      const tokens = Math.min(request.burst, state.tokens - delta);

      this.buckets.set(request.key, {
        tokens,
        refilledAtMs: state.refilledAtMs,
      });
      remaining[request.key] = tokens;
    }

    return remaining;
  }

  /** Calculates availability without creating or updating bucket state. */
  public async inspectMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<readonly RateLimitInspectionResult[]> {
    validateRequests(requests);
    const nowMs = this.getNowMs();

    return requests.map((request) => {
      const state = this.readState(request, nowMs);

      if (state.tokens + Number.EPSILON >= request.cost) {
        return {
          available: true,
          remaining: state.tokens,
          source: "local" as const,
        };
      }

      return {
        available: false,
        remaining: state.tokens,
        retryAt: new Date(
          state.refilledAtMs + calculateWaitMs(request, state.tokens),
        ),
        source: "local" as const,
      };
    });
  }

  private readState(
    request: RateLimitReservationRequest,
    nowMs: number,
  ): TokenBucketState {
    const existing = this.buckets.get(request.key) ?? {
      tokens: request.burst,
      refilledAtMs: nowMs,
    };
    const elapsedMs = Math.max(0, nowMs - existing.refilledAtMs);

    return {
      tokens: Math.min(
        request.burst,
        existing.tokens + (elapsedMs * request.limit / request.periodMs),
      ),
      refilledAtMs: Math.max(existing.refilledAtMs, nowMs),
    };
  }

  private getNowMs(): number {
    const value = this.now().getTime();

    if (!Number.isFinite(value)) {
      throw new TypeError("The throttling clock returned an invalid date.");
    }

    return value;
  }
}

function calculateWaitMs(
  request: RateLimitReservationRequest,
  remaining: number,
): number {
  return Math.max(
    1,
    Math.ceil(
      ((request.cost - remaining) * request.periodMs) / request.limit,
    ),
  );
}

function validateRequests(
  requests: readonly RateLimitReservationRequest[],
): void {
  const keys = new Set<string>();

  for (const request of requests) {
    validateRequest(request);

    if (keys.has(request.key)) {
      throw new TypeError(`Rate limit adapter key "${request.key}" is duplicated.`);
    }

    keys.add(request.key);
  }
}

function validateReconciliationRequests(
  requests: readonly RateLimitReconciliationRequest[],
): void {
  validateRequests(requests);

  for (const request of requests) {
    for (const [name, value] of [
      ["actualCost", request.actualCost],
      ["estimatedCost", request.estimatedCost],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative finite number.`);
      }
    }
  }
}

function validateRequest(request: RateLimitReservationRequest): void {
  if (request.key.length === 0) {
    throw new TypeError("Rate limit adapter keys cannot be empty.");
  }

  for (const [name, value] of [
    ["limit", request.limit],
    ["periodMs", request.periodMs],
    ["burst", request.burst],
    ["cost", request.cost],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number.`);
    }
  }

  if (request.cost > request.burst) {
    throw new TypeError("cost cannot exceed burst.");
  }
}
