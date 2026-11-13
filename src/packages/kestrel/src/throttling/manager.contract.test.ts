import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  circuitBreaker,
  concurrencyLimit,
  defineAdmissionPolicy,
  defineRateLimit,
  localResourcePressure,
  LocalResourcePressureMonitor,
  MemoryRateLimitAdapter,
  rateLimit,
  seconds,
  ThrottlingAcquisitionAbortedError,
  ThrottlingAdapterCapabilityError,
  ThrottlingBackendUnavailableError,
  ThrottlingCostExceedsBurstError,
  ThrottlingCostValidationError,
  ThrottlingManager,
  ThrottlingPermitCompletedError,
  ThrottlingRejectedError,
  type RateLimitAdapter,
  type ThrottlingInstrumentationEvent,
  type ThrottlingManagerOptions,
  type ThrottlingRunContext,
} from "./index.js";

const simple = defineRateLimit({ id: "single-rate", requests: 1, per: seconds(1) });
const quota = rateLimit({ id: "shared-rate", unit: "requests", limit: 10, per: seconds(1) });
const slots = concurrencyLimit({ id: "shared-slots", limit: 1 });
const concurrencyOnly = defineAdmissionPolicy({ id: "local-work", limits: [slots] });
const metered = defineAdmissionPolicy({
  id: "metered-work",
  limits: [quota, slots],
  costAccounting: { reconciliation: "synchronous" },
});
const ownedManagers = new Set<ThrottlingManager>();

afterEach(async () => {
  const managers = [...ownedManagers];
  ownedManagers.clear();
  await Promise.all(managers.map((manager) => manager.close()));
});

function createManager(adapter: RateLimitAdapter, options: Partial<ThrottlingManagerOptions> = {}): ThrottlingManager {
  const manager = new ThrottlingManager(adapter, { namespace: "test", now: () => new Date(0), ...options });
  ownedManagers.add(manager);
  return manager;
}

