import { describe, expect, it } from "vitest";

import {
  circuitBreaker,
  concurrencyLimit,
  defineAdmissionPolicy,
  defineRateLimit,
  localResourcePressure,
  milliseconds,
  minutes,
  rateLimit,
  seconds,
  throttlingDurationToMs,
} from "./index.js";

describe("throttling definitions", () => {
  it("creates the simple request limit with documented defaults", () => {
    const definition = defineRateLimit({
      id: " partner-api ",
      requests: 20,
      per: seconds(1),
    });

    expect(definition).toEqual({
      kind: "rate-limit",
      id: "partner-api",
      unit: "requests",
      limit: 20,
      periodMs: 1_000,
      burst: 20,
      coordination: { strategy: "exact" },
    });
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it("accepts an explicit burst and combined duration fields", () => {
    const definition = defineRateLimit({
      id: "batch-api",
      requests: 120,
      per: { minutes: 1, seconds: 30 },
      burst: 4,
    });

    expect(definition.periodMs).toBe(90_000);
    expect(definition.burst).toBe(4);
    expect(throttlingDurationToMs(milliseconds(25))).toBe(25);
    expect(throttlingDurationToMs(minutes(2))).toBe(120_000);
  });

  it.each([
    ["empty id", { id: " ", requests: 1, per: seconds(1) }],
    ["zero requests", { id: "api", requests: 0, per: seconds(1) }],
    ["invalid duration", { id: "api", requests: 1, per: seconds(0) }],
    ["small burst", {
      id: "api",
      requests: 1,
      per: seconds(1),
      burst: 0.5,
    }],
  ])("rejects %s", (_name, options) => {
    expect(() => defineRateLimit(options)).toThrow(TypeError);
  });

  it("defines immutable multidimensional AND policies", () => {
    const definition = defineAdmissionPolicy({
      id: "ai-provider",
      limits: [
        rateLimit({
          id: "requests-per-minute",
          unit: "requests",
          limit: 100,
          per: minutes(1),
        }),
        rateLimit({
          id: "tokens-per-minute",
          unit: "tokens",
          limit: 10_000,
          per: minutes(1),
          burst: 2_000,
        }),
        concurrencyLimit({ id: "ai-concurrency", limit: 4 }),
        circuitBreaker({
          id: "ai-health",
          failureThreshold: 5,
          cooldown: seconds(30),
        }),
      ],
    });

    expect(definition).toMatchObject({
      kind: "admission-policy",
      id: "ai-provider",
      costAccounting: { reconciliation: "disabled" },
      limits: [
        { kind: "rate-limit-constraint", scope: "application" },
        { kind: "rate-limit-constraint", burst: 2_000 },
        { kind: "concurrency-limit", scope: "process", limit: 4 },
        {
          kind: "circuit-breaker",
          scope: "process",
          failureThreshold: 5,
          cooldownMs: 30_000,
          halfOpen: { maxConcurrentProbes: 1, successThreshold: 1 },
        },
      ],
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.limits)).toBe(true);
  });

  it("validates explicit half-open circuit capacity", () => {
    const circuit = circuitBreaker({
      id: "partner-health",
      failureThreshold: 3,
      cooldown: seconds(10),
      halfOpen: { maxConcurrentProbes: 2, successThreshold: 2 },
    });

    expect(circuit).toMatchObject({
      cooldownMs: 10_000,
      halfOpen: { maxConcurrentProbes: 2, successThreshold: 2 },
    });
    expect(() => circuitBreaker({
      id: "invalid-health",
      failureThreshold: 1,
      cooldown: seconds(1),
      halfOpen: { maxConcurrentProbes: 1, successThreshold: 0 },
    })).toThrow("successThreshold must be a positive integer");
  });

  it("defines immutable local pressure thresholds with safe defaults", () => {
    const pressure = localResourcePressure({
      id: " worker-process ",
      signals: {
        "process.heap": { degradedAt: 0.8, limitedAt: 0.9 },
        "process.cpu": {
          degradedAt: 0.7,
          limitedAt: 0.95,
          recoveryRatio: 0.85,
        },
      },
    });

    expect(pressure).toEqual({
      kind: "local-resource-pressure",
      id: "worker-process",
      signals: [
        {
          id: "process.cpu",
          degradedAt: 0.7,
          limitedAt: 0.95,
          recoveryRatio: 0.85,
        },
        {
          id: "process.heap",
          degradedAt: 0.8,
          limitedAt: 0.9,
          recoveryRatio: 0.9,
        },
      ],
      onUnavailable: "reject",
      scope: "process",
    });
    expect(Object.isFrozen(pressure.signals)).toBe(true);
    expect(() => localResourcePressure({
      id: "invalid",
      signals: { cpu: { degradedAt: 0.9, limitedAt: 0.8 } },
    })).toThrow("degradedAt must be smaller");
  });

  it("rejects empty policies and duplicate constraint ids", () => {
    expect(() => defineAdmissionPolicy({ id: "empty", limits: [] }))
      .toThrow("at least one limit");

    const duplicate = concurrencyLimit({ id: "shared", limit: 1 });
    expect(() => defineAdmissionPolicy({
      id: "duplicate",
      limits: [duplicate, duplicate],
    })).toThrow("duplicated");
  });

  it("accepts explicit actual-cost reconciliation modes", () => {
    const limit = concurrencyLimit({ id: "local", limit: 1 });

    expect(defineAdmissionPolicy({
      id: "synchronous",
      limits: [limit],
      costAccounting: { reconciliation: "synchronous" },
    }).costAccounting).toEqual({ reconciliation: "synchronous" });

    expect(() => defineAdmissionPolicy({
      id: "invalid",
      limits: [limit],
      costAccounting: {
        reconciliation: "invalid" as "synchronous",
      },
    })).toThrow("Unsupported actual-cost reconciliation mode");
  });

  it("validates leased coordination and keeps multidimensional policies homogeneous", () => {
    const leased = rateLimit({
      id: "provider",
      unit: "requests",
      limit: 100,
      per: minutes(1),
      burst: 100,
      coordination: {
        strategy: "leased",
        maxLeaseUnits: 10,
        leaseMs: 5_000,
        maxOutstandingUnits: 40,
        guardBandUnits: 5,
      },
    });

    expect(leased.coordination).toMatchObject({
      strategy: "leased",
      maxLeaseUnits: 10,
    });
    expect(() => defineAdmissionPolicy({
      id: "mixed",
      limits: [
        leased,
        rateLimit({
          id: "exact",
          unit: "tokens",
          limit: 100,
          per: minutes(1),
        }),
      ],
    })).toThrow("same coordination strategy");
    expect(() => rateLimit({
      id: "invalid-lease",
      unit: "requests",
      limit: 100,
      per: minutes(1),
      burst: 5,
      coordination: {
        strategy: "leased",
        maxLeaseUnits: 10,
        leaseMs: 5_000,
        maxOutstandingUnits: 40,
        guardBandUnits: 5,
      },
    })).toThrow("cannot exceed burst");
  });
});
