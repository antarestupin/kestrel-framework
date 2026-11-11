import { describe, expect, it, vi } from "vitest";

import { ThrottlingAdapterCapabilityError } from "../../errors.js";
import type {
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter,
  RateLimitAdapter,
  RateLimitLeaseRequest,
  RateLimitReservationRequest,
} from "../../types.js";
import { MemoryRateLimitAdapter } from "../memory/adapter.js";
import { DenialCachingRateLimitAdapter } from "./adapter.js";

const request: RateLimitReservationRequest = {
  key: "test:partner",
  limit: 1,
  periodMs: 1_000,
  burst: 1,
  cost: 1,
};
const otherRequest = { ...request, key: "test:other" };
const retryAt = new Date(1_000);
const fixedClock = { now: () => new Date(0), monotonicNow: () => 0 };

describe("DenialCachingRateLimitAdapter", () => {
  it("caches a matching denial until its monotonic deadline", async () => {
    let calls = 0;
    let monotonicMs = 0;
    const adapter = new DenialCachingRateLimitAdapter({
      reserve: async () => {
        calls += 1;
        return {
          admitted: false,
          remaining: 0,
          retryAt: new Date(1_000),
          source: "authoritative",
        };
      },
    }, {
      now: () => new Date(0),
      monotonicNow: () => monotonicMs,
    });

    const authoritative = await adapter.reserve(request);
    const cached = await adapter.reserve(request);

    expect(authoritative.source).toBe("authoritative");
    expect(cached).toEqual({ ...authoritative, source: "denial-cache" });
    expect(calls).toBe(1);

    monotonicMs = 1_000;
    await adapter.reserve(request);
    expect(calls).toBe(2);
  });

  it("coalesces concurrent denials but never shares successful admissions", async () => {
    let deniedCalls = 0;
    const denied = new DenialCachingRateLimitAdapter({
      reserve: async () => {
        deniedCalls += 1;
        await Promise.resolve();
        return {
          admitted: false,
          remaining: 0,
          retryAt: new Date(1_000),
        };
      },
    }, { now: () => new Date(0), monotonicNow: () => 0 });

    const denials = await Promise.all([
      denied.reserve(request),
      denied.reserve(request),
      denied.reserve(request),
    ]);

    expect(deniedCalls).toBe(1);
    expect(denials.map((result) => result.source)).toEqual([
      undefined,
      "denial-cache",
      "denial-cache",
    ]);

    let admittedCalls = 0;
    const admitted = new DenialCachingRateLimitAdapter({
      reserve: async () => ({
        admitted: true,
        remaining: 10 - ++admittedCalls,
      }),
    });
    const admissions = await Promise.all([
      admitted.reserve(request),
      admitted.reserve(request),
      admitted.reserve(request),
    ]);

    expect(admittedCalls).toBe(3);
    expect(admissions.map((result) => result.remaining)).toEqual([9, 8, 7]);
  });

  it("caches batches by their complete request signature", async () => {
    let calls = 0;
    const second = { ...request, key: "test:second" };
    const underlying: RateLimitAdapter = {
      reserve: async () => ({ admitted: true, remaining: 1 }),
      reserveMany: async (requests) => {
        calls += 1;
        return {
          admitted: false,
          remaining: Object.fromEntries(requests.map(({ key }) => [key, 0])),
          retryAt: new Date(1_000),
          source: "authoritative",
        };
      },
    };
    const adapter = new DenialCachingRateLimitAdapter(underlying, {
      now: () => new Date(0),
      monotonicNow: () => 0,
    });

    await adapter.reserveMany([request, second]);
    const cached = await adapter.reserveMany([second, request]);

    expect(calls).toBe(1);
    expect(cached.source).toBe("denial-cache");

    await adapter.reserveMany([{ ...request, cost: 0.5 }, second]);
    expect(calls).toBe(2);
  });

  it("keeps delimiter-bearing keys separate from other request batches", async () => {
    const storage = new MemoryRateLimitAdapter({ now: () => new Date(0) });
    const adapter = new DenialCachingRateLimitAdapter(storage, {
      now: () => new Date(0), monotonicNow: () => 0,
    });
    const first = { ...request, key: "a" };
    const second = { ...request, key: "b" };
    const third = { ...request, key: "c" };
    const delimiterKey = { ...request, key: "a:1:1000:1:1|b" };

    // The second batch uses only untouched buckets despite resembling the first one's signature.
    await storage.reserve(first);
    await expect(adapter.reserveMany([first, second, third])).resolves.toMatchObject({ admitted: false });
    await expect(adapter.reserveMany([delimiterKey, third])).resolves.toEqual({
      admitted: true,
      remaining: { [delimiterKey.key]: 0, [third.key]: 0 },
      source: "local",
    });
  });

  it("uses single reservations for one-key batches and preserves retry metadata and source", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: true, remaining: 1, source: "authoritative" })
      .mockResolvedValueOnce({ admitted: true, remaining: 0 })
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt });
    const adapter = new DenialCachingRateLimitAdapter({ reserve }, fixedClock);

    await expect(adapter.reserveMany([request])).resolves.toEqual({
      admitted: true, remaining: { [request.key]: 1 }, source: "authoritative",
    });
    await expect(adapter.reserveMany([request])).resolves.toEqual({
      admitted: true, remaining: { [request.key]: 0 },
    });
    await expect(adapter.reserveMany([request])).resolves.toEqual({
      admitted: false, remaining: { [request.key]: 0 }, retryAt,
    });
    await expect(adapter.reserveMany([request])).resolves.toEqual({
      admitted: false, remaining: { [request.key]: 0 }, retryAt, source: "denial-cache",
    });
    expect(reserve).toHaveBeenCalledTimes(3);
  });

  it("combines cached denials and fresh inspections in request order", async () => {
    const storage = new MemoryRateLimitAdapter({ now: fixedClock.now });
    const inspect = vi.spyOn(storage, "inspectMany");
    const adapter = new DenialCachingRateLimitAdapter(storage, fixedClock);
    const third = { ...request, key: "test:third" };
    await storage.reserve(request);
    await adapter.reserve(request);

    await expect(adapter.inspectMany([otherRequest, request, third])).resolves.toEqual([
      { available: true, remaining: 1, source: "local" },
      { available: false, remaining: 0, retryAt, source: "denial-cache" },
      { available: true, remaining: 1, source: "local" },
    ]);
    await expect(adapter.inspectMany([request])).resolves.toEqual([
      { available: false, remaining: 0, retryAt, source: "denial-cache" },
    ]);
    expect(inspect).toHaveBeenCalledExactlyOnceWith([otherRequest, third]);
    expect((await adapter.reserve(third)).admitted).toBe(true);
  });

  it("preserves backend capabilities and rejects incomplete advisory inspections", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const adapter = new DenialCachingRateLimitAdapter({ reserve }, fixedClock);
    const leased = {
      ...request,
      coordination: { strategy: "leased", maxLeaseUnits: 1, leaseMs: 1_000, maxOutstandingUnits: 1, guardBandUnits: 0 },
    } as const satisfies RateLimitLeaseRequest;

    await expect(adapter.reserveMany([request, otherRequest])).rejects.toBeInstanceOf(ThrottlingAdapterCapabilityError);
    await expect(adapter.inspectMany([request])).rejects.toBeInstanceOf(ThrottlingAdapterCapabilityError);
    await expect(adapter.reconcile([{ ...request, actualCost: 0, estimatedCost: 1 }]))
      .rejects.toBeInstanceOf(ThrottlingAdapterCapabilityError);
    expect(() => adapter.allocateLeases("owner", [leased])).toThrow(ThrottlingAdapterCapabilityError);
    expect(() => adapter.returnLeases([])).toThrow(ThrottlingAdapterCapabilityError);
    expect(adapter.prune).toBeUndefined();
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(reserve).not.toHaveBeenCalled();

    const incomplete = new DenialCachingRateLimitAdapter({ reserve, inspectMany: async () => [] }, fixedClock);
    await expect(incomplete.inspectMany([request])).rejects.toThrow("returned an incomplete inspection");
  });

  it("passes lease, pruning, and close operations through to their owner", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const prune = vi.fn(async () => 4);
    const close = vi.fn(async () => {});
    const allocateLeases = vi.fn(async () => ({ admitted: true, allocations: {} }) as const);
    const returnLeases = vi.fn(async () => 1);
    const storage = { reserve, prune, close, allocateLeases, returnLeases } satisfies
      PrunableRateLimitAdapter & LeasableRateLimitAdapter;
    const adapter = new DenialCachingRateLimitAdapter(storage);

    const completed = [{ key: request.key, leaseId: "previous", remaining: 1 }];
    await expect(adapter.allocateLeases("owner", [])).resolves.toEqual({ admitted: true, allocations: {} });
    expect(allocateLeases).toHaveBeenCalledExactlyOnceWith("owner", [], []);
    await expect(adapter.returnLeases(completed)).resolves.toBe(1);
    expect(returnLeases).toHaveBeenCalledExactlyOnceWith(completed);
    await expect(adapter.prune?.({ limit: 5 })).resolves.toBe(4);
    expect(prune).toHaveBeenCalledExactlyOnceWith({ limit: 5 });
    await adapter.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("invalidates single and batch denials only after a successful refund", async () => {
    const storage = new MemoryRateLimitAdapter({ now: fixedClock.now });
    const failure = new Error("refund rejected by storage");
    vi.spyOn(storage, "reconcile").mockRejectedValueOnce(failure);
    const adapter = new DenialCachingRateLimitAdapter(storage, fixedClock);
    const batch = [request, otherRequest];
    const refund = [{ ...request, actualCost: 0, estimatedCost: 1 }];

    await storage.reserve(request);
    await adapter.reserve(request);
    await adapter.reserveMany(batch);
    await expect(adapter.reconcile(refund)).rejects.toBe(failure);
    await expect(adapter.reserve(request)).resolves.toMatchObject({ source: "denial-cache" });
    await expect(adapter.reserveMany(batch)).resolves.toMatchObject({ source: "denial-cache" });

    await expect(adapter.reconcile(refund)).resolves.toEqual({ [request.key]: 1 });
    await expect(adapter.inspectMany([request])).resolves.toEqual([{ available: true, remaining: 1, source: "local" }]);
    await expect(adapter.reserveMany(batch)).resolves.toEqual({
      admitted: true, remaining: { [request.key]: 0, [otherRequest.key]: 0 }, source: "local",
    });
  });

  it.each([new Date(0), new Date(NaN)])("rechecks denials without a future deadline (%s)", async (deadline) => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: false, remaining: 0, retryAt: deadline });
    const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>()
      .mockResolvedValue({ admitted: false, remaining: {}, retryAt: deadline });
    const adapter = new DenialCachingRateLimitAdapter({ reserve, reserveMany }, fixedClock);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: false });
      await expect(adapter.reserveMany([request, otherRequest])).resolves.toMatchObject({ admitted: false });
    }
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserveMany).toHaveBeenCalledTimes(2);
  });

  it.each(["wall", "monotonic"] as const)("releases a reservation after an invalid %s clock reading", async (clock) => {
    let valid = false;
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: false, remaining: 0, retryAt });
    const adapter = new DenialCachingRateLimitAdapter({ reserve }, {
      now: () => new Date(!valid && clock === "wall" ? NaN : 0),
      monotonicNow: () => !valid && clock === "monotonic" ? Infinity : 0,
    });

    await expect(adapter.reserve(request)).rejects.toThrow(clock === "wall" ? "invalid date" : "must be finite");
    valid = true;
    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: false });
    await expect(adapter.reserve(request)).resolves.toMatchObject({ source: "denial-cache" });
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it("uses system clocks by default and rejects an invalid cache capacity", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({
      admitted: false, remaining: 0, retryAt: new Date(Date.now() + 60_000),
    });
    for (const maxEntries of [0, 1.5]) {
      expect(() => new DenialCachingRateLimitAdapter({ reserve }, { maxEntries })).toThrow("positive integer");
    }
    const adapter = new DenialCachingRateLimitAdapter({ reserve });
    await adapter.reserve(request);
    await expect(adapter.reserve(request)).resolves.toMatchObject({ source: "denial-cache" });
    expect(reserve).toHaveBeenCalledOnce();
  });

  it.each(["single", "batch"] as const)("expires old %s entries before evicting a current denial", async (kind) => {
    let monotonicMs = 0;
    const longRetryAt = new Date(3_000);
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValue({ admitted: false, remaining: 0, retryAt: kind === "single" ? retryAt : longRetryAt });
    const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>()
      .mockResolvedValue({ admitted: false, remaining: {}, retryAt: kind === "batch" ? retryAt : longRetryAt });
    const adapter = new DenialCachingRateLimitAdapter({ reserve, reserveMany }, {
      ...fixedClock, monotonicNow: () => monotonicMs, maxEntries: 2,
    });
    const single = () => adapter.reserve(request);
    const batch = () => adapter.reserveMany([request, otherRequest]);
    const expiring = kind === "single" ? single : batch;
    const live = kind === "single" ? batch : single;

    // Store the live denial first so eviction by age would wrongly discard it.
    await live();
    await expiring();
    monotonicMs = 1_000;
    await adapter.reserve({ ...request, key: "test:new" });
    await expect(live()).resolves.toMatchObject({ source: "denial-cache" });
  });

  it.each(["single", "batch"] as const)("bounds the cache when all %s entries are current", async (kind) => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: false, remaining: 0, retryAt });
    const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>()
      .mockResolvedValue({ admitted: false, remaining: {}, retryAt });
    const adapter = new DenialCachingRateLimitAdapter({ reserve, reserveMany }, { ...fixedClock, maxEntries: 1 });
    const attempt = (key: string) => kind === "single"
      ? adapter.reserve({ ...request, key })
      : adapter.reserveMany([{ ...request, key }, otherRequest]);

    await attempt("test:earlier");
    await attempt("test:newer");
    await expect(attempt("test:newer")).resolves.toMatchObject({ source: "denial-cache" });
    await expect(attempt("test:earlier")).resolves.not.toHaveProperty("source");
    expect(kind === "single" ? reserve : reserveMany).toHaveBeenCalledTimes(3);
  });

  it.each(["single", "batch"] as const)(
    "does not cache a %s denial that arrives after a successful reconciliation",
    async (kind) => {
      const storage = new MemoryRateLimitAdapter({ now: fixedClock.now });
      await storage.reserve(request);
      const started = Promise.withResolvers<void>();
      const deliver = Promise.withResolvers<void>();
      let held = false;
      const delayFirstResponse = async <Result>(operation: Promise<Result>) => {
        const result = await operation;
        if (!held) {
          held = true;
          started.resolve();
          await deliver.promise;
        }
        return result;
      };
      const adapter = new DenialCachingRateLimitAdapter({
        reserve: (value) => delayFirstResponse(storage.reserve(value)),
        reserveMany: (values) => delayFirstResponse(storage.reserveMany(values)),
        reconcile: (values) => storage.reconcile(values),
      }, fixedClock);
      const attempt = () => kind === "single" ? adapter.reserve(request) : adapter.reserveMany([request, otherRequest]);

      const pending = attempt();
      await started.promise;
      try {
        // A refund lands after the backend's denial snapshot and before its response is delivered.
        await expect(adapter.reconcile([{ ...request, estimatedCost: 1, actualCost: 0 }]))
          .resolves.toEqual({ [request.key]: 1 });
      } finally {
        deliver.resolve();
        await pending;
      }

      await expect(pending).resolves.toMatchObject({ admitted: false, retryAt });
      await expect(attempt()).resolves.toMatchObject({ admitted: true });
    },
  );
});
