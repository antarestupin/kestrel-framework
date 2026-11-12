import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThrottlingAdapterCapabilityError, ThrottlingBackendUnavailableError } from "../../errors.js";
import type {
  LeasableRateLimitAdapter,
  RateLimitLeaseBatchResult,
  RateLimitLeaseRequest,
  RateLimitReservationRequest,
} from "../../types.js";
import { LeasedRateLimitAdapter, type LeasedRateLimitAdapterOptions } from "./adapter.js";

const request = {
  key: "test:partner",
  limit: 100,
  periodMs: 60_000,
  burst: 100,
  cost: 1,
  coordination: {
    strategy: "leased",
    maxLeaseUnits: 10,
    leaseMs: 5_000,
    maxOutstandingUnits: 20,
    guardBandUnits: 5,
  },
} as const satisfies RateLimitLeaseRequest;

const owned = new Set<LeasedRateLimitAdapter>();

afterEach(async () => {
  const closing = [...owned].map((adapter) => adapter.close());
  owned.clear();
  await Promise.all(closing);
});

function createAdapter(
  backend: LeasableRateLimitAdapter,
  options?: LeasedRateLimitAdapterOptions,
): LeasedRateLimitAdapter {
  const adapter = new LeasedRateLimitAdapter(backend, options);
  owned.add(adapter);
  return adapter;
}

