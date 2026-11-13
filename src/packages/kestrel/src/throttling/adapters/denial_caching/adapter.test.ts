import { describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";

import { ThrottlingDefinitionConflictError } from "../../errors.js";
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
    const reused = vi.fn();
    const pending = adapter.reserve(request);
    void pending.then(reused, reused);
    await setImmediate();
    expect(reused).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "denial-cache" }));
    const cached = await pending;

    expect(authoritative.source).toBe("authoritative");
    expect(cached).toEqual({ ...authoritative, source: "denial-cache" });
    expect(calls).toBe(1);

    monotonicMs = 1_000;
    await adapter.reserve(request);
    expect(calls).toBe(2);
  });

  it("rechecks a cached key when the requested cost changes", async () => {
    const changed = { ...request, cost: 0.5 };
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0.5, retryAt })
      .mockResolvedValueOnce({ admitted: true, remaining: 0, source: "authoritative" });
    const adapter = new DenialCachingRateLimitAdapter({ reserve }, fixedClock);

    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: false, retryAt });
    // The smaller cost can fit now, while the earlier and larger request remains ineligible.
    await expect(adapter.reserve(changed)).resolves.toEqual({
      admitted: true, remaining: 0, source: "authoritative",
    });
    expect(reserve.mock.calls).toEqual([[request], [changed]]);
  });

  it("checks incompatible coordination settings with the backend after single and batch denials", async () => {
    const leased = { ...request, coordination: { strategy: "leased", maxLeaseUnits: 1,
      maxOutstandingUnits: 1, guardBandUnits: 0, leaseMs: 2_000 } } as const;
    const changed = { ...leased, coordination: { ...leased.coordination, leaseMs: 3_000 } };
    const failure = new ThrottlingDefinitionConflictError(request.key);
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt }).mockRejectedValueOnce(failure);
    const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>()
      .mockResolvedValueOnce({ admitted: false, remaining: { [request.key]: 0, [otherRequest.key]: 1 }, retryAt })
      .mockRejectedValueOnce(failure);
    const adapter = new DenialCachingRateLimitAdapter({ reserve, reserveMany }, fixedClock);

    await adapter.reserve(leased);
    await expect(adapter.reserve(changed)).rejects.toBe(failure);
    await adapter.reserveMany([leased, otherRequest]);
    await expect(adapter.reserveMany([otherRequest, leased])).resolves.toMatchObject({ source: "denial-cache" });
    await expect(adapter.reserveMany([otherRequest, changed])).rejects.toBe(failure);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserveMany).toHaveBeenCalledTimes(2);
  });

  it("keeps cached single denials independent of returned retry dates", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValue({ admitted: false, remaining: 0, retryAt: new Date(1_000) });
    const adapter = new DenialCachingRateLimitAdapter({ reserve }, fixedClock);

    const original = await adapter.reserve(request);
    if (original.admitted) throw new Error("Expected an authoritative denial.");
    original.retryAt.setTime(99_000);

    const cached = await adapter.reserve(request);
    if (cached.admitted) throw new Error("Expected a cached denial.");
    expect(cached.retryAt).toEqual(new Date(1_000));
    cached.retryAt.setTime(80_000);

    const [inspection] = await adapter.inspectMany([request]);
    expect(inspection?.retryAt).toEqual(new Date(1_000));
    inspection?.retryAt?.setTime(70_000);
    await expect(adapter.reserve(request)).resolves.toMatchObject({ retryAt: new Date(1_000) });
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("keeps cached batch denials independent of caller-owned retry dates and remaining amounts", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const amounts = { [request.key]: 0.25, [otherRequest.key]: 0 };
    const originalDate = new Date(1_000);
    const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>()
      .mockResolvedValue({ admitted: false, remaining: amounts, retryAt: originalDate });
    const adapter = new DenialCachingRateLimitAdapter({ reserve, reserveMany }, fixedClock);
    const batch = [request, otherRequest];

    await adapter.reserveMany(batch);
    amounts[request.key] = 10;
    originalDate.setTime(99_000);

    const cached = await adapter.reserveMany(batch);
    if (cached.admitted) throw new Error("Expected a cached batch denial.");
    expect(cached).toEqual({
      admitted: false, retryAt: new Date(1_000), remaining: { [request.key]: 0.25, [otherRequest.key]: 0 },
      source: "denial-cache",
    });
    cached.retryAt.setTime(90_000);
    Object.assign(cached.remaining, { [request.key]: 20 });
    await expect(adapter.reserveMany(batch)).resolves.toMatchObject({
      retryAt: new Date(1_000), remaining: { [request.key]: 0.25, [otherRequest.key]: 0 },
    });
    expect(reserveMany).toHaveBeenCalledOnce();
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

    const settledDenials = vi.fn();
    const denialBatch = Promise.all([
      denied.reserve(request),
      denied.reserve(request),
      denied.reserve(request),
    ]);
    void denialBatch.then(settledDenials, settledDenials);
    await setImmediate();
    expect(settledDenials).toHaveBeenCalledExactlyOnceWith(Array.from({ length: 3 }, () => expect.objectContaining({ admitted: false })));
    const denials = await denialBatch;

    expect(deniedCalls).toBe(1);
    expect(denials.map((result) => result.source)).toEqual([
      undefined,
      "denial-cache",
      "denial-cache",
    ]);
    // High-cardinality traffic must not retain one lock entry for each past key.
    expect(denied["serialization"].size).toBe(0);

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

  it.each(["single", "batch"] as const)(
    "serializes a %s key without blocking independent requests",
    async (kind) => {
      const releaseFirst = Promise.withResolvers<void>();
      const releaseSecond = Promise.withResolvers<void>();
      const seen: string[] = [];
      let sharedCount = 0;
      const wait = async (key: string) => {
        seen.push(key);
        if (key !== request.key) return;
        sharedCount += 1;
        if (sharedCount === 1) {
          await releaseFirst.promise;
        } else if (sharedCount === 2) {
          await releaseSecond.promise;
        }
      };
      const adapter = new DenialCachingRateLimitAdapter({
        reserve: async ({ key }) => {
          await wait(key);
          return { admitted: true, remaining: 0 };
        },
        reserveMany: async ([first]) => {
          await wait(first!.key);
          return { admitted: true, remaining: {} };
        },
      }, fixedClock);
      const attempt = (value: RateLimitReservationRequest) => kind === "single"
        ? adapter.reserve(value)
        : adapter.reserveMany([value, otherRequest]);

      const first = attempt(request);
      await setImmediate();
      expect(seen).toEqual([request.key]);
      const second = attempt(request);
      const independent = attempt({ ...request, key: "test:independent" });
      const pending = [first, second, independent];
      try {
        // Drain pending continuations while the first matching backend call is held.
        await setImmediate();
        expect(seen).toEqual([request.key, "test:independent"]);
        releaseFirst.resolve();
        await setImmediate();
        expect(seen).toEqual([request.key, "test:independent", request.key]);
        const third = attempt(request);
        pending.push(third);
        await setImmediate();
        expect(seen).toEqual([request.key, "test:independent", request.key]);
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        // A broken serializer can strand its successor. Check settlement in
        // one event-loop turn instead of blocking fixture teardown.
        const completed = vi.fn();
        void Promise.allSettled(pending).then(completed);
        await setImmediate();
        expect(completed).toHaveBeenCalledOnce();
      }
      expect(sharedCount).toBe(3);
    },
  );

  it("caches batches by their complete request signature", async () => {
    let calls = 0;
    let monotonicMs = 0;
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
      monotonicNow: () => monotonicMs,
    });

    await adapter.reserveMany([request, second]);
    const cached = await adapter.reserveMany([second, request]);

    expect(calls).toBe(1);
    expect(cached).toEqual({
      admitted: false,
      remaining: { [request.key]: 0, [second.key]: 0 },
      retryAt,
      source: "denial-cache",
    });

    await adapter.reserveMany([{ ...request, cost: 0.5 }, second]);
    expect(calls).toBe(2);

    // A matching batch must consult storage again at the exact expiration boundary.
    monotonicMs = 1_000;
    await expect(adapter.reserveMany([request, second])).resolves.toMatchObject({ source: "authoritative" });
    expect(calls).toBe(3);
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

    await expect(adapter.reserveMany([request])).resolves.toStrictEqual({
      admitted: true, remaining: { [request.key]: 1 }, source: "authoritative",
    });
    await expect(adapter.reserveMany([request])).resolves.toStrictEqual({
      admitted: true, remaining: { [request.key]: 0 },
    });
    await expect(adapter.reserveMany([request])).resolves.toStrictEqual({
      admitted: false, remaining: { [request.key]: 0 }, retryAt,
    });
    await expect(adapter.reserveMany([request])).resolves.toEqual({
      admitted: false, remaining: { [request.key]: 0 }, retryAt, source: "denial-cache",
    });
    expect(reserve).toHaveBeenCalledTimes(3);
  });

  it.each(["single", "batch"] as const)(
    "calculates a %s denial's duration from a nonzero wall clock",
    async (kind) => {
      let monotonicMs = 700;
      const deadline = new Date(11_000);
      const reserve = vi.fn<RateLimitAdapter["reserve"]>()
        .mockResolvedValue({ admitted: false, remaining: 0, retryAt: deadline, source: "authoritative" });
      const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>()
        .mockResolvedValue({ admitted: false, remaining: {}, retryAt: deadline, source: "authoritative" });
      const adapter = new DenialCachingRateLimitAdapter({ reserve, reserveMany }, {
        now: () => new Date(10_000), monotonicNow: () => monotonicMs,
      });
      const attempt = () => kind === "single" ? adapter.reserve(request) : adapter.reserveMany([request, otherRequest]);
      await expect(attempt()).resolves.toMatchObject({ source: "authoritative", retryAt: deadline });
      monotonicMs = 1_699;
      await expect(attempt()).resolves.toMatchObject({ source: "denial-cache", retryAt: deadline });
      monotonicMs = 1_700;
      await expect(attempt()).resolves.toMatchObject({ source: "authoritative", retryAt: deadline });
    },
  );

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

    await expect(adapter.reserveMany([request, otherRequest])).rejects.toMatchObject({ capability: "atomic batch reservation" });
    await expect(adapter.inspectMany([request])).rejects.toMatchObject({ capability: "advisory inspection" });
    await expect(adapter.reconcile([{ ...request, actualCost: 0, estimatedCost: 1 }]))
      .rejects.toMatchObject({ capability: "cost reconciliation" });
    expect(() => adapter.allocateLeases("owner", [leased])).toThrow(expect.objectContaining({ capability: "leased coordination" }));
    expect(() => adapter.returnLeases([])).toThrow(expect.objectContaining({ capability: "leased coordination" }));
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

  it.each([
    ["single", new Date(10_000)],
    ["single", new Date(NaN)],
    ["batch", new Date(9_999)],
    ["batch", new Date(NaN)],
  ] as const)("keeps a useful denial when a %s denial has no future deadline (%s)", async (kind, deadline) => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(11_000) })
      .mockResolvedValue({ admitted: false, remaining: 0, retryAt: deadline });
    const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>()
      .mockResolvedValue({ admitted: false, remaining: {}, retryAt: deadline });
    const adapter = new DenialCachingRateLimitAdapter({ reserve, reserveMany }, {
      now: () => new Date(10_000), monotonicNow: () => 1_000, maxEntries: 1,
    });

    await adapter.reserve(request);
    if (kind === "single") await adapter.reserve(otherRequest);
    else await adapter.reserveMany([otherRequest, { ...otherRequest, key: "test:third" }]);
    await expect(adapter.reserve(request)).resolves.toMatchObject({ source: "denial-cache" });
    expect(reserve).toHaveBeenCalledTimes(kind === "single" ? 2 : 1);
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

  it("prunes a recently inserted expired single entry before evicting a long-lived denial", async () => {
    let monotonicMs = 0;
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(10_000) })
      .mockResolvedValue({ admitted: false, remaining: 0, retryAt });
    const adapter = new DenialCachingRateLimitAdapter({ reserve }, {
      ...fixedClock, monotonicNow: () => monotonicMs, maxEntries: 2,
    });

    await adapter.reserve(request);
    await adapter.reserve(otherRequest);
    monotonicMs = 1_000;
    await adapter.reserve({ ...request, key: "test:new" });
    await expect(adapter.reserve(request)).resolves.toMatchObject({ source: "denial-cache" });
    expect(reserve).toHaveBeenCalledTimes(3);
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
