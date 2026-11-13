import { expect, it, vi } from "vitest";
import { App } from "../../../app/index.js";
import { dep } from "../../../di/index.js";
import { throttlingConfigBase } from "../../configuration.js";
import { ThrottlingProvider } from "../../provider.js";
import { ThrottlingBackendUnavailableError } from "../../errors.js";
import type { ThrottlingInstrumentationEvent } from "../../observations.js";
import type { RateLimitAdapter, RateLimitLeaseRequest } from "../../types.js";
import { BackendFailureRateLimitAdapter } from "../backend_failure/adapter.js";
import { RedisRateLimitAdapter } from "./adapter.js";
import { redisThrottling } from "./definition.js";

const reservation = { key: "quota", limit: 1, burst: 10, cost: 1, periodMs: 1_000 };
const leaseRequest = {
  ...reservation,
  coordination: { strategy: "leased", maxLeaseUnits: 4, maxOutstandingUnits: 8, guardBandUnits: 1, leaseMs: 1_000 },
} as const satisfies RateLimitLeaseRequest;
const response = { admitted: true, remaining: { quota: 9 }, returned: 0, retryDelayMs: 0,
  serverNow: 0, inspections: {}, allocations: {} };

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
  await expect(adapter.reserve({ ...request, limit: Number.MIN_VALUE })).rejects.toThrow("refill rates must be representable");
  await expect(adapter.reconcile([{ ...request, estimatedCost: 1, actualCost: Number.MAX_VALUE }])).rejects.toThrow("representable");
  const halfLimit = Number.MAX_VALUE / 2;
  await expect(adapter.reconcile([{ ...request, limit: halfLimit, periodMs: 1, burst: halfLimit, estimatedCost: 1, actualCost: Number.MAX_VALUE }]))
    .rejects.toThrow("refill deadlines must be representable");
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

