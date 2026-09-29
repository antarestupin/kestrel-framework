import { describe, expect, it } from "vitest";

import {
  concurrencyLimit,
  defineAdmissionPolicy,
  MemoryRateLimitAdapter,
  minutes,
  rateLimit,
  ThrottlingCostValidationError,
  ThrottlingBackendUnavailableError,
  type ThrottlingInstrumentationEvent,
  ThrottlingManager,
  ThrottlingRejectedError,
} from "./index.js";

const requestRate = rateLimit({
  id: "shared-requests",
  unit: "requests",
  limit: 100,
  per: minutes(1),
  burst: 1,
});
const localConcurrency = concurrencyLimit({
  id: "shared-concurrency",
  limit: 1,
});

describe("composed throttling", () => {
  it("does not call a rate adapter for a local-concurrency-only policy", async () => {
    let reservationCalls = 0;
    const manager = new ThrottlingManager({
      reserve: async () => {
        reservationCalls += 1;
        return { admitted: true, remaining: 1 };
      },
    }, { namespace: "test" });
    const policy = defineAdmissionPolicy({
      id: "local-resource-only",
      limits: [localConcurrency],
    });
    const permit = await manager.acquire(policy);

    expect(reservationCalls).toBe(0);
    await permit.complete({ outcome: "success" });
    await manager.close();
  });

  it("holds and releases process-local concurrency at permit completion", async () => {
    const manager = createManager();
    const policy = defineAdmissionPolicy({
      id: "concurrency-only",
      limits: [localConcurrency],
    });
    const first = await manager.acquire(policy);
    const waiting = manager.acquire(policy, { maxWaitMs: 1_000 });

    await settleMicrotasks();
    await first.complete({ outcome: "success" });
    const second = await waiting;

    await second.complete({ outcome: "success" });
    await manager.close();
  });

  it("compensates local capacity when an atomic rate reservation rejects", async () => {
    const manager = createManager();
    const rateOnly = defineAdmissionPolicy({
      id: "rate-only",
      limits: [requestRate],
    });
    const composed = defineAdmissionPolicy({
      id: "composed",
      limits: [requestRate, localConcurrency],
    });
    const concurrencyOnly = defineAdmissionPolicy({
      id: "concurrency-after-rejection",
      limits: [localConcurrency],
    });
    const consumed = await manager.acquire(rateOnly, {
      estimatedCost: { requests: 1 },
    });

    await consumed.complete({ outcome: "success" });
    await expect(manager.acquire(composed, {
      estimatedCost: { requests: 1 },
    })).rejects.toBeInstanceOf(ThrottlingRejectedError);

    const capacity = await manager.acquire(concurrencyOnly);
    await capacity.complete({ outcome: "success" });
    await manager.close();
  });

  it("reserves dimensions atomically and creates debt after underestimation", async () => {
    const manager = createManager();
    const policy = costPolicy();
    const permit = await manager.acquire(policy, {
      estimatedCost: { requests: 1, tokens: 6 },
    });

    await permit.complete({
      outcome: "success",
      actualCost: { requests: 1, tokens: 12 },
    });

    await expect(manager.inspect(policy, {
      estimatedCost: { requests: 1, tokens: 1 },
    })).resolves.toMatchObject({
      state: "limited",
      reasons: [{ constraintId: "token-budget", kind: "rate" }],
    });
    await manager.close();
  });

  it("applies one cost dimension to every window carrying that unit", async () => {
    const manager = new ThrottlingManager(
      new MemoryRateLimitAdapter({ now: () => new Date(0) }),
      { namespace: "test" },
    );
    const policy = defineAdmissionPolicy({
      id: "multiple-windows",
      limits: [
        rateLimit({
          id: "requests-minute-window",
          unit: "requests",
          limit: 2,
          per: minutes(1),
        }),
        rateLimit({
          id: "requests-hour-window",
          unit: "requests",
          limit: 2,
          per: minutes(60),
        }),
      ],
    });

    for (let index = 0; index < 2; index += 1) {
      const permit = await manager.acquire(policy, {
        estimatedCost: { requests: 1 },
      });
      await permit.complete({ outcome: "success" });
    }

    await expect(manager.acquire(policy, {
      estimatedCost: { requests: 1 },
    })).rejects.toBeInstanceOf(ThrottlingRejectedError);
    await manager.close();
  });

  it("refunds overestimation and accepts actual cost from run context", async () => {
    const manager = createManager();
    const policy = costPolicy();

    await manager.run(
      policy,
      { estimatedCost: { requests: 1, tokens: 6 } },
      (context) => {
        context.reportActualCost({ requests: 1, tokens: 2 });
        return "done";
      },
    );

    const permit = await manager.acquire(policy, {
      estimatedCost: { requests: 1, tokens: 8 },
    });
    await permit.complete({ outcome: "success" });
    await manager.close();
  });

  it("keeps inspection advisory and validates every cost dimension", async () => {
    const manager = createManager();
    const policy = costPolicy();

    await expect(manager.acquire(policy, {
      estimatedCost: { requests: 1 },
    })).rejects.toBeInstanceOf(ThrottlingCostValidationError);
    await expect(manager.inspect(policy, {
      estimatedCost: { requests: 1, tokens: 10 },
    })).resolves.toMatchObject({ state: "available", reasons: [] });
    await expect(manager.inspect(policy, {
      estimatedCost: { requests: 1, tokens: 10 },
    })).resolves.toMatchObject({ state: "available", reasons: [] });

    const permit = await manager.acquire(policy, {
      estimatedCost: { requests: 1, tokens: 10 },
    });
    await permit.complete({ outcome: "success" });
    await manager.close();
  });

  it("reports composition and reconciliation costs", async () => {
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = new ThrottlingManager(new MemoryRateLimitAdapter(), {
      namespace: "test",
      instrumentation: { record: (event) => events.push(event) },
    });
    const policy = costPolicy();

    await manager.run(
      policy,
      { estimatedCost: { requests: 1, tokens: 4 } },
      (context) => {
        context.reportActualCost({ requests: 1, tokens: 2 });
      },
    );

    expect(events).toMatchObject([
      {
        type: "acquisition",
        data: {
          constraints: 2,
          estimatedCost: { requests: 1, tokens: 4 },
        },
      },
      {
        type: "completion",
        data: {
          actualCost: { requests: 1, tokens: 2 },
          estimatedCost: { requests: 1, tokens: 4 },
          reconciliation: "reconciled",
        },
      },
    ]);
    await manager.close();
  });

  it("observes actual cost without reconciling by default", async () => {
    let reconciliationCalls = 0;
    const events: ThrottlingInstrumentationEvent[] = [];
    const adapter = {
      reserve: async () => ({ admitted: true as const, remaining: 10 }),
      reconcile: async () => {
        reconciliationCalls += 1;
        return {};
      },
    };
    const manager = new ThrottlingManager(adapter, {
      namespace: "test",
      instrumentation: { record: (event) => events.push(event) },
    });
    const policy = defineAdmissionPolicy({
      id: "observed-cost",
      limits: [requestRate],
    });
    const permit = await manager.acquire(policy, {
      estimatedCost: { requests: 1 },
    });

    await permit.complete({
      outcome: "success",
      actualCost: { requests: 2 },
    });

    expect(reconciliationCalls).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "completion",
      data: { reconciliation: "disabled", actualCost: { requests: 2 } },
    });
    await manager.close();
  });

  it("releases local capacity before asynchronous reconciliation settles", async () => {
    let releaseReconciliation!: () => void;
    const reconciliationBlock = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const events: ThrottlingInstrumentationEvent[] = [];
    const adapter = {
      reserve: async () => ({ admitted: true as const, remaining: 10 }),
      reconcile: async () => {
        await reconciliationBlock;
        return {};
      },
    };
    const manager = new ThrottlingManager(adapter, {
      namespace: "test",
      instrumentation: { record: (event) => events.push(event) },
    });
    const policy = defineAdmissionPolicy({
      id: "asynchronous-cost",
      limits: [requestRate, localConcurrency],
      costAccounting: { reconciliation: "asynchronous" },
    });
    const concurrencyOnly = defineAdmissionPolicy({
      id: "capacity-during-asynchronous-reconciliation",
      limits: [localConcurrency],
    });
    const permit = await manager.acquire(policy, {
      estimatedCost: { requests: 1 },
    });

    await permit.complete({
      outcome: "success",
      actualCost: { requests: 2 },
    });
    const next = await manager.acquire(concurrencyOnly);

    expect(events.find((event) =>
      event.type === "completion"
      && event.data.key === "asynchronous-cost")).toMatchObject({
      type: "completion",
      data: { reconciliation: "scheduled" },
    });

    await next.complete({ outcome: "success" });
    let closed = false;
    const closing = manager.close().then(() => {
      closed = true;
    });
    await settleMicrotasks();
    expect(closed).toBe(false);
    releaseReconciliation();
    await closing;
    expect(events.at(-1)).toMatchObject({
      type: "reconciliation",
      data: { result: "reconciled", constraints: 1 },
    });
  });

  it("does not fail permit completion when asynchronous work closes late", async () => {
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = new ThrottlingManager({
      reserve: async () => ({ admitted: true as const, remaining: 10 }),
      reconcile: async () => ({}),
    }, {
      namespace: "test",
      instrumentation: { record: (event) => events.push(event) },
    });
    const policy = defineAdmissionPolicy({
      id: "late-asynchronous-cost",
      limits: [requestRate],
      costAccounting: { reconciliation: "asynchronous" },
    });
    const permit = await manager.acquire(policy, {
      estimatedCost: { requests: 1 },
    });

    await manager.close();
    await expect(permit.complete({
      outcome: "success",
      actualCost: { requests: 2 },
    })).resolves.toBeUndefined();
    expect(events.at(-2)).toMatchObject({
      type: "reconciliation",
      data: { result: "failed" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "completion",
      data: { reconciliation: "scheduled" },
    });
  });

  it("releases concurrency even when reconciliation fails", async () => {
    const adapter = {
      reserve: async () => ({ admitted: true as const, remaining: 10 }),
      reconcile: async () => {
        throw new Error("reconciliation unavailable");
      },
    };
    const manager = new ThrottlingManager(adapter, { namespace: "test" });
    const policy = defineAdmissionPolicy({
      id: "failing-reconciliation",
      costAccounting: { reconciliation: "synchronous" },
      limits: [
        rateLimit({
          id: "failing-rate",
          unit: "requests",
          limit: 10,
          per: minutes(1),
        }),
        localConcurrency,
      ],
    });
    const concurrencyOnly = defineAdmissionPolicy({
      id: "capacity-after-reconciliation",
      limits: [localConcurrency],
    });
    const permit = await manager.acquire(policy, {
      estimatedCost: { requests: 1 },
    });

    await expect(permit.complete({
      outcome: "success",
      actualCost: { requests: 2 },
    })).rejects.toThrow("reconciliation unavailable");

    const next = await manager.acquire(concurrencyOnly);
    await next.complete({ outcome: "success" });
    await manager.close();
  });

  it("distinguishes degraded and unknown advisory inspection", async () => {
    const policy = costPolicy();
    const degraded = new ThrottlingManager({
      reserve: async () => ({ admitted: true, remaining: 1 }),
      inspectMany: async (requests) => requests.map(() => ({
        available: true,
        remaining: 1,
        source: "emergency-local" as const,
      })),
    }, { namespace: "test" });
    const unknown = new ThrottlingManager({
      reserve: async () => ({ admitted: true, remaining: 1 }),
      inspectMany: async () => {
        throw new ThrottlingBackendUnavailableError({
          cause: new Error("database unavailable"),
        });
      },
    }, { namespace: "test" });
    const options = { estimatedCost: { requests: 1, tokens: 1 } };

    await expect(degraded.inspect(policy, options))
      .resolves.toMatchObject({ state: "degraded", reasons: [] });
    await expect(unknown.inspect(policy, options))
      .resolves.toMatchObject({ state: "unknown" });

    await degraded.close();
    await unknown.close();
  });
});

function costPolicy() {
  return defineAdmissionPolicy({
    id: "cost-policy",
    costAccounting: { reconciliation: "synchronous" },
    limits: [
      rateLimit({
        id: "request-budget",
        unit: "requests",
        limit: 100,
        per: minutes(1),
        burst: 100,
      }),
      rateLimit({
        id: "token-budget",
        unit: "tokens",
        limit: 100,
        per: minutes(1),
        burst: 10,
      }),
    ],
  });
}

function createManager(): ThrottlingManager {
  return new ThrottlingManager(new MemoryRateLimitAdapter(), {
    namespace: "test",
  });
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