describe("LeasedRateLimitAdapter", () => {
  it("finishes in-flight allocation before returning unused capacity and closing its backend", async () => {
    const grant = Promise.withResolvers<RateLimitLeaseBatchResult>();
    const backend = {
      ...createAuthoritative(),
      allocateLeases: vi.fn(() => grant.promise),
      close: vi.fn(async () => {}),
    };
    const adapter = createAdapter(backend, { now: () => new Date(1_000), monotonicNow: () => 0 });
    const result = { admitted: true, allocations: {
      [request.key]: { mode: "lease", leaseId: "in-flight", expiresAt: new Date(6_000), units: 10, remaining: 90 },
    } } as const;
    const reserved = vi.fn();
    const rejected = vi.fn();
    const closed = vi.fn();
    try {
      void adapter.reserve(request).then(reserved, reserved);
      await setImmediate();
      expect(backend.allocateLeases).toHaveBeenCalledOnce();
      expect(reserved).not.toHaveBeenCalled();

      const closing = adapter.close();
      void closing.then(closed, closed);
      expect(adapter.close()).toBe(closing);
      void adapter.reserve(request).then(rejected, rejected);
      await setImmediate();
      // Observe admission and close while the lease is held without blocking the fixture.
      expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingBackendUnavailableError));
      expect(closed).not.toHaveBeenCalled();
      expect(backend.close).not.toHaveBeenCalled();

      grant.resolve(result);
      await setImmediate();
      expect(reserved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ admitted: true, remaining: 9 }));
      expect(closed).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(backend.returnLeases).toHaveBeenCalledExactlyOnceWith([{ key: request.key, leaseId: "in-flight", remaining: 9 }]);
      expect(backend.close).toHaveBeenCalledOnce();
      expect(backend.returnLeases).toHaveBeenCalledBefore(backend.close);
    } finally {
      grant.resolve(result);
    }
  });

  it("still returns existing capacity if an in-flight allocation fails during close", async () => {
    const entered = Promise.withResolvers<void>();
    const grant = Promise.withResolvers<RateLimitLeaseBatchResult>();
    const backend = { ...createAuthoritative(), close: vi.fn(async () => {}) };
    const adapter = createAdapter(backend);
    await adapter.reserve(request);
    vi.mocked(backend.allocateLeases).mockImplementationOnce(() => {
      entered.resolve();
      return grant.promise;
    });
    const failure = new Error("allocation failed");
    const reservation = expect(adapter.reserve({ ...request, key: "test:other" })).rejects.toBe(failure);
    await entered.promise;
    const closing = adapter.close();

    grant.reject(failure);
    await reservation;
    await closing;
    expect(backend.returnLeases).toHaveBeenCalledExactlyOnceWith([{ key: request.key, leaseId: "lease-1", remaining: 9 }]);
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("amortizes admissions over one authoritative block allocation", async () => {
    const authoritative = createAuthoritative();
    const record = vi.fn();
    const adapter = new LeasedRateLimitAdapter(authoritative, {
      ownerId: "worker-a",
      instrumentation: { record },
    });

    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
      remaining: 9,
      source: "leased",
    });
    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
      remaining: 8,
      source: "leased",
    });
    expect(authoritative.allocateLeases).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.map(([event]) => event.data.operation)).toEqual([
      "issue",
      "consume",
      "consume",
    ]);
  });

  it("coalesces concurrent replenishment for the same key", async () => {
    const authoritative = createAuthoritative();
    const adapter = new LeasedRateLimitAdapter(authoritative, {
      ownerId: "worker-a",
    });

    const results = await Promise.all([
      adapter.reserve(request),
      adapter.reserve(request),
      adapter.reserve(request),
    ]);

    expect(results.every((result) => result.admitted)).toBe(true);
    expect(authoritative.allocateLeases).toHaveBeenCalledTimes(1);
  });

  it("admits overlapping batches with reversed input order without deadlocking", async () => {
    const backend = createAuthoritative();
    const adapter = new LeasedRateLimitAdapter(backend);
    const second = { ...request, key: "test:second" };
    const forward = vi.fn();
    const reverse = vi.fn();

    try {
      void adapter.reserveMany([request, second]).then(forward, forward);
      void adapter.reserveMany([second, request]).then(reverse, reverse);
      await setImmediate();

      // Both requests must settle even though they name the same keys in opposite order.
      expect(forward).toHaveBeenCalledExactlyOnceWith({
        admitted: true, remaining: { [request.key]: 9, [second.key]: 9 }, source: "leased",
      });
      expect(reverse).toHaveBeenCalledExactlyOnceWith({
        admitted: true, remaining: { [request.key]: 8, [second.key]: 8 }, source: "leased",
      });
      expect(backend.allocateLeases).toHaveBeenCalledOnce();
    } finally {
      // Under a lock-order regression, pending promises own no external resources.
      const closing = adapter.close();
      if (forward.mock.calls.length > 0 && reverse.mock.calls.length > 0) await closing;
      else void closing.catch(() => undefined);
    }
  });

  it("does not partially consume an existing dimension when a batch is rejected", async () => {
    const authoritative = createAuthoritative();
    const adapter = new LeasedRateLimitAdapter(authoritative, {
      ownerId: "worker-a",
      random: () => 0,
    });
    await adapter.reserve(request);
    vi.mocked(authoritative.allocateLeases).mockResolvedValueOnce({
      admitted: false,
      remaining: { "test:other": 0 },
      retryAt: new Date(Date.now() + 1_000),
    });

    await expect(adapter.reserveMany([
      request,
      { ...request, key: "test:other" },
    ])).resolves.toMatchObject({ admitted: false });
    await expect(adapter.reserve({ ...request, cost: 9 })).resolves.toMatchObject({
      admitted: true,
      remaining: 0,
    });
  });

  it("does not spend any local dimension when a warm lease expires during replenishment", async () => {
    let elapsed = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const backend = createAuthoritative(() => new Date(6_000 + elapsed));
    const adapter = createAdapter(backend, { now: () => new Date(1_000 + elapsed), monotonicNow: () => elapsed });
    const valid = { ...request, key: "test:valid" };
    const missing = { ...request, key: "test:missing" };
    const exact = { ...request, key: "test:exact" };

    await adapter.reserve(request);
    elapsed = 1_000;
    await adapter.reserve(valid);
    elapsed = 4_999;
    vi.mocked(backend.allocateLeases).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { admitted: true, allocations: {
        [missing.key]: { mode: "lease", leaseId: "new", units: 10, expiresAt: new Date(6_000 + elapsed), remaining: 90 },
        [exact.key]: { mode: "exact", remaining: 90 },
      } };
    });
    const reservation = adapter.reserveMany([valid, request, missing, exact]);
    await entered.promise;
    elapsed = 5_000;
    release.resolve();

    // One fresh timestamp governs the whole commit, before any local dimension is spent.
    await expect(reservation).rejects.toBeInstanceOf(ThrottlingBackendUnavailableError);
    await expect(adapter.inspectMany([valid, missing])).resolves.toEqual([
      { available: true, remaining: 9, source: "leased" },
      { available: true, remaining: 10, source: "leased" },
    ]);
    expect(backend.allocateLeases).toHaveBeenCalledTimes(3);
    expect(backend.returnLeases).not.toHaveBeenCalled();
  });

  it("invalidates expired local capacity without returning it", async () => {
    let elapsedMs = 0;
    const authoritative = createAuthoritative(() =>
      new Date(1_000 + elapsedMs + 5_000));
    const adapter = new LeasedRateLimitAdapter(authoritative, {
      ownerId: "worker-a",
      now: () => new Date(1_000 + elapsedMs),
      monotonicNow: () => elapsedMs,
    });

    await adapter.reserve(request);
    elapsedMs = 5_001;
    await adapter.reserve(request);

    expect(authoritative.allocateLeases).toHaveBeenCalledTimes(2);
    expect(authoritative.returnLeases).not.toHaveBeenCalled();
  });

  it("returns unexpired unused capacity during graceful close", async () => {
    const authoritative = createAuthoritative();
    const adapter = new LeasedRateLimitAdapter(authoritative, {
      ownerId: "worker-a",
    });
    await adapter.reserve(request);

    await adapter.close();
    await adapter.close();

    expect(authoritative.returnLeases).toHaveBeenCalledTimes(1);
    expect(authoritative.returnLeases).toHaveBeenCalledWith([expect.objectContaining({
      key: request.key,
      remaining: 9,
    })]);
    await expect(adapter.reserve(request)).rejects.toMatchObject({
      name: "ThrottlingBackendUnavailableError",
    });
  });

  it("rejects mixed coordination and forwards exact reservations without allocating a lease", async () => {
    const backend = createAuthoritative();
    const adapter = createAdapter(backend);
    const { coordination: _coordination, ...exact } = request;
    const second = { ...exact, key: "test:second" };
    const retryAt = new Date(2_000);
    vi.mocked(backend.reserve).mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt });

    await expect(adapter.reserveMany([])).resolves.toEqual({ admitted: true, remaining: {}, source: "leased" });
    expect(() => adapter.reserveMany([request, second])).toThrow("cannot mix exact and leased");
    expect(() => adapter.reserveMany([exact, second])).toThrow(ThrottlingAdapterCapabilityError);
    await expect(adapter.reserve(exact)).resolves.toEqual({ admitted: false, remaining: 0, retryAt });
    expect(backend.reserve).toHaveBeenCalledExactlyOnceWith(exact);
    expect(backend.allocateLeases).not.toHaveBeenCalled();
  });

  it("preserves backend-owned operations and pruning capability through the decorator", async () => {
    const backend = {
      ...createAuthoritative(),
      reserveMany: vi.fn(async () => ({ admitted: true as const, remaining: { first: 2, second: 3 } })),
      prune: vi.fn(async () => 2),
    };
    const adapter = createAdapter(backend);
    const { coordination: _coordination, ...exact } = request;
    const exactBatch: RateLimitReservationRequest[] = [{ ...exact, key: "first" }, { ...exact, key: "second" }];
    const completed = [{ key: request.key, leaseId: "completed", remaining: 0 }];

    await expect(adapter.reserveMany(exactBatch)).resolves.toEqual({ admitted: true, remaining: { first: 2, second: 3 } });
    expect(backend.reserveMany).toHaveBeenCalledExactlyOnceWith(exactBatch);
    await expect(adapter.allocateLeases("external-owner", [request])).resolves.toMatchObject({ admitted: true });
    expect(backend.allocateLeases).toHaveBeenCalledExactlyOnceWith("external-owner", [request], []);
    await expect(adapter.returnLeases(completed)).resolves.toBe(1);
    expect(backend.returnLeases).toHaveBeenCalledExactlyOnceWith(completed);
    await expect(adapter.prune?.({ limit: 10 })).resolves.toBe(2);
    expect(backend.prune).toHaveBeenCalledExactlyOnceWith({ limit: 10 });
    expect(backend.prune.mock.contexts[0]).toBe(backend);
  });

  it("replenishes a partial block without discarding its capacity and retires completed blocks", async () => {
    const backend = createAuthoritative();
    const adapter = createAdapter(backend, { ownerId: "worker-a" });

    await expect(adapter.reserve({ ...request, cost: 9 })).resolves.toMatchObject({ remaining: 1 });
    // The next admission spans the last unit of the old block and two units of the new block.
    await expect(adapter.reserve({ ...request, cost: 3 })).resolves.toMatchObject({ remaining: 8 });
    await expect(adapter.reserve({ ...request, cost: 9 })).resolves.toMatchObject({ remaining: 9 });
    expect(backend.allocateLeases).toHaveBeenNthCalledWith(3, "worker-a", [{ ...request, cost: 9 }], [
      { key: request.key, leaseId: "lease-1", remaining: 0 },
    ]);
    await adapter.close();
    expect(backend.returnLeases).toHaveBeenCalledExactlyOnceWith([
      { key: request.key, leaseId: "lease-2", remaining: 0 },
      { key: request.key, leaseId: "lease-3", remaining: 9 },
    ]);
  });

  it("reports exact emergency fallback without treating it as reusable local capacity", async () => {
    const backend = createAuthoritative();
    const record = vi.fn();
    const adapter = createAdapter(backend, { instrumentation: { record } });
    vi.mocked(backend.allocateLeases).mockResolvedValueOnce({
      admitted: true,
      allocations: { [request.key]: { mode: "exact", remaining: 4 } },
      source: "emergency-local",
    });

    await expect(adapter.reserve(request)).resolves.toEqual({ admitted: true, remaining: 4, source: "emergency-local" });
    expect(record).toHaveBeenCalledExactlyOnceWith({
      type: "lease", durationMs: 0, outcome: "success",
      data: { key: request.key, operation: "exact-fallback", units: 1, remaining: 4 },
    });
    await expect(adapter.reserve(request)).resolves.toMatchObject({ remaining: 9, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledTimes(2);
  });

  it("caches jittered denials until their deadline and evicts the oldest entry at capacity", async () => {
    const backend = createAuthoritative();
    const record = vi.fn();
    let elapsed = 0;
    const adapter = createAdapter(backend, {
      now: () => new Date(1_000 + elapsed), monotonicNow: () => elapsed,
      maxCachedDenials: 1, retryJitterRatio: 0.25, random: () => 0.5,
      instrumentation: { record },
    });
    const other = { ...request, key: "test:other" };
    vi.mocked(backend.allocateLeases).mockResolvedValue({ admitted: false, remaining: {}, retryAt: new Date(1_800) });

    const denied = { admitted: false, remaining: 0, retryAt: new Date(1_900), source: "leased" };
    await expect(adapter.reserve(request)).resolves.toEqual(denied);
    await expect(adapter.reserve(request)).resolves.toEqual(denied);
    expect(backend.allocateLeases).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledExactlyOnceWith({
      type: "lease", durationMs: 0, outcome: "failure",
      data: { key: request.key, operation: "reject", units: 1, remaining: 0 },
    });

    await adapter.reserve(other);
    await expect(adapter.reserve(request)).resolves.toEqual(denied);
    expect(backend.allocateLeases).toHaveBeenCalledTimes(3);
    // The inclusive boundary admits a fresh backend attempt.
    elapsed = 900;
    vi.mocked(backend.allocateLeases).mockResolvedValueOnce({ admitted: true, allocations: { [request.key]: { mode: "exact", remaining: 1 } } });
    await expect(adapter.reserve(request)).resolves.toEqual({ admitted: true, remaining: 1, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledTimes(4);
  });

  it("isolates denial cache entries for batches whose keys contain separators", async () => {
    const backend = createAuthoritative(() => new Date(6_000));
    const adapter = createAdapter(backend, { now: () => new Date(1_000), monotonicNow: () => 0, random: () => 0 });
    const a = { ...request, key: "a" };
    const b = { ...request, key: "b" };
    const c = { ...request, key: "c" };
    const combined = { ...request, key: "a:100:60000:100:1:10:5000:20:5|b" };
    vi.mocked(backend.allocateLeases).mockResolvedValueOnce({ admitted: false, remaining: { a: 0 }, retryAt: new Date(2_000) });

    // Delimiter concatenation made these distinct batches share the same signature.
    await expect(adapter.reserveMany([a, b, c])).resolves.toMatchObject({ admitted: false });
    await expect(adapter.reserveMany([c, b, a])).resolves.toMatchObject({ admitted: false });
    expect(backend.allocateLeases).toHaveBeenCalledTimes(1);
    await expect(adapter.reserveMany([combined, c])).resolves.toEqual({
      admitted: true, remaining: { [combined.key]: 9, c: 9 }, source: "leased",
    });
    expect(backend.allocateLeases).toHaveBeenCalledTimes(2);
  });

  it("rejects incomplete and expired grants without recording a local admission", async () => {
    const backend = createAuthoritative();
    const record = vi.fn();
    const adapter = createAdapter(backend, { now: () => new Date(1_000), monotonicNow: () => 0, instrumentation: { record } });
    vi.mocked(backend.allocateLeases)
      .mockResolvedValueOnce({ admitted: true, allocations: {} })
      .mockResolvedValueOnce({ admitted: true, allocations: {
        [request.key]: { mode: "lease", leaseId: "expired", expiresAt: new Date(1_000), units: 10, remaining: 90 },
      } });

    await expect(adapter.reserve(request)).rejects.toThrow("incomplete allocation");
    await expect(adapter.reserve(request)).rejects.toBeInstanceOf(ThrottlingBackendUnavailableError);
    expect(record).not.toHaveBeenCalled();
    await adapter.close();
    expect(backend.returnLeases).not.toHaveBeenCalled();
  });

  it.each([
    [{ ownerId: " " }, "owner id cannot be empty"],
    [{ retryJitterRatio: -0.01 }, "retryJitterRatio must be between zero and one"],
    [{ retryJitterRatio: 1.01 }, "retryJitterRatio must be between zero and one"],
    [{ retryJitterRatio: Number.NaN }, "retryJitterRatio must be between zero and one"],
    [{ maxCachedDenials: 0 }, "maxCachedDenials must be a positive integer"],
  ] as const)("validates its options before accessing the backend (%j)", (options, message) => {
    const backend = createAuthoritative();
    expect(() => new LeasedRateLimitAdapter(backend, options)).toThrow(message);
    expect(backend.allocateLeases).not.toHaveBeenCalled();
  });

  it("validates clock and jitter sources without caching an invalid denial", async () => {
    const backend = createAuthoritative();
    const now = vi.fn(() => new Date(1_000));
    const monotonicNow = vi.fn(() => 0);
    const random = vi.fn(() => 0);
    const adapter = createAdapter(backend, { now, monotonicNow, random });
    const denial = { admitted: false, remaining: { [request.key]: 0 }, retryAt: new Date(2_000) } as const;
    vi.mocked(backend.allocateLeases).mockResolvedValue(denial);

    monotonicNow.mockReturnValueOnce(Number.NaN);
    await expect(adapter.reserve(request)).rejects.toThrow("monotonic clock must be finite");
    expect(backend.allocateLeases).not.toHaveBeenCalled();
    now.mockReturnValueOnce(new Date(Number.NaN));
    await expect(adapter.reserve(request)).rejects.toThrow("clock returned an invalid date");
    random.mockReturnValueOnce(2);
    await expect(adapter.reserve(request)).rejects.toThrow("random source must return [0, 1]");
    await expect(adapter.reserve(request)).resolves.toEqual({ admitted: false, remaining: 0, retryAt: denial.retryAt, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledTimes(3);
  });

  it("skips expired lease returns during close and closes a temporarily unavailable backend", async () => {
    let elapsed = 0;
    const backend = { ...createAuthoritative(() => new Date(6_000 + elapsed)), close: vi.fn(async () => {}) };
    const adapter = createAdapter(backend, { now: () => new Date(1_000 + elapsed), monotonicNow: () => elapsed });
    const live = { ...request, key: "test:live" };
    await adapter.reserve(request);
    elapsed = 5_000;
    await adapter.reserve(live);
    vi.mocked(backend.returnLeases).mockRejectedValueOnce(new ThrottlingBackendUnavailableError({ cause: new Error("offline") }));

    await expect(adapter.close()).resolves.toBeUndefined();
    expect(backend.returnLeases).toHaveBeenCalledExactlyOnceWith([{ key: live.key, leaseId: "lease-2", remaining: 9 }]);
    expect(backend.close).toHaveBeenCalledOnce();
  });
});

function createAuthoritative(
  expiresAt: () => Date = () => new Date(Date.now() + 60_000),
): LeasableRateLimitAdapter {
  let lease = 0;

  return {
    reserve: vi.fn(async () => ({
      admitted: true as const,
      remaining: 0,
      source: "authoritative" as const,
    })),
    allocateLeases: vi.fn(async (
      _ownerId: string,
      requests: readonly RateLimitLeaseRequest[],
    ) => ({
      admitted: true as const,
      allocations: Object.fromEntries(requests.map((current) => [
        current.key,
        {
          mode: "lease" as const,
          leaseId: `lease-${lease += 1}`,
          units: current.coordination.maxLeaseUnits,
          expiresAt: expiresAt(),
          remaining: current.burst - current.coordination.maxLeaseUnits,
        },
      ])),
    })),
    returnLeases: vi.fn(async (leases) => leases.length),
  };
}
