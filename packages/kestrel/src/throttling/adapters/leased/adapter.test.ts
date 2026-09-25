import { describe, expect, it, vi } from "vitest";

import type {
  LeasableRateLimitAdapter,
  RateLimitLeaseRequest,
} from "../../types.js";
import { LeasedRateLimitAdapter } from "./adapter.js";

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

describe("LeasedRateLimitAdapter", () => {
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
