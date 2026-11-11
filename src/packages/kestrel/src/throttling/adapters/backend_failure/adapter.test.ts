import { describe, expect, it, vi } from "vitest";

import {
  ThrottlingAdapterCapabilityError,
  ThrottlingBackendUnavailableError,
  ThrottlingCostExceedsBurstError,
} from "../../errors.js";
import type {
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter,
  RateLimitAdapter,
  RateLimitLeaseRequest,
  RateLimitReservationRequest,
} from "../../types.js";
import { BackendFailureRateLimitAdapter } from "./adapter.js";
import { MemoryRateLimitAdapter } from "../memory/index.js";

const request: RateLimitReservationRequest = {
  key: "test:partner-api",
  limit: 100,
  periodMs: 1_000,
  burst: 100,
  cost: 1,
};
const leaseRequest = {
  ...request,
  coordination: {
    strategy: "leased",
    maxLeaseUnits: 2,
    leaseMs: 1_000,
    maxOutstandingUnits: 2,
    guardBandUnits: 0,
  },
} as const satisfies RateLimitLeaseRequest;
const emergencyPolicy = { strategy: "emergency-local", capacity: 2, periodMs: 60_000 } as const;

describe("BackendFailureRateLimitAdapter", () => {
  it("fails closed by default", async () => {
    const backendError = new ThrottlingBackendUnavailableError({
      cause: new Error("database unavailable"),
    });
    const adapter = new BackendFailureRateLimitAdapter(
      failingAdapter(backendError),
      { strategy: "reject" },
    );

    await expect(adapter.reserve(request)).rejects.toBe(backendError);
    await expect(adapter.reserveMany([request])).rejects.toBe(backendError);
    await expect(adapter.inspectMany([request])).rejects.toBe(backendError);
    await expect(adapter.allocateLeases("worker-a", [leaseRequest])).rejects.toBe(backendError);
  });

  it("preserves operation errors instead of treating them as outages", async () => {
    const failure = new TypeError("invalid authoritative request");
    const fallback = new MemoryRateLimitAdapter();
    const reserve = vi.spyOn(fallback, "reserve");
    const reserveMany = vi.spyOn(fallback, "reserveMany");
    const inspect = vi.spyOn(fallback, "inspectMany");
    const adapter = new BackendFailureRateLimitAdapter(failingAdapter(failure), emergencyPolicy, { fallback });

    await expect(adapter.reserve(request)).rejects.toBe(failure);
    await expect(adapter.reserveMany([request])).rejects.toBe(failure);
    await expect(adapter.inspectMany([request])).rejects.toBe(failure);
    await expect(adapter.allocateLeases("worker-a", [leaseRequest])).rejects.toBe(failure);
    expect(reserve).not.toHaveBeenCalled();
    expect(reserveMany).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("reports missing backend capabilities without attempting emergency operations", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: true, remaining: 5 });
    const adapter = new BackendFailureRateLimitAdapter({ reserve }, emergencyPolicy);

    await expect(adapter.reserveMany([request])).rejects.toBeInstanceOf(ThrottlingAdapterCapabilityError);
    await expect(adapter.inspectMany([request])).rejects.toBeInstanceOf(ThrottlingAdapterCapabilityError);
    await expect(adapter.reconcile([{ ...request, estimatedCost: 1, actualCost: 0 }]))
      .rejects.toBeInstanceOf(ThrottlingAdapterCapabilityError);
    await expect(adapter.allocateLeases("worker-a", [leaseRequest])).rejects.toBeInstanceOf(ThrottlingAdapterCapabilityError);
    expect(() => adapter.returnLeases([])).toThrow(ThrottlingAdapterCapabilityError);
    expect(reserve).not.toHaveBeenCalled();
    expect(adapter.prune).toBeUndefined();
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it.each([
    { policy: { ...emergencyPolicy, capacity: 0 }, message: "capacity must be at least one" },
    { policy: { ...emergencyPolicy, capacity: Infinity }, message: "capacity must be at least one" },
    { policy: { ...emergencyPolicy, periodMs: 0 }, message: "periodMs must be positive and finite" },
    { policy: { ...emergencyPolicy, periodMs: Infinity }, message: "periodMs must be positive and finite" },
  ])("rejects invalid emergency policy $policy", ({ policy, message }) => {
    const authoritative = { reserve: vi.fn<RateLimitAdapter["reserve"]>() };
    expect(() => new BackendFailureRateLimitAdapter(authoritative, policy)).toThrow(message);
    expect(authoritative.reserve).not.toHaveBeenCalled();
  });

  it("provides only the configured process-local emergency capacity", async () => {
    const fallback = new MemoryRateLimitAdapter({
      now: () => new Date(0),
    });
    const adapter = new BackendFailureRateLimitAdapter(
      failingAdapter(new ThrottlingBackendUnavailableError({
        cause: new Error("database unavailable"),
      })),
      { strategy: "emergency-local", capacity: 2, periodMs: 60_000 },
      { fallback },
    );

    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
      source: "emergency-local",
    });
    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
      source: "emergency-local",
    });
    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: false,
      source: "emergency-local",
    });
  });

  it("never applies emergency admission to maintenance failures", async () => {
    const backendError = new ThrottlingBackendUnavailableError({
      cause: new Error("database unavailable"),
    });
    const adapter = new BackendFailureRateLimitAdapter(
      failingAdapter(backendError),
      { strategy: "emergency-local", capacity: 1, periodMs: 1_000 },
    );

    await expect(adapter.prune!({ limit: 10 })).rejects.toBe(backendError);
  });

  it("degrades atomic batches and inspection as one bounded local policy", async () => {
    const adapter = new BackendFailureRateLimitAdapter(
      failingAdapter(new ThrottlingBackendUnavailableError({
        cause: new Error("database unavailable"),
      })),
      { strategy: "emergency-local", capacity: 1, periodMs: 60_000 },
      { fallback: new MemoryRateLimitAdapter({ now: () => new Date(0) }) },
    );
    const requests = [
      request,
      { ...request, key: "test:tokens" },
    ];

    await expect(adapter.reserveMany(requests)).resolves.toMatchObject({
      admitted: true,
      source: "emergency-local",
    });
    await expect(adapter.inspectMany?.(requests)).resolves.toMatchObject([
      { available: false, source: "emergency-local" },
      { available: false, source: "emergency-local" },
    ]);
  });

  it("reconciles emergency permits only in their local fallback bucket", async () => {
    const fallback = new MemoryRateLimitAdapter({ now: () => new Date(0) });
    const adapter = new BackendFailureRateLimitAdapter(
      failingAdapter(new ThrottlingBackendUnavailableError({
        cause: new Error("database unavailable"),
      })),
      { strategy: "emergency-local", capacity: 2, periodMs: 60_000 },
      { fallback },
    );

    await adapter.reserveMany([request]);
    await expect(adapter.reconcile?.([{
      ...request,
      estimatedCost: 1,
      actualCost: 2,
      reservationSource: "emergency-local",
    }])).resolves.toMatchObject({ "test:partner-api": 0 });
  });

  it("reconciles both sources separately once the backend recovers", async () => {
    const other = { ...request, key: "test:other" };
    const storage = new MemoryRateLimitAdapter({ now: () => new Date(0) });
    const fallback = new MemoryRateLimitAdapter({ now: () => new Date(0) });
    const failure = new ThrottlingBackendUnavailableError({ cause: new Error("backend unavailable") });
    const authoritative = {
      reserve: vi.fn<RateLimitAdapter["reserve"]>()
        .mockRejectedValueOnce(failure)
        .mockImplementation((value) => storage.reserve(value)),
      reconcile: vi.fn((values: Parameters<typeof storage.reconcile>[0]) => storage.reconcile(values)),
      inspectMany: (values: Parameters<typeof storage.inspectMany>[0]) => storage.inspectMany(values),
    };
    const adapter = new BackendFailureRateLimitAdapter(authoritative, emergencyPolicy, { fallback });

    await expect(adapter.reserve(request)).resolves.toEqual({ admitted: true, remaining: 1, source: "emergency-local" });
    await expect(adapter.reserve(other)).resolves.toEqual({ admitted: true, remaining: 99 });
    const localCharge = { ...request, estimatedCost: 1, actualCost: 2, reservationSource: "emergency-local" } as const;
    const authoritativeRefund = { ...other, estimatedCost: 1, actualCost: 0 };

    // Completion source belongs to the permit, even though the backend is healthy again.
    await expect(adapter.reconcile([localCharge, authoritativeRefund])).resolves.toEqual({
      [request.key]: 0, [other.key]: 100,
    });
    expect(authoritative.reconcile).toHaveBeenCalledExactlyOnceWith([authoritativeRefund]);
    await expect(adapter.inspectMany([request, other])).resolves.toMatchObject([
      { remaining: 100, available: true }, { remaining: 100, available: true },
    ]);
    authoritative.reserve.mockRejectedValueOnce(failure);
    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: false, remaining: 0, retryAt: new Date(30_000), source: "emergency-local",
    });
    await expect(adapter.reconcile([authoritativeRefund])).resolves.toEqual({ [other.key]: 100 });
  });

  it("rejects oversized requests before consuming any capacity from a fallback batch", async () => {
    const oversized = { ...leaseRequest, key: "test:oversized", cost: 3 };
    const adapter = new BackendFailureRateLimitAdapter(
      failingAdapter(new ThrottlingBackendUnavailableError({ cause: new Error("database unavailable") })),
      emergencyPolicy,
      { fallback: new MemoryRateLimitAdapter({ now: () => new Date(0) }) },
    );

    await expect(adapter.reserve(oversized)).rejects.toBeInstanceOf(ThrottlingCostExceedsBurstError);
    await expect(adapter.reserveMany([request, oversized])).rejects.toBeInstanceOf(ThrottlingCostExceedsBurstError);
    await expect(adapter.allocateLeases("worker-a", [leaseRequest, oversized])).rejects.toBeInstanceOf(ThrottlingCostExceedsBurstError);
    await expect(adapter.inspectMany([request, oversized])).resolves.toEqual([
      { available: true, remaining: 2, source: "emergency-local" },
      { available: false, remaining: 2, source: "emergency-local" },
    ]);
  });

  it("uses bounded emergency capacity when lease replenishment cannot reach PostgreSQL", async () => {
    const error = new ThrottlingBackendUnavailableError({
      cause: new Error("database unavailable"),
    });
    const adapter = new BackendFailureRateLimitAdapter(
      failingAdapter(error),
      { strategy: "emergency-local", capacity: 2, periodMs: 60_000 },
      { fallback: new MemoryRateLimitAdapter({ now: () => new Date(0) }) },
    );

    // Local capacity is shared across owners, and a fallback allocation creates no lease.
    await expect(adapter.allocateLeases("worker-a", [leaseRequest])).resolves.toEqual({
      admitted: true, source: "emergency-local", allocations: { [request.key]: { mode: "exact", remaining: 1 } },
    });
    await expect(adapter.allocateLeases("worker-b", [leaseRequest])).resolves.toMatchObject({ admitted: true });
    await expect(adapter.allocateLeases("worker-b", [leaseRequest])).resolves.toEqual({
      admitted: false, remaining: { [request.key]: 0 }, retryAt: new Date(30_000), source: "emergency-local",
    });
    await expect(adapter.returnLeases([{ key: request.key, leaseId: "previous-lease", remaining: 1 }]))
      .rejects.toBe(error);
  });
});

function failingAdapter(error: Error): PrunableRateLimitAdapter & LeasableRateLimitAdapter {
  return {
    reserve: async () => {
      throw error;
    },
    reserveMany: async () => {
      throw error;
    },
    reconcile: async () => {
      throw error;
    },
    inspectMany: async () => {
      throw error;
    },
    prune: async () => {
      throw error;
    },
    allocateLeases: async () => {
      throw error;
    },
    returnLeases: async () => {
      throw error;
    },
  };
}