describe("ThrottlingManager teardown contracts", () => {
  it("closes the other pressure readers and its backend after a reader fails", async () => {
    const failure = new Error("pressure reader teardown failed");
    const first = vi.fn(() => { throw failure; });
    const second = vi.fn();
    const monitor = new LocalResourcePressureMonitor([
      { supports: () => false, read: () => undefined, close: first },
      { supports: () => false, read: () => undefined, close: second },
    ]);
    const close = vi.fn(async () => {});
    const manager = new ThrottlingManager({ reserve: vi.fn(), close }, {
      namespace: "test", resourcePressureMonitor: monitor,
    });

    const closing = manager.close();
    await expect(closing).rejects.toBe(failure);
    expect(manager.close()).toBe(closing);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("drains pending accounting and preserves independent reader and backend close failures", async () => {
    const readerError = new Error("pressure reader teardown failed");
    const storageError = new Error("storage teardown failed");
    const accounting = Promise.withResolvers<Readonly<Record<string, number>>>();
    const monitor = new LocalResourcePressureMonitor([
      { supports: () => false, read: () => undefined, close: () => { throw readerError; } },
    ]);
    const reconcile = vi.fn<NonNullable<RateLimitAdapter["reconcile"]>>().mockReturnValue(accounting.promise);
    const close = vi.fn<NonNullable<RateLimitAdapter["close"]>>().mockRejectedValue(storageError);
    const manager = new ThrottlingManager({ reserve: async () => ({ admitted: true, remaining: 9 }), reconcile, close }, {
      namespace: "test", resourcePressureMonitor: monitor,
    });
    const deferred = defineAdmissionPolicy({ id: "deferred-on-close", limits: [quota], costAccounting: { reconciliation: "asynchronous" } });

    try {
      const permit = await manager.acquire(deferred, { estimatedCost: { requests: 1 } });
      const completed = vi.fn();
      void permit.complete({ outcome: "success", actualCost: { requests: 2 } }).then(completed, completed);
      // Completion must not await the deferred storage promise.
      await setImmediate();
      expect(completed).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(reconcile).toHaveBeenCalledOnce();
      const settled = vi.fn();
      const closing = manager.close();
      void closing.then(settled, settled);
      // Closing storage before the deferred write settles would lose actual-cost accounting.
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      accounting.resolve({ [quota.id]: 8 });
      await expect(closing).rejects.toMatchObject({ name: "AggregateError", message: "Throttling manager teardown failed.", errors: [readerError, storageError] });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      accounting.resolve({});
      await manager.close().catch(() => undefined);
    }
  });
});

describe("ThrottlingManager inspection contracts", () => {
  it("requires inspection support without attempting a reservation", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const manager = createManager({ reserve });

    await expect(manager.inspect(simple)).rejects.toMatchObject({ capability: "advisory inspection" });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rejects incomplete inspection batches and preserves unexpected adapter failures", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const failure = new Error("invalid adapter state");
    const inspectMany = vi.fn<NonNullable<RateLimitAdapter["inspectMany"]>>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(failure);
    const manager = createManager({ reserve, inspectMany });

    // A partial backend reply cannot be interpreted as an available policy.
    await expect(manager.inspect(simple)).rejects.toThrow("returned an incomplete inspection");
    await expect(manager.inspect(simple)).rejects.toBe(failure);
    expect(inspectMany).toHaveBeenCalledTimes(2);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("retains a denial without a known retry time when another rate gives a deadline", async () => {
    const alternate = rateLimit({ id: "alternate-rate", unit: "requests", limit: 20, per: seconds(2) });
    const shorter = rateLimit({ id: "shorter-rate", unit: "requests", limit: 40, per: seconds(1) });
    const policy = defineAdmissionPolicy({ id: "multiple-rates", limits: [quota, alternate, shorter] });
    const inspectMany = vi.fn<NonNullable<RateLimitAdapter["inspectMany"]>>().mockResolvedValue([
      { available: false, remaining: 0 },
      { available: false, remaining: 0.5, retryAt: new Date(200) },
      { available: false, remaining: 0, retryAt: new Date(100) },
    ]);
    const manager = createManager({ reserve: vi.fn<RateLimitAdapter["reserve"]>(), inspectMany });

    await expect(manager.inspect(policy, { estimatedCost: { requests: 1 } })).resolves.toStrictEqual({
      state: "limited",
      retryAt: new Date(200),
      reasons: [
        { kind: "rate", constraintId: quota.id, remaining: 0 },
        { kind: "rate", constraintId: alternate.id, remaining: 0.5, retryAt: new Date(200) },
        { kind: "rate", constraintId: shorter.id, remaining: 0, retryAt: new Date(100) },
      ],
    });
  });

  it("rejects another acquisition at capacity and keeps independent limits separate", async () => {
    const manager = createManager(new MemoryRateLimitAdapter());
    const independent = defineAdmissionPolicy({
      id: "independent-work",
      limits: [concurrencyLimit({ id: "independent-slots", limit: 2 })],
    });
    const blocked = vi.fn();
    const held = await manager.acquire(concurrencyOnly);
    try {
      // Test the admission decision itself while its only slot is still occupied.
      await expect(manager.run(concurrencyOnly, blocked)).rejects.toBeInstanceOf(ThrottlingRejectedError);
      expect(blocked).not.toHaveBeenCalled();
      await expect(manager.run(independent, () => "independent")).resolves.toBe("independent");
    } finally {
      await held.complete({ outcome: "success" });
    }
    await expect(manager.run(concurrencyOnly, () => "released")).resolves.toBe("released");
  });

  it("inspects zero cost locally while retaining concurrency and pressure reasons", async () => {
    const monitor = new LocalResourcePressureMonitor([{
      supports: (id) => id === "cpu",
      read: () => 0.85,
    }]);
    const pressure = localResourcePressure({ id: "process-pressure", signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } } });
    const pressured = defineAdmissionPolicy({ id: "pressured-work", limits: [quota, pressure] });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const inspectMany = vi.fn<NonNullable<RateLimitAdapter["inspectMany"]>>();
    const manager = createManager({ reserve, inspectMany }, { resourcePressureMonitor: monitor });
    const options = { estimatedCost: { requests: 0 } };

    await expect(manager.inspect(metered, options)).resolves.toEqual({ state: "available", reasons: [] });
    const held = await manager.acquire(concurrencyOnly);
    try {
      await expect(manager.inspect(metered, options)).resolves.toEqual({
        state: "limited", reasons: [{ kind: "concurrency", constraintId: slots.id }],
      });
    } finally {
      await held.complete({ outcome: "success" });
    }
    await expect(manager.inspect(pressured, options)).resolves.toEqual({
      state: "degraded", reasons: [{ kind: "pressure", constraintId: pressure.id, signalId: "cpu", value: 0.85 }],
    });
    expect(inspectMany).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("does not need an inspection capability when every rate dimension has zero cost", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const manager = createManager({ reserve });
    await expect(manager.inspect(metered, { estimatedCost: { requests: 0 } }))
      .resolves.toEqual({ state: "available", reasons: [] });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("identifies only the requested rate dimensions when inspection storage is offline", async () => {
    const tokens = rateLimit({ id: "token-quota", unit: "tokens", limit: 20, per: seconds(1) });
    const policy = defineAdmissionPolicy({ id: "partial-inspection", limits: [quota, tokens] });
    const inspectMany = vi.fn<NonNullable<RateLimitAdapter["inspectMany"]>>()
      .mockRejectedValue(new ThrottlingBackendUnavailableError({ cause: new Error("offline") }));
    const manager = createManager({ reserve: vi.fn<RateLimitAdapter["reserve"]>(), inspectMany });

    await expect(manager.inspect(policy, { estimatedCost: { requests: 1, tokens: 0 } })).resolves.toEqual({
      state: "unknown", reasons: [{ kind: "rate", constraintId: quota.id }],
    });
    expect(inspectMany).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ key: `test:${quota.id}`, cost: 1 })]);
  });
});

