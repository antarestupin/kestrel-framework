import { expect, it, vi } from "vitest";
import { App } from "../../../app/index.js";
import { dep } from "../../../di/index.js";
import { throttlingConfigBase } from "../../configuration.js";
import { ThrottlingProvider } from "../../provider.js";
import { ThrottlingBackendUnavailableError } from "../../errors.js";
import type { RateLimitAdapter, RateLimitLeaseRequest } from "../../types.js";
import { BackendFailureRateLimitAdapter } from "../backend_failure/adapter.js";
import { RedisRateLimitAdapter } from "./adapter.js";
import { redisThrottling } from "./definition.js";

const reservation = { key: "quota", limit: 1, burst: 10, cost: 1, periodMs: 1_000 };
const leaseRequest = {
  ...reservation,
  coordination: { strategy: "leased", maxLeaseUnits: 4, maxOutstandingUnits: 8, guardBandUnits: 1, leaseMs: 1_000 },
} as const satisfies RateLimitLeaseRequest;

it("preserves absent pruning through every decorator and disposes no borrowed socket", async () => {
  const client = { eval: vi.fn(), destroy: vi.fn() };
  const connection = dep<typeof client>("dedicatedRedis");
  const factory = vi.fn(() => client);
  const app = new App({});
  app.container.registerFactory(connection.id, factory, { lifetime: "singleton" });
  app.register(new ThrottlingProvider(throttlingConfigBase.schema.parse({ namespace: "test" }), redisThrottling(connection)));
  app.prepareBootPlan([], "minimal");
  try {
    await app.start();
    expect(factory).not.toHaveBeenCalled();
    const adapter = app.container.resolve(dep<{ prune?: unknown }>("throttlingAdapter"));
    expect(adapter.prune).toBeUndefined();
    expect(JSON.stringify(app.catalog.scheduledTasks)).not.toContain("maintenance.throttling-prune");
  } finally { await app.dispose(); }
  expect(client.eval).not.toHaveBeenCalled();
  expect(client.destroy).not.toHaveBeenCalled();
});

it("classifies infrastructure errors without replay and honors bounded emergency policy", async () => {
  const failure = new Error("connection lost");
  const client = { eval: vi.fn().mockRejectedValue(failure) };
  const authoritative = new RedisRateLimitAdapter(client);
  const request = { key: "quota", limit: 1, burst: 1, cost: 1, periodMs: 60_000 };
  await expect(authoritative.reserve(request)).rejects.toBeInstanceOf(ThrottlingBackendUnavailableError);
  expect(client.eval).toHaveBeenCalledOnce();
  const fallback = new BackendFailureRateLimitAdapter(authoritative, { strategy: "emergency-local", capacity: 1, periodMs: 60_000 });
  await expect(fallback.reserve(request)).resolves.toMatchObject({ admitted: true, source: "emergency-local" });
  await expect(fallback.reserve(request)).resolves.toMatchObject({ admitted: false, source: "emergency-local" });
});

it("rejects malformed protocol replies and unsafe arithmetic", async () => {
  const client = { eval: vi.fn(async () => null) };
  const adapter = new RedisRateLimitAdapter(client);
  const request = { key: "quota", limit: 1, burst: 1, cost: 1, periodMs: 1_000 };
  await expect(adapter.reserve(request)).rejects.toThrow("Invalid Redis throttling result");
  client.eval.mockClear();
  await expect(adapter.reserve({ ...request, limit: 0 })).rejects.toThrow();
  await expect(adapter.reserve({ ...request, limit: Number.MIN_VALUE })).rejects.toThrow();
  await expect(adapter.reconcile([{ ...request, estimatedCost: 1, actualCost: Number.MAX_VALUE }])).rejects.toThrow("representable");
  expect(client.eval).not.toHaveBeenCalled();
});

