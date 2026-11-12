import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThrottlingBackendUnavailableError, ThrottlingDefinitionConflictError } from "../../errors.js";
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

  it("preserves both grant-return and backend-close failures during teardown", async () => {
    const returnError = new Error("grant return failed");
    const closeError = new Error("backend close failed");
    const backend = { ...createAuthoritative(), close: vi.fn().mockRejectedValue(closeError) };
    vi.mocked(backend.returnLeases).mockRejectedValueOnce(returnError);
    const adapter = new LeasedRateLimitAdapter(backend);
    await adapter.reserve(request);

    const closing = adapter.close();
    expect(adapter.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({
      name: "AggregateError", message: "Leased throttling adapter teardown failed.", errors: [returnError, closeError],
    });
    expect(backend.returnLeases).toHaveBeenCalledBefore(backend.close);
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it.each(["return", "close"] as const)("propagates a lone %s failure during teardown", async (phase) => {
    const failure = new Error(`backend ${phase} failed`);
    const backend = { ...createAuthoritative(), close: vi.fn(async () => {}) };
    if (phase === "return") vi.mocked(backend.returnLeases).mockRejectedValueOnce(failure);
    else backend.close.mockRejectedValueOnce(failure);
    const adapter = new LeasedRateLimitAdapter(backend);
    await adapter.reserve(request);

    await expect(adapter.close()).rejects.toBe(failure);
    expect(backend.returnLeases).toHaveBeenCalledOnce();
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("uses earlier expirations first and reports issued, consumed, expired, and returned units", async () => {
    let elapsed = 0;
    const backend = createAuthoritative();
    const record = vi.fn();
    const adapter = createAdapter(backend, {
      now: () => new Date(1_000 + elapsed), monotonicNow: () => elapsed,
      instrumentation: { record },
    });
    const grant = (leaseId: string, expiresAt: number): RateLimitLeaseBatchResult => ({ admitted: true, allocations: {
      [request.key]: { mode: "lease", leaseId, expiresAt: new Date(expiresAt), units: 3, remaining: 97 },
    } });
    vi.mocked(backend.allocateLeases).mockResolvedValueOnce(grant("long", 2_000)).mockResolvedValueOnce(grant("short", 1_500));

    await expect(adapter.reserve({ ...request, cost: 2 })).resolves.toEqual({ admitted: true, remaining: 1, source: "leased" });
    await expect(adapter.reserve({ ...request, cost: 2 })).resolves.toEqual({ admitted: true, remaining: 2, source: "leased" });
    // The earlier grant expires at the exact boundary, leaving the later grant refundable.
    elapsed = 500;
    await expect(adapter.inspectMany([request])).resolves.toEqual([{ available: true, remaining: 1, source: "leased" }]);
    await adapter.close();
    expect(backend.returnLeases).toHaveBeenCalledExactlyOnceWith([{ key: request.key, leaseId: "long", remaining: 1 }]);
    expect(record.mock.calls.map(([event]) => event.data)).toEqual([
      { key: request.key, operation: "issue", units: 3, remaining: 3 },
      { key: request.key, operation: "consume", units: 2, remaining: 1 },
      { key: request.key, operation: "issue", units: 3, remaining: 3 },
      { key: request.key, operation: "consume", units: 2, remaining: 2 },
      { key: request.key, operation: "expire", units: 1 },
      { key: request.key, operation: "return", units: 1 },
    ]);
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

  it("refuses a different definition while a key still has a live local grant", async () => {
    const backend = createAuthoritative();
    const adapter = createAdapter(backend);
    const changed = { ...request, coordination: { ...request.coordination, guardBandUnits: 6 } };

    await adapter.reserve(request);
    await expect(adapter.inspectMany([changed])).rejects.toBeInstanceOf(ThrottlingDefinitionConflictError);
    await expect(adapter.reserve(changed)).rejects.toBeInstanceOf(ThrottlingDefinitionConflictError);
    await expect(adapter.reserve({ ...request, cost: 2 })).resolves.toEqual({ admitted: true, remaining: 7, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledOnce();
  });

  it("delegates a changed definition to storage after its last local grant expires", async () => {
    let elapsed = 0;
    const changed = { ...request, coordination: { ...request.coordination, guardBandUnits: 6 } };
    const backend = createAuthoritative();
    vi.mocked(backend.allocateLeases).mockResolvedValueOnce({ admitted: true, allocations: {
      [request.key]: { mode: "lease", leaseId: "retired", units: 10, remaining: 90, expiresAt: new Date(6_000) },
    } }).mockResolvedValueOnce({ admitted: true, allocations: { [request.key]: { mode: "exact", remaining: 90 } } });
    const adapter = createAdapter(backend, { now: () => new Date(1_000 + elapsed), monotonicNow: () => elapsed });
    await adapter.reserve(request);
    elapsed = 5_000;
    await expect(adapter.reserve(changed)).resolves.toEqual({ admitted: true, remaining: 90, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenLastCalledWith(expect.any(String), [changed], []);
  });

  it("rejects duplicate warm dimensions before spending any of their capacity", async () => {
    const backend = createAuthoritative();
    const adapter = createAdapter(backend);
    await expect(adapter.reserve({ ...request, cost: 9 })).resolves.toMatchObject({ admitted: true, remaining: 1 });

    await expect(Promise.resolve().then(() => adapter.reserveMany([request, request])))
      .rejects.toThrow("Rate limit keys must be unique");
    await expect(adapter.reserve(request)).resolves.toEqual({ admitted: true, remaining: 0, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledOnce();
  });

  it("rejects invalid warm costs before changing local capacity", async () => {
    const backend = createAuthoritative();
    const adapter = createAdapter(backend);
    await adapter.reserve(request);

    // Negative costs would add units and a non-finite cost can poison the retained grant.
    for (const cost of [-1, 0, NaN, Infinity, request.burst + 1]) {
      await expect(adapter.reserve({ ...request, cost })).rejects.toThrow("Leased reservation costs");
      await expect(adapter.inspectMany([{ ...request, cost }])).rejects.toThrow("Leased reservation costs");
    }
    await expect(adapter.reserve(request)).resolves.toEqual({ admitted: true, remaining: 8, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledOnce();
  });

  it("delegates a tiny positive cost when no local capacity remains", async () => {
    const cost = Number.EPSILON;
    const tiny = { ...request, cost, burst: cost * 4, coordination: {
      ...request.coordination, maxLeaseUnits: cost, maxOutstandingUnits: cost * 2, guardBandUnits: 0,
    } };
    const backend = createAuthoritative();
    const retryAt = new Date(2_000);
    vi.mocked(backend.allocateLeases).mockResolvedValueOnce({ admitted: true, allocations: {
      [tiny.key]: { mode: "lease", leaseId: "tiny", units: cost, remaining: cost * 3, expiresAt: new Date(6_000) },
    } }).mockResolvedValueOnce({ admitted: false, remaining: { [tiny.key]: 0 }, retryAt });
    const adapter = createAdapter(backend, { now: () => new Date(1_000), monotonicNow: () => 0, retryJitterRatio: 0 });

    await expect(adapter.reserve(tiny)).resolves.toEqual({ admitted: true, remaining: 0, source: "leased" });
    await expect(adapter.reserve(tiny)).resolves.toEqual({ admitted: false, remaining: 0, retryAt, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledTimes(2);
  });

  it("admits an exactly sized lease and returns fractional residue at the tolerance boundary", async () => {
    const backend = createAuthoritative();
    const deadline = new Date(6_000);
    vi.mocked(backend.allocateLeases).mockResolvedValueOnce({ admitted: true, allocations: {
      [request.key]: { mode: "lease", leaseId: "whole", units: 1, remaining: 99, expiresAt: deadline },
    } }).mockResolvedValueOnce({ admitted: true, allocations: {
      [request.key]: { mode: "lease", leaseId: "residue", units: 1 + Number.EPSILON, remaining: 98, expiresAt: deadline },
    } }).mockResolvedValueOnce({ admitted: true, allocations: {
      [request.key]: { mode: "exact", remaining: 97 },
    } });
    const adapter = createAdapter(backend, { now: () => new Date(1_000), monotonicNow: () => 0 });

    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: true, remaining: 0 });
    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: true, remaining: Number.EPSILON });
    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: true, remaining: 97 });
    expect(backend.allocateLeases).toHaveBeenLastCalledWith(expect.any(String), [request], [
      { key: request.key, leaseId: "residue", remaining: 0 },
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

  it("retains a pending successor's key lock when the earlier allocation settles", async () => {
    const first = Promise.withResolvers<RateLimitLeaseBatchResult>();
    const second = Promise.withResolvers<RateLimitLeaseBatchResult>();
    const backend = createAuthoritative();
    const result = { admitted: true, allocations: { [request.key]: { mode: "exact", remaining: 90 } } } as const;
    vi.mocked(backend.allocateLeases).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(result);
    const adapter = createAdapter(backend);
    try {
      void adapter.reserve(request).catch(() => undefined);
      void adapter.reserve(request).catch(() => undefined);
      await setImmediate();
      expect(backend.allocateLeases).toHaveBeenCalledTimes(1);

      first.resolve(result);
      await setImmediate();
      expect(backend.allocateLeases).toHaveBeenCalledTimes(2);

      const late = vi.fn();
      void adapter.reserve(request).then(late, late);
      await setImmediate();
      expect(backend.allocateLeases).toHaveBeenCalledTimes(2);
      expect(late).not.toHaveBeenCalled();

      second.resolve(result);
      await setImmediate();
      expect(backend.allocateLeases).toHaveBeenCalledTimes(3);
      expect(late).toHaveBeenCalledExactlyOnceWith({ admitted: true, remaining: 90, source: "leased" });
    } finally {
      first.resolve(result);
      second.resolve(result);
    }
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
    await expect(reservation).rejects.toMatchObject({
      name: "ThrottlingBackendUnavailableError", cause: new Error("A leased reservation lost local capacity during allocation."),
    });
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
      name: "ThrottlingBackendUnavailableError", cause: new Error("The leased throttling adapter is closed."),
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
    expect(() => adapter.reserveMany([exact, second])).toThrow("does not support atomic batch reservation");
    await expect(adapter.reserve(exact)).resolves.toStrictEqual({ admitted: false, remaining: 0, retryAt });
    await expect(adapter.reserve(exact)).resolves.toStrictEqual({ admitted: true, remaining: 0, source: "authoritative" });
    expect(vi.mocked(backend.reserve).mock.calls).toEqual([[exact], [exact]]);
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
    const exactBatch: RateLimitReservationRequest[] = [
      { ...exact, key: "first" },
      { ...exact, key: "second", coordination: { strategy: "exact" } },
    ];
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

  it("keeps cached lease denials independent of caller-owned amounts and dates", async () => {
    const backend = createAuthoritative();
    const adapter = createAdapter(backend, {
      now: () => new Date(1_000), monotonicNow: () => 0, retryJitterRatio: 0,
    });
    const other = { ...request, key: "test:other" };
    const remaining = { [request.key]: 0.25, [other.key]: 0.5 };
    vi.mocked(backend.allocateLeases).mockResolvedValue({
      admitted: false, remaining, retryAt: new Date(2_000),
    });

    const first = await adapter.reserveMany([request, other]);
    if (first.admitted) throw new Error("Expected an authoritative denial.");
    Object.assign(first.remaining, { [request.key]: 40 });
    first.retryAt.setTime(20_000);

    const cached = await adapter.reserveMany([request, other]);
    if (cached.admitted) throw new Error("Expected a cached denial.");
    expect(cached).toEqual({
      admitted: false, remaining: { [request.key]: 0.25, [other.key]: 0.5 },
      retryAt: new Date(2_000), source: "leased",
    });
    Object.assign(cached.remaining, { [other.key]: 50 });
    cached.retryAt.setTime(30_000);
    await expect(adapter.reserveMany([request, other])).resolves.toMatchObject({
      remaining: { [request.key]: 0.25, [other.key]: 0.5 }, retryAt: new Date(2_000),
    });
    expect(backend.allocateLeases).toHaveBeenCalledOnce();
  });

  it("can admit from recovered storage before an emergency denial expires", async () => {
    const backend = createAuthoritative();
    const adapter = createAdapter(backend, {
      now: () => new Date(1_000), monotonicNow: () => 0, retryJitterRatio: 0,
    });
    vi.mocked(backend.allocateLeases).mockResolvedValueOnce({
      admitted: false, remaining: { [request.key]: 0 }, retryAt: new Date(61_000), source: "emergency-local",
    });

    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: false, source: "emergency-local" });
    // The backend recovered, so process-local emergency exhaustion no longer determines admission.
    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: true, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledTimes(2);
  });

  it("does not evict a current denial to cache one expiring now", async () => {
    const backend = createAuthoritative();
    const adapter = createAdapter(backend, {
      now: () => new Date(1_000), monotonicNow: () => 0, retryJitterRatio: 0, maxCachedDenials: 1,
    });
    const other = { ...request, key: "test:other" };
    vi.mocked(backend.allocateLeases)
      .mockResolvedValueOnce({ admitted: false, remaining: {}, retryAt: new Date(2_000) })
      .mockResolvedValueOnce({ admitted: false, remaining: {}, retryAt: new Date(1_000) });

    await adapter.reserve(request);
    await adapter.reserve(other);
    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: false, retryAt: new Date(2_000) });
    expect(backend.allocateLeases).toHaveBeenCalledTimes(2);
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

  it("shares one leased denial between differently ordered equivalent batches", async () => {
    const backend = createAuthoritative();
    const second = { ...request, key: "test:second" };
    const denial = { admitted: false, remaining: { [request.key]: 0, [second.key]: 1 }, retryAt: new Date(2_000) } as const;
    vi.mocked(backend.allocateLeases).mockResolvedValue(denial);
    const adapter = createAdapter(backend, { now: () => new Date(1_000), monotonicNow: () => 0, retryJitterRatio: 0 });

    await expect(adapter.reserveMany([request, second])).resolves.toStrictEqual({ ...denial, source: "leased" });
    await expect(adapter.reserveMany([second, request])).resolves.toStrictEqual({ ...denial, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledOnce();
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
    await expect(adapter.reserve(request)).rejects.toMatchObject({
      name: "ThrottlingBackendUnavailableError", cause: new Error("The authoritative backend returned an expired lease."),
    });
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
    random.mockReturnValueOnce(-0.1);
    await expect(adapter.reserve(request)).rejects.toThrow("random source must return [0, 1]");
    random.mockReturnValueOnce(Number.NaN);
    await expect(adapter.reserve(request)).rejects.toThrow("random source must return [0, 1]");
    await expect(adapter.reserve(request)).resolves.toEqual({ admitted: false, remaining: 0, retryAt: denial.retryAt, source: "leased" });
    expect(backend.allocateLeases).toHaveBeenCalledTimes(5);
  });

  it.each([0, 1])("allows inclusive jitter ratio %s and a random value of one", async (retryJitterRatio) => {
    const backend = createAuthoritative();
    const adapter = createAdapter(backend, { now: () => new Date(1_000), monotonicNow: () => 0, retryJitterRatio, random: () => 1 });
    vi.mocked(backend.allocateLeases).mockResolvedValue({ admitted: false, remaining: {}, retryAt: new Date(2_000) });
    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: false, retryAt: new Date(2_000 + 1_000 * retryJitterRatio) });
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
