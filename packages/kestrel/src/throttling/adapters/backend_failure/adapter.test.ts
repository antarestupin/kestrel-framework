import { describe, expect, it } from "vitest";

import { ThrottlingBackendUnavailableError } from "../../errors.js";
import type {
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter,
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

    await expect(adapter.prune({ limit: 10 })).rejects.toBe(backendError);
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

  it("uses bounded emergency capacity when lease replenishment cannot reach PostgreSQL", async () => {
    const error = new ThrottlingBackendUnavailableError({
      cause: new Error("database unavailable"),
    });
    const authoritative = {
      ...failingAdapter(error),
      allocateLeases: async () => { throw error; },
      returnLeases: async () => { throw error; },
    } satisfies PrunableRateLimitAdapter & LeasableRateLimitAdapter;
    const adapter = new BackendFailureRateLimitAdapter(
      authoritative,
      { strategy: "emergency-local", capacity: 2, periodMs: 60_000 },
      { fallback: new MemoryRateLimitAdapter({ now: () => new Date(0) }) },
    );
    const leased = {
      ...request,
      coordination: {
        strategy: "leased",
        maxLeaseUnits: 2,
        leaseMs: 1_000,
        maxOutstandingUnits: 2,
        guardBandUnits: 0,
      },
    } as const satisfies RateLimitLeaseRequest;

    await expect(adapter.allocateLeases("worker-a", [leased]))
      .resolves.toMatchObject({
        admitted: true,
        source: "emergency-local",
        allocations: {
          [request.key]: { mode: "exact" },
        },
      });
  });
});

function failingAdapter(error: Error): PrunableRateLimitAdapter {
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
  };
}