describe("ThrottlingManager instrumentation contracts", () => {
  it("reports wait budget, cost, constraints, and backend quota without obscuring immediate denials", async () => {
    const tokens = rateLimit({ id: "token-limit", unit: "tokens", limit: 20, per: seconds(1) });
    const breaker = circuitBreaker({ id: "remote-service", failureThreshold: 2, cooldown: seconds(1) });
    const pressure = localResourcePressure({ id: "host-pressure", signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } } });
    const policy = defineAdmissionPolicy({ id: "observed-policy", limits: [quota, tokens, slots, breaker, pressure] });
    const monitor = new LocalResourcePressureMonitor([{ supports: (id) => id === "cpu", read: () => 0 }]);
    let ticks = 10;
    const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>()
      .mockImplementationOnce(async () => {
        ticks += 4;
        return { admitted: true, remaining: { "test:shared-rate": 8, "test:token-limit": 2 }, source: "emergency-local" };
      })
      .mockImplementationOnce(async () => {
        ticks += 4;
        return { admitted: false, remaining: { "test:shared-rate": 6, "test:token-limit": 1 }, retryAt: new Date(25), source: "authoritative" };
      });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const manager = createManager({ reserve, reserveMany }, {
      namespace: " test ", resourcePressureMonitor: monitor,
      monotonicNow: () => ticks, instrumentation: { record },
      // A healthy sample admits work before the configured wait can begin.
      sleep: async () => { throw new Error("Unexpected pressure wait before reservation."); },
    });
    const estimatedCost = { tokens: 3, requests: 2 };
    const longestAllowedKey = "k".repeat(256);

    const permit = await manager.acquire(policy, { estimatedCost, maxWaitMs: 100 });
    expect(record).toHaveBeenLastCalledWith({
      type: "acquisition", durationMs: 4, outcome: "success",
      data: { key: policy.id, mode: "wait", result: "acquired", cost: 5, estimatedCost,
        constraints: 5, attempts: 1, remaining: 2, source: "emergency-local", waitTimeoutMs: 100 },
    });
    await permit.complete({ outcome: "success" });
    await expect(manager.acquire(policy, { estimatedCost })).rejects.toMatchObject({ source: "authoritative", remaining: 1 });
    expect(record).toHaveBeenLastCalledWith({
      type: "acquisition", durationMs: 4, outcome: "failure",
      data: { key: policy.id, mode: "immediate", result: "rejected", cost: 5, estimatedCost,
        constraints: 5, attempts: 1, remaining: 1, source: "authoritative", retryAt: new Date(25).toISOString() },
    });

    expect(reserveMany).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ key: "test:shared-rate", cost: 2 }),
      expect.objectContaining({ key: "test:token-limit", cost: 3 }),
    ]);
    reserve.mockResolvedValue({ admitted: true, remaining: 0 });
    await manager.run(simple, { rateKey: longestAllowedKey }, () => "ok");
    expect(reserve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: `test:${simple.id}:${longestAllowedKey}` }));
    expect(record.mock.calls.map(([event]) => event).findLast((event) => event.type === "acquisition")?.data).toStrictEqual({
      key: simple.id, mode: "immediate", result: "acquired", cost: 1, estimatedCost: { requests: 1 },
      constraints: 1, attempts: 1, remaining: 0,
    });

    await manager.run(concurrencyOnly, () => "local");
    expect(record.mock.calls.map(([event]) => event).findLast((event) => event.type === "acquisition")?.data).toStrictEqual({
      key: concurrencyOnly.id, mode: "immediate", result: "acquired", cost: 0, estimatedCost: {},
      constraints: 1, attempts: 1, source: "local",
    });
  });

  it("keeps a callable handler's own properties out of run options", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: true, remaining: 0 });
    const manager = createManager({ reserve });
    const handler = Object.assign(vi.fn(() => "handled"), { rateKey: "plugin-metadata", maxWaitMs: -1 });

    // A JavaScript callback may carry fields that happen to share option names.
    await expect(manager.run(simple, handler)).resolves.toBe("handled");
    expect(reserve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: `test:${simple.id}`, cost: 1 }));
  });

  it("reports only actionable pressure signals, including transitions from observed health", async () => {
    let time = 0;
    const values: Record<string, number | undefined> = { benign: 0, cpu: 0, rss: 0, missing: 0, spare: 0 };
    const monitor = new LocalResourcePressureMonitor([{
      supports: (id) => id in values,
      read: (id) => values[id],
    }], {
      now: () => new Date(time), monotonicNow: () => time,
      healthyIntervalMs: 10, nearThresholdIntervalMs: 10, pressuredIntervalMs: 10,
    });
    const thresholds = { degradedAt: 0.8, limitedAt: 0.9 };
    const optional = localResourcePressure({ id: "optional-pressure", signals: { benign: thresholds, missing: thresholds, rss: thresholds }, onUnavailable: "ignore" });
    const required = localResourcePressure({ id: "required-pressure", signals: { benign: thresholds, cpu: thresholds, spare: thresholds } });
    const policy = defineAdmissionPolicy({ id: "pressure-policy", limits: [optional, required] });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const manager = createManager({ reserve }, { now: () => new Date(time), resourcePressureMonitor: monitor, instrumentation: { record } });

    await expect(manager.inspect(policy)).resolves.toEqual({ state: "available", reasons: [] });
    expect(record).not.toHaveBeenCalled();
    Object.assign(values, { missing: undefined, rss: 0.85 });
    time += 10;
    await expect(manager.inspect(policy)).resolves.toStrictEqual({ state: "degraded", reasons: [
      { constraintId: optional.id, kind: "pressure", signalId: "missing" },
      { constraintId: optional.id, kind: "pressure", signalId: "rss", value: 0.85 },
    ] });
    expect(record.mock.calls.map(([event]) => event)).toStrictEqual([
      { type: "pressure", durationMs: 0, outcome: "failure", data: { key: `test:${optional.id}`, operation: "transition", signal: "missing", state: "unknown", previousState: "healthy" } },
      { type: "pressure", durationMs: 0, outcome: "success", data: { key: `test:${optional.id}`, operation: "transition", signal: "rss", state: "degraded", previousState: "healthy", value: 0.85 } },
    ]);

    Object.assign(values, { cpu: 0.9, spare: undefined });
    time += 10;
    record.mockClear();
    await expect(manager.inspect(policy)).resolves.toStrictEqual({ state: "unknown", reasons: [
      { constraintId: required.id, kind: "pressure", signalId: "cpu", value: 0.9 },
      { constraintId: required.id, kind: "pressure", signalId: "spare" },
    ] });
    expect(record.mock.calls.map(([event]) => event)).toStrictEqual([
      { type: "pressure", durationMs: 0, outcome: "failure", data: { key: `test:${required.id}`, operation: "transition", signal: "cpu", state: "limited", previousState: "healthy", value: 0.9 } },
      { type: "pressure", durationMs: 0, outcome: "failure", data: { key: `test:${required.id}`, operation: "transition", signal: "spare", state: "unknown", previousState: "healthy" } },
    ]);
    record.mockClear();
    await expect(manager.acquire(policy)).rejects.toMatchObject({ constraintId: required.id, signalIds: ["cpu", "spare"] });
    expect(record.mock.calls.map(([event]) => event).filter((event) => event.type === "pressure")).toStrictEqual([
      { type: "pressure", durationMs: 0, outcome: "failure", data: { key: `test:${required.id}`, operation: "rejection", signal: "cpu", state: "limited", value: 0.9 } },
      { type: "pressure", durationMs: 0, outcome: "failure", data: { key: `test:${required.id}`, operation: "rejection", signal: "spare", state: "unknown" } },
    ]);
    expect(reserve).not.toHaveBeenCalled();

    Object.assign(values, { spare: 0 });
    time += 10;
    await expect(manager.inspect(policy)).resolves.toEqual({ state: "limited", reasons: [
      { constraintId: required.id, kind: "pressure", signalId: "cpu", value: 0.9 },
    ] });
    await expect(manager.acquire(policy)).rejects.toMatchObject({ constraintId: required.id, signalIds: ["cpu"], source: "local" });

    // A fail-open reader remains advisory even when another signal in its group blocks admission.
    Object.assign(values, { rss: 0.95 });
    time += 10;
    const optionalOnly = defineAdmissionPolicy({ id: "optional-only", limits: [optional] });
    record.mockClear();
    await expect(manager.acquire(optionalOnly)).rejects.toMatchObject({ constraintId: optional.id, signalIds: ["rss"] });
    const rejected = record.mock.calls.map(([event]) => event)
      .filter((event) => event.type === "pressure" && event.data.operation === "rejection");
    expect(rejected.map((event) => event.data)).toStrictEqual([
      { key: `test:${optional.id}`, operation: "rejection", signal: "rss", state: "limited", value: 0.95 },
    ]);
  });
});

