import { describe, expect, it } from "vitest";

import type {
  RateLimitAdapter,
  RateLimitReservationRequest,
} from "../../types.js";
import { DenialCachingRateLimitAdapter } from "./adapter.js";

const request: RateLimitReservationRequest = {
  key: "test:partner",
  limit: 1,
  periodMs: 1_000,
  burst: 1,
  cost: 1,
};

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
});
