import { afterEach, describe, expect, it, vi } from "vitest";

import { ThrottlingAdapterCapabilityError } from "../../errors.js";
import type { RateLimitInspectionResult, RateLimitLeaseRequest, RateLimitReservationRequest } from "../../types.js";
import { LeasedRateLimitAdapter } from "./adapter.js";

const request: RateLimitLeaseRequest = {
  key: "inspection:leased", limit: 100, burst: 100, periodMs: 60_000, cost: 1,
  coordination: { strategy: "leased", maxLeaseUnits: 10, leaseMs: 5_000, maxOutstandingUnits: 20, guardBandUnits: 5 },
};
const owned: LeasedRateLimitAdapter[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((adapter) => adapter.close()));
});

/** Inject both clocks so expiry and fractional costs survive filtered reruns unchanged. */
function setup(units = 10) {
  let elapsed = 0;
  const backend = {
    reserve: vi.fn(async () => ({ admitted: true as const, remaining: 50 })),
    allocateLeases: vi.fn(async (_owner: string, requests: readonly RateLimitLeaseRequest[]) => ({
      admitted: true as const,
      allocations: Object.fromEntries(requests.map(({ key }) => [key, { mode: "lease" as const, leaseId: `lease:${key}`, units, expiresAt: new Date(6_000), remaining: 50 }])),
    })),
    returnLeases: vi.fn(async () => 1),
    inspectMany: vi.fn(async (requests: readonly RateLimitReservationRequest[]): Promise<readonly RateLimitInspectionResult[]> => requests.map(() => ({ available: false, remaining: 0, retryAt: new Date(7_000), source: "authoritative" }))),
    reconcile: vi.fn(async () => ({ [request.key]: 42 })),
  };
  const adapter = new LeasedRateLimitAdapter(backend, { ownerId: "inspection-owner", now: () => new Date(1_000 + elapsed), monotonicNow: () => elapsed });
  owned.push(adapter);
  return { backend, adapter, advance: (milliseconds: number) => { elapsed = milliseconds; } };
}

