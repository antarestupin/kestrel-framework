import { expect, it, vi } from "vitest";

it("decodes both Redis lease reply variants and rejects unknown allocations", async () => {
  // Load the protocol schema inside the test so malformed static variants fail here.
  vi.resetModules();
  const { RedisRateLimitAdapter } = await import("./adapter.js");
  const reply = { admitted: true, remaining: { quota: "6" }, returned: 0, retryDelayMs: "0", serverNow: "20000", inspections: {} };
  const evaluate = vi.fn<ConstructorParameters<typeof RedisRateLimitAdapter>[0]["eval"]>()
    .mockResolvedValueOnce(JSON.stringify({ ...reply, allocations: { quota: { mode: "exact", remaining: "6" } } }))
    .mockResolvedValueOnce(JSON.stringify({ ...reply, allocations: { quota: { mode: "lease", remaining: "6", leaseId: "grant", units: "4", expiresAt: "80000" } } }))
    .mockResolvedValueOnce(JSON.stringify({ ...reply, allocations: { quota: { mode: "unknown", remaining: "6" } } }));
  const adapter = new RedisRateLimitAdapter({ eval: evaluate });
  const request = { key: "quota", limit: 10, periodMs: 1_000, burst: 10, cost: 1,
    coordination: { strategy: "leased", maxLeaseUnits: 4, maxOutstandingUnits: 8, guardBandUnits: 1, leaseMs: 1_000 } } as const;

  await expect(adapter.allocateLeases("owner", [request])).resolves.toEqual({ admitted: true, allocations: { quota: { mode: "exact", remaining: 6 } } });
  await expect(adapter.allocateLeases("owner", [request])).resolves.toEqual({ admitted: true,
    allocations: { quota: { mode: "lease", remaining: 6, leaseId: "grant", units: 4, expiresAt: expect.any(Date) } } });
  await expect(adapter.allocateLeases("owner", [request])).rejects.toThrow();
});

it("validates decimal and scientific strings from the Redis protocol before coercion", async () => {
  vi.resetModules();
  const { RedisRateLimitAdapter } = await import("./adapter.js");
  const reply = { admitted: true, returned: 0, retryDelayMs: "0", serverNow: "20000", inspections: {}, allocations: {} };
  const evaluate = vi.fn<ConstructorParameters<typeof RedisRateLimitAdapter>[0]["eval"]>();
  const adapter = new RedisRateLimitAdapter({ eval: evaluate });
  const request = { key: "quota", limit: 10, periodMs: 1_000, burst: 10, cost: 1 };

  for (const amount of ["1.25", "1e2", "1E+2", "1e-12"]) {
    evaluate.mockResolvedValueOnce(JSON.stringify({ ...reply, remaining: { quota: amount } }));
    await expect(adapter.reserve(request)).resolves.toMatchObject({ admitted: true, remaining: Number(amount) });
  }
  for (const amount of [" 1", "1 ", "0x12", "1e", "1e+", "Infinity"]) {
    evaluate.mockResolvedValueOnce(JSON.stringify({ ...reply, remaining: { quota: amount } }));
    await expect(adapter.reserve(request)).rejects.toThrow();
  }
});