it("subtracts the full Redis round trip and clamps an elapsed lease to the local clock", async () => {
  const evaluate = vi.fn().mockResolvedValueOnce(JSON.stringify({ ...response, serverNow: "20000",
    allocations: { quota: { mode: "lease", leaseId: "grant", units: 4, remaining: 6, expiresAt: "21000" } },
  })).mockResolvedValueOnce(JSON.stringify({ ...response, serverNow: "20000",
    allocations: { quota: { mode: "lease", leaseId: "expired", units: 4, remaining: 6, expiresAt: "20010" } },
  }));
  const adapter = new RedisRateLimitAdapter({ eval: evaluate });
  const wall = vi.spyOn(Date, "now").mockReturnValue(500);
  const monotonic = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(250)
    .mockReturnValueOnce(500).mockReturnValueOnce(750);
  try {
    await expect(adapter.allocateLeases("owner", [leaseRequest])).resolves.toEqual({ admitted: true,
      allocations: { quota: { mode: "lease", leaseId: "grant", units: 4, remaining: 6, expiresAt: new Date(1_250) } },
    });
    await expect(adapter.allocateLeases("owner", [leaseRequest])).resolves.toEqual({ admitted: true,
      allocations: { quota: { mode: "lease", leaseId: "expired", units: 4, remaining: 6, expiresAt: new Date(500) } },
    });
  } finally {
    monotonic.mockRestore();
    wall.mockRestore();
  }
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

it("forwards Redis lease observations and refunds unused capacity when the factory disposes", async () => {
  const evaluate = vi.fn().mockResolvedValueOnce(JSON.stringify({ ...response, serverNow: 20_000,
    allocations: { quota: { mode: "lease", leaseId: "grant", units: 4, remaining: 6, expiresAt: 80_000 } },
  })).mockResolvedValue(JSON.stringify({ ...response, returned: 1 }));
  const client = { eval: evaluate, destroy: vi.fn() };
  const definition = redisThrottling(dep<typeof client>("redisConnection"));
  const config = throttlingConfigBase.schema.parse({ namespace: "test" });
  const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
  const adapter = definition.create(vi.fn().mockReturnValue(client), { config, instrumentation: { record } });

  try {
    await expect(adapter.reserve(leaseRequest)).resolves.toEqual({ admitted: true, remaining: 3, source: "leased" });
    await definition.dispose?.(adapter);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[1]?.[1]?.arguments).toEqual([
      "return", JSON.stringify([{ key: "quota" }]), JSON.stringify([{ key: "quota", leaseId: "grant", remaining: 3 }]),
    ]);
    expect(record.mock.calls.map(([event]) => event.data)).toStrictEqual([
      { key: "quota", operation: "issue", units: 4, remaining: 4 },
      { key: "quota", operation: "consume", units: 1, remaining: 3 },
      { key: "quota", operation: "return", units: 3 },
    ]);
    expect(client.destroy).not.toHaveBeenCalled();
  } finally {
    await adapter.close?.();
  }
});

it("sends complete signatures and explicit accounting changes to the atomic Redis script", async () => {
  const evaluate = vi.fn<ConstructorParameters<typeof RedisRateLimitAdapter>[0]["eval"]>()
    .mockResolvedValue(JSON.stringify(response));
  const adapter = new RedisRateLimitAdapter({ eval: evaluate }, { keyPrefix: "quota:" });
  await adapter.reconcile([{ ...reservation, actualCost: 5, estimatedCost: 2 }]);
  await adapter.allocateLeases("worker", [leaseRequest], [{ key: "quota", leaseId: "spent", remaining: 0 }]);
  await adapter.returnLeases([
    { key: "quota", leaseId: "left", remaining: 1 },
    { key: "quota", leaseId: "right", remaining: 0 },
  ]);

  const commands = evaluate.mock.calls.map(([, options]) => options!);
  const keys = [`quota:{throttling}:${Buffer.from("quota").toString("base64url")}`];
  expect(commands.map((command) => command.keys)).toEqual([keys, keys, keys]);
  const decode = (index: number) => {
    const [mode, requests, returns] = commands[index]!.arguments!;
    return { mode, requests: JSON.parse(String(requests)), returns: JSON.parse(String(returns)) };
  };
  expect(decode(0)).toEqual({ mode: "reconcile", requests: [{ ...reservation,
    actualCost: 5, estimatedCost: 2, delta: 3, signature: JSON.stringify([1, 1_000, 10, "exact"]),
    leaseId: expect.any(String),
  }], returns: [] });
  expect(decode(1)).toEqual({ mode: "allocate", requests: [{ ...leaseRequest,
    delta: 0, signature: JSON.stringify([1, 1_000, 10, [4, 1_000, 8, 1]]), leaseId: expect.any(String),
  }], returns: [{ key: "quota", leaseId: "spent", remaining: 0 }] });
  expect(decode(2)).toEqual({ mode: "return", requests: [{ key: "quota" }], returns: [
    { key: "quota", leaseId: "left", remaining: 1 }, { key: "quota", leaseId: "right", remaining: 0 },
  ] });
});

it("decodes authoritative decisions, signed numeric values, and deterministic retry deadlines", async () => {
  const evaluate = vi.fn().mockResolvedValueOnce(JSON.stringify({ ...response, remaining: { quota: "9e0" } }))
    .mockResolvedValue(JSON.stringify({ ...response, admitted: false, remaining: { quota: "-1.25e+1" }, retryDelayMs: "2.5E+2" }));
  const adapter = new RedisRateLimitAdapter({ eval: evaluate });
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(2_000);
  try {
    await expect(adapter.reserveMany([reservation])).resolves.toEqual({ admitted: true, remaining: { quota: 9 }, source: "authoritative" });
    await expect(adapter.reserveMany([reservation])).resolves.toEqual({ admitted: false, remaining: { quota: -12.5 }, source: "authoritative", retryAt: new Date(2_250) });
    await expect(adapter.reserve(reservation)).resolves.toEqual({ admitted: false, remaining: -12.5, source: "authoritative", retryAt: new Date(2_250) });
    await expect(adapter.allocateLeases("worker", [leaseRequest])).resolves.toEqual({ admitted: false, remaining: { quota: -12.5 }, retryAt: new Date(2_250) });
  } finally {
    wallClock.mockRestore();
  }
});

it("rejects invalid numeric protocol values, allocation shapes, and conflicts without replay", async () => {
  const malformed = [
    { remaining: { quota: " 9" } }, { remaining: { quota: "9 " } }, { remaining: { quota: "9e999" } },
    { retryDelayMs: -1 }, { returned: 0.5 }, { returned: -1 }, { serverNow: "non-numeric" },
    { allocations: { quota: { mode: "exact", remaining: "invalid" } } },
    { allocations: { quota: { mode: "lease", leaseId: "grant", units: 0, remaining: 0, expiresAt: 1 } } },
  ];
  const evaluate = vi.fn();
  const adapter = new RedisRateLimitAdapter({ eval: evaluate });
  for (const override of malformed) {
    evaluate.mockResolvedValueOnce(JSON.stringify({ ...response, ...override }));
    await expect(adapter.reserve(reservation)).rejects.toThrow();
  }
  evaluate.mockResolvedValueOnce(JSON.stringify({ conflict: "quota" }));
  await expect(adapter.reserve(reservation)).rejects.toMatchObject({ name: "ThrottlingDefinitionConflictError", key: "quota" });
  const cause = new Error("connection reset after write");
  evaluate.mockRejectedValueOnce(cause);
  await expect(adapter.reserve(reservation)).rejects.toMatchObject({ name: "ThrottlingBackendUnavailableError", cause });
  expect(evaluate).toHaveBeenCalledTimes(malformed.length + 2);
});

it("rejects invalid requests for every Redis operation and accepts lease cap boundaries", async () => {
  const evaluate = vi.fn().mockResolvedValue(JSON.stringify({ ...response, allocations: { quota: { mode: "exact", remaining: 0 } } }));
  const adapter = new RedisRateLimitAdapter({ eval: evaluate });
  for (const change of [{ key: "" }, { limit: -1 }, { periodMs: Infinity }, { burst: 0 }, { cost: NaN }, { cost: 0 }, { cost: 11 }]) {
    await expect(adapter.reserve({ ...reservation, ...change })).rejects.toThrow("Invalid rate limit request");
  }
  await expect(adapter.reserveMany([reservation, reservation])).rejects.toThrow("must be unique");
  await expect(adapter.reconcile([{ ...reservation, key: "", estimatedCost: 1, actualCost: 1 }])).rejects.toThrow("Invalid rate limit request");
  await expect(adapter.inspectMany([{ ...reservation, key: "" }])).rejects.toThrow("Invalid rate limit request");
  await expect(adapter.allocateLeases("worker", [leaseRequest], [{ key: "quota", leaseId: "", remaining: 1 }])).rejects.toThrow("Invalid or duplicate");
  await expect(adapter.returnLeases([{ key: "", leaseId: "grant", remaining: 1 }])).rejects.toThrow("Invalid or duplicate");
  await expect(adapter.returnLeases([{ key: "quota", leaseId: "grant", remaining: Infinity }])).rejects.toThrow("Invalid or duplicate");
  await expect(adapter.reserve({ ...reservation, limit: Number.MAX_VALUE, periodMs: Number.MIN_VALUE })).rejects.toThrow("refill rates must be representable");
  await expect(adapter.reserve({ ...reservation, limit: 1, burst: 9e12, periodMs: 1_000 })).rejects.toThrow("refill deadlines must be representable");
  await expect(adapter.reconcile([{ ...reservation, actualCost: 1e13, estimatedCost: 1 }])).rejects.toThrow("refill deadlines must be representable");
  await expect(Reflect.apply(adapter.allocateLeases, adapter, ["worker", [leaseRequest, {
    ...reservation, key: "exact", coordination: { strategy: "exact" },
  }]])).rejects.toThrow("requires leased coordination");
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(2_000);
  const maximumLease = 8_640_000_000_000_000 - 2_000;
  try {
    for (const change of [{ maxLeaseUnits: 0 }, { maxLeaseUnits: 11, maxOutstandingUnits: 11 }, { leaseMs: 0.5 },
      { leaseMs: maximumLease + 1 }, { guardBandUnits: NaN }, { guardBandUnits: -1 }]) {
      await expect(adapter.allocateLeases("worker", [{ ...leaseRequest, coordination: { ...leaseRequest.coordination, ...change } }]))
        .rejects.toThrow("Invalid rate limit lease settings");
    }
    expect(evaluate).not.toHaveBeenCalled();
    await expect(adapter.allocateLeases("worker", [{ ...leaseRequest, cost: 10,
      coordination: { strategy: "leased", maxLeaseUnits: 10, maxOutstandingUnits: 10, guardBandUnits: 0, leaseMs: maximumLease },
    }])).resolves.toEqual({ admitted: true, allocations: { quota: { mode: "exact", remaining: 0 } } });
    await expect(adapter.reserve({ ...reservation, burst: maximumLease, periodMs: 1 })).resolves.toMatchObject({ admitted: true });
    await expect(adapter.allocateLeases("worker", [leaseRequest, { ...leaseRequest, key: "other" }], [
      { key: "quota", leaseId: "spent", remaining: 0 },
    ])).resolves.toMatchObject({ admitted: true });
  } finally {
    wallClock.mockRestore();
  }
});
