import { expect, it, vi } from "vitest";
import { App } from "../../../app/index.js";
import { dep } from "../../../di/index.js";
import { throttlingConfigBase } from "../../configuration.js";
import { ThrottlingProvider } from "../../provider.js";
import { ThrottlingBackendUnavailableError } from "../../errors.js";
import { BackendFailureRateLimitAdapter } from "../backend_failure/adapter.js";
import { RedisRateLimitAdapter } from "./adapter.js";
import { redisThrottling } from "./definition.js";

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
