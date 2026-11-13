import { describe, expect, it } from "vitest";

import { validateRateLimitDefinition, validateThrottlingDefinition } from "./definitions.js";
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

  it("rejects a negative duration field even if other fields make the total positive", () => {
    expect(() => throttlingDurationToMs({ seconds: 2, milliseconds: -1 }))
      .toThrow("milliseconds must be a non-negative finite number");
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

  it("rejects pressure settings that cannot produce a valid admission policy", () => {
    const signal = { degradedAt: 0.8, limitedAt: 0.9 };
    expect(() => localResourcePressure({ id: "missing-signals", signals: {} }))
      .toThrow("must contain at least one signal");
    expect(() => localResourcePressure({ id: "process:cpu", signals: { cpu: signal } }))
      .toThrow("identifiers cannot contain colons");
    expect(() => localResourcePressure({ id: "cpu", signals: { cpu: { ...signal, degradedAt: -1 } } }))
      .toThrow("degradedAt must be a non-negative finite number");
    for (const recoveryRatio of [NaN, 0, 1]) {
      expect(() => localResourcePressure({ id: "cpu", signals: { cpu: { ...signal, recoveryRatio } } }))
        .toThrow("recoveryRatio must be between zero and one");
    }
    expect(() => Reflect.apply(localResourcePressure, undefined, [{
      id: "cpu", signals: { cpu: signal }, onUnavailable: "unsupported",
    }])).toThrow("Unsupported unavailable pressure behavior");
  });

  it("rejects two pressure signals that normalize to the same identity", () => {
    expect(() => localResourcePressure({ id: "process", signals: {
      cpu: { degradedAt: 0.6, limitedAt: 0.8 },
      " cpu ": { degradedAt: 0.8, limitedAt: 0.95 },
    } })).toThrow('Local resource pressure signal "cpu" is duplicated.');
  });

  it("revalidates limits and policy kinds from JavaScript callers", () => {
    const base = defineRateLimit({ id: "partner", requests: 1, per: seconds(1) });

    // Unchecked definitions cannot bypass the simple rate-limit contract.
    for (const [patch, error] of [
      [{ kind: "unknown" }, "Unsupported throttling definition kind"],
      [{ unit: "tokens" }, "Simple rate limits only support request units"],
      [{ coordination: { strategy: "leased" } }, "Simple rate limits require exact coordination"],
      [{ burst: 0.5 }, "burst must allow the default request cost"],
    ] as const) {
      expect(() => Reflect.apply(validateRateLimitDefinition, undefined, [{ ...base, ...patch }]))
        .toThrow(error);
    }
    expect(() => Reflect.apply(validateThrottlingDefinition, undefined, [{ ...base, kind: "unknown" }]))
      .toThrow("Unsupported throttling definition kind");
    expect(() => Reflect.apply(defineAdmissionPolicy, undefined, [{
      id: "policy", limits: [{ kind: "unknown", id: "constraint" }],
    }])).toThrow("Unsupported admission constraint kind");
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

    expect(defineAdmissionPolicy({
      id: "default-cost-accounting", limits: [limit], costAccounting: {},
    }).costAccounting).toEqual({ reconciliation: "disabled" });

    expect(() => defineAdmissionPolicy({
      id: "invalid",
      limits: [limit],
      costAccounting: {
        reconciliation: "invalid" as "synchronous",
      },
    })).toThrow("Unsupported actual-cost reconciliation mode");
  });

  it("validates leased coordination and keeps multidimensional policies homogeneous", () => {
    const coordination = {
      strategy: "leased",
      maxLeaseUnits: 10,
      leaseMs: 5_000,
      maxOutstandingUnits: 40,
      guardBandUnits: 5,
    } as const;
    const leased = rateLimit({
      id: "provider",
      unit: "requests",
      limit: 100,
      per: minutes(1),
      burst: 100,
      coordination,
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
      coordination,
    })).toThrow("cannot exceed burst");

    const options = { id: "lease", unit: "requests", limit: 100, per: minutes(1) };
    expect(() => rateLimit({
      ...options, coordination: { ...coordination, maxOutstandingUnits: 5 },
    })).toThrow("maxOutstandingUnits cannot be smaller than maxLeaseUnits");
    expect(() => Reflect.apply(rateLimit, undefined, [{
      ...options, coordination: { strategy: "unknown" },
    }])).toThrow("Unsupported throttling coordination strategy");
  });

  it("keeps distinct validation errors for malformed identifiers and numeric thresholds", () => {
    const rate = { id: "valid-rate", unit: "requests", limit: 1, per: seconds(1) };
    const circuit = { id: "valid-circuit", failureThreshold: 1, cooldown: seconds(1) };
    const limit = concurrencyLimit({ id: "limit", limit: 1 });
    const pressure = { id: "valid-pressure", signals: { cpu: { degradedAt: 0.5, limitedAt: 1 } } };
    for (const [build, diagnostic] of [
      [() => rateLimit({ ...rate, id: " " }), "Rate limit identifiers cannot be empty"],
      [() => rateLimit({ ...rate, unit: " " }), "Rate limit unit identifiers cannot be empty"],
      [() => rateLimit({ ...rate, limit: Infinity }), "limit must be a positive finite number"],
      [() => rateLimit({ ...rate, burst: 0 }), "burst must be a positive finite number"],
      [() => defineRateLimit({ id: "simple", requests: 1, per: seconds(1), burst: 0.5 }), "burst must allow the default cost of one request"],
      [() => concurrencyLimit({ id: " ", limit: 1 }), "Concurrency limit identifiers cannot be empty"],
      [() => concurrencyLimit({ id: "limit", limit: 0 }), "limit must be a positive integer"],
      [() => circuitBreaker({ ...circuit, id: " " }), "Circuit breaker identifiers cannot be empty"],
      [() => circuitBreaker({ ...circuit, failureThreshold: 0 }), "failureThreshold must be a positive integer"],
      [() => circuitBreaker({ ...circuit, halfOpen: { maxConcurrentProbes: 0 } }), "maxConcurrentProbes must be a positive integer"],
      [() => localResourcePressure({ ...pressure, id: " " }), "Local resource pressure identifiers cannot be empty"],
      [() => localResourcePressure({ ...pressure, signals: { " ": { degradedAt: 0.5, limitedAt: 1 } } }), "Local resource pressure signal identifiers cannot be empty"],
      [() => localResourcePressure({ ...pressure, signals: { cpu: { degradedAt: 0, limitedAt: Infinity } } }), "limitedAt must be a positive finite number"],
      [() => localResourcePressure({ ...pressure, signals: { cpu: { degradedAt: 1, limitedAt: 1 } } }), "degradedAt must be smaller"],
      [() => defineAdmissionPolicy({ id: " ", limits: [limit] }), "Admission policy identifiers cannot be empty"],
    ] as const) expect(build).toThrow(diagnostic);
  });

  it("revalidates untyped definitions and accepts exact lease bounds and zero guard band", () => {
    const simple = defineRateLimit({ id: "rate", requests: 1, per: seconds(1) });
    for (const [patch, diagnostic] of [
      [{ id: " " }, "Rate limit identifiers cannot be empty"],
      [{ limit: 0 }, "limit must be a positive finite number"],
      [{ periodMs: Infinity }, "periodMs must be a positive finite number"],
      [{ burst: NaN }, "burst must be a positive finite number"],
    ] as const) expect(() => validateThrottlingDefinition({ ...simple, ...patch })).toThrow(diagnostic);

    const rate = { id: "boundary", unit: "requests", limit: 5, per: seconds(1), burst: 5 };
    const coordination = { strategy: "leased", maxLeaseUnits: 5, leaseMs: 1_000, maxOutstandingUnits: 5, guardBandUnits: 0 } as const;
    const constraint = rateLimit({ ...rate, coordination });
    expect(constraint.coordination).toEqual(coordination);
    expect(Object.isFrozen(constraint.coordination)).toBe(true);
    for (const [patch, diagnostic] of [
      [{ maxLeaseUnits: 0 }, "maxLeaseUnits must be a positive finite number"],
      [{ leaseMs: 0 }, "leaseMs must be a positive finite number"],
      [{ maxOutstandingUnits: Infinity }, "maxOutstandingUnits must be a positive finite number"],
      [{ guardBandUnits: -1 }, "guardBandUnits must be a non-negative finite number"],
    ] as const) expect(() => rateLimit({ ...rate, coordination: { ...coordination, ...patch } })).toThrow(diagnostic);
    expect(throttlingDurationToMs({ seconds: 1, milliseconds: 0 })).toBe(1_000);
    expect(() => throttlingDurationToMs({ seconds: 0 })).toThrow("A throttling duration must be positive and finite");
  });
});