describe("ThrottlingManager reconciliation contracts", () => {
  it("returns the accounting error when a successful operation cannot reconcile", async () => {
    const failure = new Error("cost storage unavailable");
    const reconcile = vi.fn<NonNullable<RateLimitAdapter["reconcile"]>>().mockRejectedValue(failure);
    const manager = createManager({
      reserve: async () => ({ admitted: true, remaining: 9 }),
      reconcile,
    });
    const operation = vi.fn((context: ThrottlingRunContext) => {
      context.reportActualCost({ requests: 2 });
      return "success";
    });

    // A failure after the operation completes cannot replay the operation or charge it twice.
    await expect(manager.run(metered, { estimatedCost: { requests: 1 } }, operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    const next = await manager.acquire(concurrencyOnly);
    await next.complete({ outcome: "success" });
  });

  it("does not turn an undefined reconciliation rejection into a successful operation", async () => {
    const reconcile = vi.fn<NonNullable<RateLimitAdapter["reconcile"]>>().mockRejectedValue(undefined);
    const record = vi.fn();
    const manager = createManager({ reserve: async () => ({ admitted: true, remaining: 9 }), reconcile }, { instrumentation: { record } });
    const result = manager.run(metered, { estimatedCost: { requests: 1 } }, (context) => {
      context.reportActualCost({ requests: 2 });
      return "completed";
    });

    await expect(result).rejects.toBeUndefined();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "completion", outcome: "failure", data: expect.objectContaining({ reconciliation: "failed" }),
    }));
    const next = await manager.acquire(concurrencyOnly);
    await next.complete({ outcome: "success" });
  });

  it("rejects duplicate reports and retains both operation and reconciliation failures", async () => {
    const operationError = new Error("dependency failed");
    const reconciliationError = new Error("cost storage unavailable");
    const reconcile = vi.fn<NonNullable<RateLimitAdapter["reconcile"]>>().mockRejectedValue(reconciliationError);
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = createManager({
      reserve: async () => ({ admitted: true, remaining: 9 }),
      reconcile,
    }, { instrumentation: { record: (event) => events.push(event) } });

    await expect(manager.run(metered, { estimatedCost: { requests: 1 } }, (context) => {
      context.reportActualCost({ requests: 2 });
      expect(() => context.reportActualCost({ requests: 3 })).toThrow("can only be reported once");
      context.reportFeedback({ kind: "timeout" });
      expect(() => context.reportFeedback({ kind: "permanent" })).toThrow("can only be reported once");
      throw operationError;
    })).rejects.toMatchObject({ name: "AggregateError", errors: [operationError, reconciliationError],
      message: `Throttled operation and permit completion both failed for "${metered.id}".`,
    });

    // The original reports survive duplicate attempts and accompany the failure.
    expect(reconcile).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ key: `test:${quota.id}`, estimatedCost: 1, actualCost: 2 }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completion", outcome: "failure",
      data: { actualCost: { requests: 2 }, feedback: "timeout", reconciliation: "failed" },
    });
    const next = await manager.acquire(concurrencyOnly);
    await next.complete({ outcome: "success" });
  });

  it("retains independent completion errors even when an adapter uses the permit error class", async () => {
    const operationError = new Error("dependency failed");
    const completionError = new ThrottlingPermitCompletedError("adapter-owned-permit");
    const reconcile = vi.fn<NonNullable<RateLimitAdapter["reconcile"]>>().mockRejectedValue(completionError);
    const manager = createManager({ reserve: async () => ({ admitted: true, remaining: 9 }), reconcile });

    await expect(manager.run(metered, { estimatedCost: { requests: 1 } }, (context) => {
      context.reportActualCost({ requests: 2 });
      throw operationError;
    })).rejects.toMatchObject({ name: "AggregateError", errors: [operationError, completionError] });
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("reconciles zero estimated cost and skips adjustment for an unchanged estimate", async () => {
    const storage = new MemoryRateLimitAdapter({ now: () => new Date(0) });
    const reserve = vi.spyOn(storage, "reserve");
    const reconcile = vi.spyOn(storage, "reconcile");
    const manager = createManager(storage);
    const zeroEstimate = await manager.acquire(metered, { estimatedCost: { requests: 0 } });
    expect(reserve).not.toHaveBeenCalled();
    await zeroEstimate.complete({ outcome: "success", actualCost: { requests: 2 } });

    expect(reconcile).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ cost: Number.EPSILON, estimatedCost: 0, actualCost: 2 }),
    ]);
    const exact = await manager.acquire(metered, { estimatedCost: { requests: 1 } });
    await exact.complete({ outcome: "success", actualCost: { requests: 1 } });
    expect(reconcile).toHaveBeenCalledOnce();
    await expect(manager.inspect(metered, { estimatedCost: { requests: 8 } })).resolves.toMatchObject({
      state: "limited", reasons: [{ kind: "rate", constraintId: quota.id, remaining: 7 }],
    });
  });

  it("reports unavailable reconciliation support and still releases concurrency", async () => {
    const manager = createManager({ reserve: async () => ({ admitted: true, remaining: 9 }) });
    const permit = await manager.acquire(metered, { estimatedCost: { requests: 1 } });

    await expect(permit.complete({ outcome: "success", actualCost: { requests: 2 } }))
      .rejects.toMatchObject({ capability: "cost reconciliation" });
    const next = await manager.acquire(concurrencyOnly);
    await next.complete({ outcome: "success" });
  });

  it("reports a failed deferred adjustment without changing the operation result", async () => {
    const reconcile = vi.fn<NonNullable<RateLimitAdapter["reconcile"]>>().mockRejectedValue(new Error("backend unavailable"));
    const close = vi.fn(async () => {});
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = createManager({ reserve: async () => ({ admitted: true, remaining: 9 }), reconcile, close }, {
      instrumentation: { record: (event) => events.push(event) },
    });
    const policy = defineAdmissionPolicy({ id: "deferred-cost", limits: [quota], costAccounting: { reconciliation: "asynchronous" } });

    await expect(manager.run(policy, { estimatedCost: { requests: 1 } }, (context) => {
      context.reportActualCost({ requests: 2 });
      return "completed";
    })).resolves.toBe("completed");
    await manager.close();
    expect(close).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: "reconciliation", outcome: "failure", data: expect.objectContaining({ result: "failed" }),
    }));
  });

  it("reconciles asynchronously once, retains reservation source, and reports work abandoned after close", async () => {
    const reconcile = vi.fn<NonNullable<RateLimitAdapter["reconcile"]>>().mockResolvedValue({ "test:shared-rate": 7 });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: true, remaining: 9, source: "emergency-local" });
    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const manager = createManager({ reserve, reconcile }, { instrumentation: { record }, monotonicNow: () => 0 });
    const policy = defineAdmissionPolicy({ id: "deferred-usage", limits: [quota], costAccounting: { reconciliation: "asynchronous" } });
    const estimatedCost = { requests: 1 };
    const actualCost = { requests: 3 };
    const first = await manager.acquire(policy, { estimatedCost });
    const late = await manager.acquire(policy, { estimatedCost });
    await first.complete({ outcome: "success", actualCost });
    await manager.close();

    expect(reconcile).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ key: `test:${quota.id}`, cost: 1, estimatedCost: 1, actualCost: 3, reservationSource: "emergency-local" }),
    ]);
    expect(record).toHaveBeenCalledWith({ type: "reconciliation", durationMs: 0, outcome: "success",
      data: { key: policy.id, result: "reconciled", estimatedCost, actualCost, constraints: 1 } });
    record.mockClear();
    await late.complete({ outcome: "success", actualCost });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({ type: "reconciliation", durationMs: 0, outcome: "failure",
      data: { key: policy.id, result: "failed", estimatedCost, actualCost, constraints: 1 } });
  });

  it("honors an explicit simple estimate and keeps simple reconciliation disabled", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: true, remaining: 0 });
    const reconcile = vi.fn<NonNullable<RateLimitAdapter["reconcile"]>>();
    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const manager = createManager({ reserve, reconcile }, { instrumentation: { record }, monotonicNow: () => 0 });
    const free = await manager.acquire(simple, { estimatedCost: { requests: 0 } });
    expect(reserve).not.toHaveBeenCalled();
    await free.complete({ outcome: "success" });
    expect(record.mock.lastCall?.[0]).toStrictEqual({ type: "completion", outcome: "success", durationMs: 0, data: {
      key: simple.id, result: "success", cost: 0, estimatedCost: { requests: 0 }, actualCost: { requests: 0 },
      reconciliation: "not-needed", heldDurationMs: 0,
    } });

    const paid = await manager.acquire(simple);
    await paid.complete({ outcome: "success", actualCost: { requests: 0 } });
    expect(reserve).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(record).toHaveBeenLastCalledWith({ type: "completion", outcome: "success", durationMs: 0, data: {
      key: simple.id, result: "success", cost: 0, estimatedCost: { requests: 1 }, actualCost: { requests: 0 },
      reconciliation: "disabled", heldDurationMs: 0,
    } });

    const unchanged = await manager.acquire(simple);
    await unchanged.complete({ outcome: "success", actualCost: { requests: 1 } });
    // An explicit matching actual cost requires no accounting operation.
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ type: "completion", data: expect.objectContaining({
      reconciliation: "not-needed", estimatedCost: { requests: 1 }, actualCost: { requests: 1 },
    }) }));
  });
});

