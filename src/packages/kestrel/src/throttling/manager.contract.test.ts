import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
  ThrottlingCostExceedsBurstError,
  ThrottlingCostValidationError,
  ThrottlingManager,
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

    await expect(manager.inspect(policy, { estimatedCost: { requests: 1 } })).resolves.toEqual({
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
    })).rejects.toMatchObject({ name: "AggregateError", errors: [operationError, reconciliationError] });

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

  it("rejects pressure policies without a monitor or a supported signal", async () => {
    const pressure = localResourcePressure({ id: "local-pressure", signals: { "test-missing": { degradedAt: 0.8, limitedAt: 0.9 } } });
    const policy = defineAdmissionPolicy({ id: "pressure-required", limits: [pressure] });
    const monitor = new LocalResourcePressureMonitor([{ supports: () => false, read: () => 0.1 }]);
    const unsupported = createManager(new MemoryRateLimitAdapter(), { resourcePressureMonitor: monitor });
    const unavailable = createManager(new MemoryRateLimitAdapter());

    await expect(unavailable.acquire(policy)).rejects.toBeInstanceOf(ThrottlingAdapterCapabilityError);
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
});