describe("leased throttling inspection and reconciliation", () => {
  it("forwards reconciliation unchanged and returns the authoritative result", async () => {
    const { adapter, backend } = setup();
    const requests = [{ ...request, actualCost: 3, estimatedCost: 1, reservationSource: "leased" as const }];
    const result = { [request.key]: 42 };
    backend.reconcile.mockResolvedValue(result);
    expect(await adapter.reconcile(requests)).toBe(result);
    expect(backend.reconcile).toHaveBeenCalledExactlyOnceWith(requests);
    expect(backend.reconcile.mock.contexts[0]).toBe(backend);
  });

  it("propagates reconciliation failure without substituting local capacity", async () => {
    const { adapter, backend } = setup();
    const failure = new Error("reconciliation unavailable");
    backend.reconcile.mockRejectedValue(failure);
    await expect(adapter.reconcile([])).rejects.toBe(failure);
  });

  it("reports unsupported reconciliation and inspection capabilities", async () => {
    const { backend } = setup();
    const { inspectMany: _inspect, reconcile: _reconcile, ...limited } = backend;
    const adapter = new LeasedRateLimitAdapter(limited);
    owned.push(adapter);
    expect(() => adapter.reconcile([])).toThrow(ThrottlingAdapterCapabilityError);
    expect(() => adapter.reconcile([])).toThrow(expect.objectContaining({ capability: "cost reconciliation" }));
    await expect(adapter.inspectMany([request])).rejects.toMatchObject({ name: "ThrottlingAdapterCapabilityError", capability: "advisory inspection" });
  });

  it("returns an empty inspection without calling the authoritative backend", async () => {
    const { adapter, backend } = setup();
    expect(await adapter.inspectMany([])).toEqual([]);
    expect(backend.inspectMany).not.toHaveBeenCalled();
  });

  it("preserves input order across local, exact and unavailable leased requests", async () => {
    const { adapter, backend } = setup();
    await adapter.reserve(request);
    const exact = { ...request, key: "inspection:exact", coordination: { strategy: "exact" as const } };
    const missing = { ...request, key: "inspection:missing" };
    const exactResult = { available: true, remaining: 33, source: "authoritative" as const };
    const missingResult = { available: false, remaining: 0, retryAt: new Date(7_000), source: "authoritative" as const };
    backend.inspectMany.mockResolvedValue([exactResult, missingResult]);
    expect(await adapter.inspectMany([request, exact, missing])).toEqual([
      { available: true, remaining: 9, source: "leased" }, exactResult, missingResult,
    ]);
    expect(backend.inspectMany).toHaveBeenCalledExactlyOnceWith([exact, missing]);
    // Inspection is advisory and must not consume the available local grant.
    expect(await adapter.inspectMany([request])).toEqual([{ available: true, remaining: 9, source: "leased" }]);
    expect(backend.allocateLeases).toHaveBeenCalledTimes(1);
  });

  it("routes requests with absent coordination to authoritative inspection", async () => {
    const { adapter, backend } = setup();
    const { coordination: _coordination, ...exact } = request;
    expect(await adapter.inspectMany([exact])).toEqual([{ available: false, remaining: 0, retryAt: new Date(7_000), source: "authoritative" }]);
    expect(backend.inspectMany).toHaveBeenCalledExactlyOnceWith([exact]);
  });

  it("never substitutes a local lease for an exact inspection on the same key", async () => {
    const { adapter, backend } = setup();
    await adapter.reserve(request);
    const exact = { ...request, coordination: { strategy: "exact" as const } };
    // A warm local grant cannot answer a request for authoritative exact state.
    expect(await adapter.inspectMany([exact])).toEqual([{ available: false, remaining: 0, retryAt: new Date(7_000), source: "authoritative" }]);
    expect(backend.inspectMany).toHaveBeenCalledExactlyOnceWith([exact]);
  });

  for (const elapsed of [5_000, 5_001]) {
    it(`discards local capacity at monotonic offset ${elapsed}`, async () => {
      const { adapter, backend, advance } = setup();
      await adapter.reserve(request);
      advance(elapsed);
      expect(await adapter.inspectMany([request])).toEqual([{ available: false, remaining: 0, retryAt: new Date(7_000), source: "authoritative" }]);
      expect(backend.inspectMany).toHaveBeenCalledExactlyOnceWith([request]);
    });
  }

  it("falls back to authoritative inspection after consuming all local capacity", async () => {
    const { adapter, backend } = setup();
    await adapter.reserve({ ...request, cost: 10 });
    expect(await adapter.inspectMany([request])).toEqual([{ available: false, remaining: 0, retryAt: new Date(7_000), source: "authoritative" }]);
    expect(backend.inspectMany).toHaveBeenCalledExactlyOnceWith([request]);
  });

  it("honors the inclusive floating-point tolerance without consuming capacity", async () => {
    const { adapter, backend } = setup(0.3);
    const fractional = { ...request, cost: 0.1 };
    await adapter.reserve(fractional);
    const remaining = 0.3 - 0.1;
    // Match the exact inclusive tolerance boundary, then cross it by another epsilon.
    expect(await adapter.inspectMany([{ ...request, cost: remaining + Number.EPSILON }])).toEqual([{ available: true, remaining, source: "leased" }]);
    expect(backend.inspectMany).not.toHaveBeenCalled();
    await adapter.inspectMany([{ ...request, cost: remaining + 2 * Number.EPSILON }]);
    expect(backend.inspectMany).toHaveBeenCalledOnce();
  });

  for (const count of [0, 2]) {
    it(`rejects an authoritative result count of ${count} for one request`, async () => {
      const { adapter, backend } = setup();
      backend.inspectMany.mockResolvedValue(Array.from({ length: count }, () => ({ available: true, remaining: 1 })));
      await expect(adapter.inspectMany([request])).rejects.toThrow("The throttling adapter returned an incomplete inspection.");
    });
  }

  it("propagates authoritative inspection failures", async () => {
    const { adapter, backend } = setup();
    const failure = new Error("inspection unavailable");
    backend.inspectMany.mockRejectedValue(failure);
    await expect(adapter.inspectMany([request])).rejects.toBe(failure);
  });

  it("refuses inspection after close", async () => {
    const { adapter, backend } = setup();
    await adapter.close();
    await expect(adapter.inspectMany([request])).rejects.toMatchObject({ name: "ThrottlingBackendUnavailableError" });
    expect(backend.inspectMany).not.toHaveBeenCalled();
  });
});