it("projects leased deadlines conservatively despite server clock skew", async () => {
  const serverNow = Date.now() + 1_000_000;
  const client = { eval: vi.fn(async () => JSON.stringify({
    admitted: true, remaining: { quota: "6" }, returned: 0, retryDelayMs: "0", serverNow: String(serverNow), inspections: {},
    allocations: { quota: { mode: "lease", leaseId: "grant", units: "4", remaining: "6", expiresAt: String(serverNow + 1_000) } },
  })) };
  const adapter = new RedisRateLimitAdapter(client);
  const result = await adapter.allocateLeases("owner", [{
    key: "quota", limit: 1, burst: 10, cost: 1, periodMs: 1_000,
    coordination: { strategy: "leased", maxLeaseUnits: 4, maxOutstandingUnits: 8, guardBandUnits: 1, leaseMs: 1_000 },
  }]);
  if (!result.admitted || result.allocations.quota?.mode !== "lease") throw new Error("Expected a lease.");
  expect(result.allocations.quota.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  expect(result.allocations.quota.expiresAt.getTime()).toBeGreaterThan(Date.now());
});

it("treats empty reservation, reconciliation, inspection, and lease operations as no-ops", async () => {
  const client = { eval: vi.fn() };
  const adapter = new RedisRateLimitAdapter(client);

  await expect(adapter.reserveMany([])).resolves.toEqual({ admitted: true, remaining: {}, source: "authoritative" });
  await expect(adapter.reconcile([])).resolves.toEqual({});
  await expect(adapter.inspectMany([])).resolves.toEqual([]);
  await expect(adapter.allocateLeases("owner", [])).resolves.toEqual({ admitted: true, allocations: {} });
  await expect(adapter.returnLeases([])).resolves.toBe(0);
  expect(client.eval).not.toHaveBeenCalled();
});

it("rejects invalid settings, accounting, and lease inputs before touching Redis", async () => {
  const client = { eval: vi.fn() };
  const adapter = new RedisRateLimitAdapter(client);
  const grant = { key: reservation.key, leaseId: "grant", remaining: 1 };

  expect(() => new RedisRateLimitAdapter(client, { keyPrefix: "" })).toThrow("key prefixes cannot be empty");
  await expect(adapter.reconcile([{ ...reservation, actualCost: -1, estimatedCost: 1 }]))
    .rejects.toThrow("costs must be non-negative and finite");
  await expect(adapter.allocateLeases(" ", [leaseRequest])).rejects.toThrow("owner IDs cannot be empty");
  await expect(adapter.allocateLeases("owner", [leaseRequest], [{ ...grant, key: "another-quota" }]))
    .rejects.toThrow("matching returned keys");
  await expect(adapter.allocateLeases("owner", [{
    ...leaseRequest, coordination: { ...leaseRequest.coordination, maxOutstandingUnits: 2 },
  }])).rejects.toThrow("Invalid rate limit lease settings");
  await expect(adapter.returnLeases([grant, grant])).rejects.toThrow("duplicate returned rate limit leases");
  await expect(adapter.returnLeases([{ ...grant, remaining: -1 }])).rejects.toThrow("Invalid or duplicate");
  expect(client.eval).not.toHaveBeenCalled();
});

it("builds a Redis adapter without instrumentation and respects its configured prefix", async () => {
  const client = { eval: vi.fn(async () => JSON.stringify({
    admitted: true, remaining: { quota: 9 }, returned: 0, retryDelayMs: 0,
    serverNow: 0, inspections: {}, allocations: {},
  })) };
  const definition = redisThrottling(dep<typeof client>("redisConnection"), { keyPrefix: "custom:" });
  const resolver = vi.fn().mockReturnValue(client);
  const config = throttlingConfigBase.schema.parse({ namespace: "test" });
  const adapter: RateLimitAdapter = definition.create(resolver, { config });

  try {
    await expect(adapter.reserve(reservation)).resolves.toEqual({ admitted: true, remaining: 9, source: "authoritative" });
    expect(client.eval).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({
      keys: [`custom:{throttling}:${Buffer.from(reservation.key).toString("base64url")}`],
    }));
  } finally {
    await definition.dispose?.(adapter);
  }
});