describe("ThrottlingManager admission validation", () => {
  it.each([
    { namespace: "  ", error: "namespaces cannot be empty" },
    { namespace: "application:process", error: "namespaces cannot contain colons" },
    { namespace: "test", maxPendingAcquisitions: -1, error: "must be a non-negative integer" },
    { namespace: "test", maxPendingAcquisitions: 0.5, error: "must be a non-negative integer" },
  ])("rejects invalid manager settings $error", ({ error, ...options }) => {
    expect(() => new ThrottlingManager(new MemoryRateLimitAdapter(), options)).toThrow(error);
  });

  it("validates waiting, caller keys and costs before touching the rate backend", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const manager = createManager({ reserve });

    for (const maxWaitMs of [-1, Number.POSITIVE_INFINITY]) {
      await expect(manager.acquire(simple, { maxWaitMs })).rejects.toThrow("maxWaitMs must be a non-negative finite number");
    }
    for (const rateKey of ["   ", "x".repeat(257)]) {
      await expect(manager.acquire(simple, { rateKey })).rejects.toThrow("rate keys must contain between 1 and 256 characters");
    }
    await expect(manager.acquire(metered)).rejects.toThrow("requires estimatedCost");
    await expect(manager.acquire(concurrencyOnly, { estimatedCost: { requests: 1 } })).rejects.toThrow("exactly these dimensions: none");
    for (const requests of [-1, Number.NaN]) {
      await expect(manager.acquire(metered, { estimatedCost: { requests } })).rejects.toBeInstanceOf(ThrottlingCostValidationError);
    }
    await expect(manager.acquire(metered, { estimatedCost: { requests: 11 } })).rejects.toBeInstanceOf(ThrottlingCostExceedsBurstError);
    const controller = new AbortController();
    controller.abort();
    await expect(manager.acquire(simple, { signal: controller.signal })).rejects.toBeInstanceOf(ThrottlingAcquisitionAbortedError);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("enforces exact cost dimensions regardless of input order and validates the received definition", async () => {
    const tokens = rateLimit({ id: "token-quota", unit: "tokens", limit: 20, per: seconds(1) });
    const policy = defineAdmissionPolicy({ id: "multi-unit", limits: [tokens, quota], costAccounting: { reconciliation: "synchronous" } });
    const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>().mockResolvedValue({ admitted: true, remaining: {} });
    const reconcile = vi.fn<NonNullable<RateLimitAdapter["reconcile"]>>();
    const manager = createManager({ reserve: vi.fn(), reserveMany, reconcile });
    await expect(manager.acquire({ ...simple, periodMs: 0 })).rejects.toThrow("periodMs must be a positive finite number");
    await expect(manager.acquire(policy, { estimatedCost: { requests: 1, other: 1 } }))
      .rejects.toThrow("estimatedCost must contain exactly these dimensions: requests, tokens");
    await expect(manager.acquire(policy, { estimatedCost: { requests: 1, tokens: -1 } }))
      .rejects.toThrow("estimatedCost.tokens must be a non-negative finite number");
    expect(reserveMany).not.toHaveBeenCalled();
    const permit = await manager.acquire(policy, { estimatedCost: { tokens: 2, requests: 1 } });
    await expect(permit.complete({ outcome: "success", actualCost: { requests: 1, other: 1 } }))
      .rejects.toThrow("actualCost must contain exactly these dimensions: requests, tokens");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does not split atomic reservations or leak acquired local slots when batch support is absent", async () => {
    const alternate = rateLimit({ id: "alternate-rate", unit: "requests", limit: 20, per: seconds(2) });
    const policy = defineAdmissionPolicy({ id: "atomic-policy", limits: [quota, alternate, slots] });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>();
    const manager = createManager({ reserve });

    await expect(manager.acquire(policy, { estimatedCost: { requests: 1 } }))
      .rejects.toMatchObject({ capability: "atomic batch reservation" });
    expect(reserve).not.toHaveBeenCalled();
    const next = await manager.acquire(concurrencyOnly);
    await next.complete({ outcome: "success" });
  });

  it("rejects conflicting settings for a shared constraint across otherwise distinct policies", async () => {
    const manager = createManager(new MemoryRateLimitAdapter());
    const permit = await manager.acquire(concurrencyOnly);
    const conflict = defineAdmissionPolicy({
      id: "conflicting-work", limits: [concurrencyLimit({ id: slots.id, limit: 2 })],
    });

    await expect(manager.acquire(conflict)).rejects.toThrow(`constraint id "${slots.id}" is already registered`);
    await expect(manager.inspect(concurrencyOnly)).resolves.toMatchObject({ state: "limited" });
    await permit.complete({ outcome: "success" });
    await expect(manager.inspect(concurrencyOnly)).resolves.toMatchObject({ state: "available" });
  });

  it("enforces stable rate, pressure, and circuit contracts across distinct policies", async () => {
    const monitor = new LocalResourcePressureMonitor([{ supports: () => true, read: () => 0 }]);
    const storage = new MemoryRateLimitAdapter({ now: () => new Date(0) });
    const manager = createManager(storage, { resourcePressureMonitor: monitor });
    const breaker = circuitBreaker({ id: "remote", failureThreshold: 2, cooldown: seconds(1) });
    const pressure = localResourcePressure({ id: "host", signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } } });
    const original = defineAdmissionPolicy({ id: "shared-contract", limits: [quota, breaker, pressure] });
    const permit = await manager.acquire(original, { estimatedCost: { requests: 1 } });
    await permit.complete({ outcome: "success" });

    for (const changed of [
      rateLimit({ id: quota.id, unit: "requests", limit: 5, per: seconds(1) }),
      circuitBreaker({ id: breaker.id, failureThreshold: 3, cooldown: seconds(1) }),
      localResourcePressure({ id: pressure.id, signals: { cpu: { degradedAt: 0.7, limitedAt: 0.9 } } }),
    ]) {
      const policy = defineAdmissionPolicy({ id: `different-${changed.id}`, limits: [changed] });
      await expect(manager.inspect(policy)).rejects.toThrow(`constraint id "${changed.id}" is already registered`);
    }
    const changedDefinition = defineAdmissionPolicy({ id: original.id, limits: [slots] });
    await expect(manager.inspect(changedDefinition)).rejects.toThrow(`definition id "${original.id}" is already registered`);

    // A simple limit can be shared unchanged inside an advanced policy.
    await (await manager.acquire(simple)).complete({ outcome: "success" });
    const sharedSimple = defineAdmissionPolicy({ id: "shared-simple", limits: [
      rateLimit({ id: simple.id, unit: "requests", limit: 1, per: seconds(1) }),
    ] });
    await expect(manager.inspect(sharedSimple, { estimatedCost: { requests: 1 } })).resolves.toMatchObject({ state: "limited" });
  });

  it("can register a corrected policy after another constraint rejects the original", async () => {
    const manager = createManager(new MemoryRateLimitAdapter({ now: () => new Date(0) }));
    await manager.run(concurrencyOnly, () => undefined);
    const candidate = (limit: number) => rateLimit({ id: "candidate", unit: "requests", limit, per: seconds(1) });
    const incompatible = defineAdmissionPolicy({ id: "candidate-policy", limits: [
      candidate(1), concurrencyLimit({ id: slots.id, limit: 2 }),
    ] });
    const corrected = defineAdmissionPolicy({ id: incompatible.id, limits: [candidate(2), slots] });
    const estimatedCost = { requests: 1 };

    await expect(manager.acquire(incompatible, { estimatedCost })).rejects.toThrow(`constraint id "${slots.id}"`);
    await expect(manager.run(corrected, { estimatedCost }, () => "corrected")).resolves.toBe("corrected");
  });

  it("does not reserve a definition id for a caller with an invalid partition key", async () => {
    const manager = createManager(new MemoryRateLimitAdapter({ now: () => new Date(0) }));
    const corrected = defineRateLimit({ id: simple.id, requests: 2, per: seconds(1) });

    await expect(manager.acquire(simple, { rateKey: " " })).rejects.toThrow("rate keys must contain between 1 and 256 characters");
    await expect(manager.run(corrected, () => "corrected")).resolves.toBe("corrected");
  });

  it("rejects pressure policies without a monitor or a supported signal", async () => {
    const pressure = localResourcePressure({ id: "local-pressure", signals: { "test-missing": { degradedAt: 0.8, limitedAt: 0.9 } } });
    const policy = defineAdmissionPolicy({ id: "pressure-required", limits: [pressure] });
    const monitor = new LocalResourcePressureMonitor([{ supports: () => false, read: () => 0.1 }]);
    const unsupported = createManager(new MemoryRateLimitAdapter(), { resourcePressureMonitor: monitor });
    const unavailable = createManager(new MemoryRateLimitAdapter());

    await expect(unavailable.acquire(policy)).rejects.toMatchObject({
      name: ThrottlingAdapterCapabilityError.name, capability: "process-local resource pressure monitoring",
    });
    await expect(unsupported.acquire(policy)).rejects.toMatchObject({ capability: 'local resource pressure signal "test-missing"' });
  });

  it("rejects invalid runtime values without consuming the permit", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: true, remaining: 0 });
    const manager = createManager({ reserve });

    // JavaScript callers can pass shapes that the TypeScript overloads prohibit.
    await expect(Reflect.apply(manager.run, manager, [simple, {}])).rejects.toThrow("operation handler is required");
    expect(reserve).not.toHaveBeenCalled();
    const permit = await manager.acquire(simple);
    await expect(Reflect.apply(permit.complete, permit, [{ outcome: "pending" }])).rejects.toThrow("outcome must be terminal");
    for (const [feedback, message] of [
      [null, "must be an object"],
      ["timeout", "must be an object"],
      [{ kind: "unexpected" }, "Unsupported throttling feedback"],
      [{ kind: "throttled", retryAt: "tomorrow" }, "retryAt must be a valid date"],
      [{ kind: "throttled", retryAt: new Date(NaN) }, "retryAt must be a valid date"],
    ] as const) {
      await expect(Reflect.apply(permit.complete, permit, [{ outcome: "failure", feedback }])).rejects.toThrow(message);
    }
    await expect(permit.complete({ outcome: "success" })).resolves.toBeUndefined();
  });

  it("rejects an invalid wall clock and falls back from non-finite instrumentation time", async () => {
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: true, remaining: 0 });
    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const invalidClock = createManager({ reserve }, { now: () => new Date(NaN), monotonicNow: () => NaN, instrumentation: { record } });

    await expect(invalidClock.acquire(simple)).rejects.toThrow("clock returned an invalid date");
    expect(reserve).not.toHaveBeenCalled();
    const event = record.mock.calls[0]?.[0];
    expect(event).toMatchObject({ type: "acquisition", outcome: "failure", data: { result: "error", attempts: 0 } });
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("only samples the instrumentation clock with an observer and tolerates a clock exception", async () => {
    const monotonicNow = vi.fn(() => { throw new Error("clock interrupted"); });
    let time = 10;
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockImplementation(async () => {
      time += 4;
      return { admitted: true, remaining: 0 };
    });
    const silent = createManager({ reserve }, { monotonicNow });
    await expect(silent.run(simple, () => "ok")).resolves.toBe("ok");
    expect(monotonicNow).not.toHaveBeenCalled();

    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const observed = createManager({ reserve }, { monotonicNow, instrumentation: { record } });
    const platformClock = vi.spyOn(performance, "now").mockImplementation(() => time);
    try {
      await expect(observed.run(simple, () => "ok")).resolves.toBe("ok");
    } finally {
      platformClock.mockRestore();
    }
    expect(monotonicNow).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "acquisition", durationMs: 4 }));
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ type: "completion", outcome: "success" }));
  });
});
