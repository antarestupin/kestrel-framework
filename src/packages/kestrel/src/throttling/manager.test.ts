import { describe, expect, it, vi } from "vitest";

import {
  circuitBreaker,
  concurrencyLimit,
  defineAdmissionPolicy,
  defineRateLimit,
  localResourcePressure,
  LocalResourcePressureMonitor,
  MemoryRateLimitAdapter,
  rateLimit,
  type RateLimitAdapter,
  seconds,
  ThrottlingAcquisitionAbortedError,
  ThrottlingAcquisitionTimeoutError,
  ThrottlingCircuitOpenError,
  ThrottlingClosedError,
  type ThrottlingInstrumentationEvent,
  ThrottlingManager,
  ThrottlingPermitCompletedError,
  ThrottlingQueueFullError,
  ThrottlingRejectedError,
  ThrottlingResourcePressureError,
} from "./index.js";

const onePerSecond = defineRateLimit({
  id: "partner-api",
  requests: 1,
  per: seconds(1),
});

describe("ThrottlingManager", () => {
  it("partitions one stable rate definition by caller key", async () => {
    const manager = new ThrottlingManager(
      new MemoryRateLimitAdapter(),
      { namespace: "test" },
    );

    await manager.acquire(onePerSecond, { rateKey: "first" });
    await expect(manager.acquire(onePerSecond, { rateKey: "first" }))
      .rejects.toBeInstanceOf(ThrottlingRejectedError);
    await expect(manager.acquire(onePerSecond, { rateKey: "second" }))
      .resolves.toBeDefined();
  });

  it("runs admitted operations and rejects immediate overflow", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);

    await expect(manager.run(onePerSecond, async () => "done"))
      .resolves.toBe("done");

    await expect(manager.run(onePerSecond, async () => "unexpected"))
      .rejects.toMatchObject({
        name: "ThrottlingRejectedError",
        retryAt: new Date(1_000),
      });

    await manager.close();
  });

  it("waits in FIFO order with one injected sleeper per limit", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);
    const completed: string[] = [];

    await manager.acquire(onePerSecond);

    const first = manager.run(
      onePerSecond,
      { maxWaitMs: 3_000 },
      () => {
        completed.push("first");
      },
    );
    const second = manager.run(
      onePerSecond,
      { maxWaitMs: 3_000 },
      () => {
        completed.push("second");
      },
    );

    await settleMicrotasks();
    expect(clock.pendingSleeps).toBe(1);

    await clock.advance(1_000);
    await first;
    expect(completed).toEqual(["first"]);

    await settleMicrotasks();
    expect(clock.pendingSleeps).toBe(1);

    await clock.advance(1_000);
    await second;
    expect(completed).toEqual(["first", "second"]);

    await manager.close();
  });

  it("times out and aborts queued acquisitions without leaking listeners", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);
    const controller = new AbortController();

    await manager.acquire(onePerSecond);

    const timedOut = manager.acquire(onePerSecond, { maxWaitMs: 100 });
    const aborted = manager.acquire(onePerSecond, {
      maxWaitMs: 500,
      signal: controller.signal,
    });

    await settleMicrotasks();
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(
      ThrottlingAcquisitionAbortedError,
    );

    await clock.advance(100);
    await expect(timedOut).rejects.toBeInstanceOf(
      ThrottlingAcquisitionTimeoutError,
    );

    await manager.close();
  });

  it("includes the first adapter attempt in the waiting deadline", async () => {
    const clock = new ControlledClock();
    const manager = new ThrottlingManager(
      {
        reserve: async () => {
          await clock.advance(100);
          return {
            admitted: false as const,
            remaining: 0,
            retryAt: new Date(1_000),
          };
        },
      },
      {
        namespace: "test",
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    await expect(manager.acquire(onePerSecond, { maxWaitMs: 100 }))
      .rejects.toBeInstanceOf(ThrottlingAcquisitionTimeoutError);

    await manager.close();
  });

  it("rejects an admission whose first reservation finishes at the waiting deadline", async () => {
    const clock = new ControlledClock();
    const storage = new MemoryRateLimitAdapter({ now: clock.now });
    const slots = concurrencyLimit({ id: "limited-slots", limit: 1 });
    const quota = rateLimit({ id: "limited-rate", unit: "requests", limit: 1, per: seconds(1) });
    const composed = defineAdmissionPolicy({ id: "combined", limits: [slots, quota] });
    const concurrencyOnly = defineAdmissionPolicy({ id: "local-capacity", limits: [slots] });
    const manager = new ThrottlingManager({
      reserve: async (request) => {
        const result = await storage.reserve(request);
        await clock.advance(100);
        return result;
      },
      inspectMany: (requests) => storage.inspectMany(requests),
    }, { namespace: "test", now: clock.now });

    try {
      // A successful backend write cannot extend the caller's admission deadline.
      await expect(manager.acquire(composed, {
        estimatedCost: { requests: 1 }, maxWaitMs: 100,
      })).rejects.toBeInstanceOf(ThrottlingAcquisitionTimeoutError);

      // The authoritative charge remains, but the cancelled attempt must release its local slot.
      await expect(manager.inspect(composed, { estimatedCost: { requests: 1 } })).resolves.toMatchObject({
        state: "limited", reasons: [{ constraintId: quota.id, kind: "rate" }],
      });
      const next = await manager.acquire(concurrencyOnly);
      await next.complete({ outcome: "success" });
    } finally {
      await manager.close();
    }
  });

  it("returns an unused half-open probe when the initial adapter call is aborted", async () => {
    const clock = new ControlledClock();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const events: ThrottlingInstrumentationEvent[] = [];
    const breaker = circuitBreaker({ id: "partner-health", failureThreshold: 1, cooldown: seconds(1) });
    const circuit = defineAdmissionPolicy({ id: "only-circuit", limits: [breaker] });
    const quota = rateLimit({ id: "partner-quota", unit: "requests", limit: 10, per: seconds(1) });
    const composed = defineAdmissionPolicy({ id: "external-operation", limits: [breaker, quota] });
    const manager = new ThrottlingManager({
      reserve: async () => {
        started.resolve();
        await release.promise;
        return { admitted: true, remaining: 9 };
      },
    }, {
      namespace: "test", now: clock.now, instrumentation: { record: (event) => events.push(event) },
    });

    try {
      const permit = await manager.acquire(circuit);
      await permit.complete({ outcome: "failure" });
      await clock.advance(1_000);
      const pending = manager.acquire(composed, { estimatedCost: { requests: 1 }, signal: controller.signal });
      const rejection = expect(pending).rejects.toBeInstanceOf(ThrottlingAcquisitionAbortedError);
      await started.promise;
      controller.abort();
      release.resolve();
      await rejection;

      // No operation ran, so returning the probe must not record feedback or close the circuit.
      expect(events.filter((event) => event.type === "circuit").slice(-3).map((event) => event.data)).toMatchObject([
        { operation: "transition", state: "half-open" },
        { operation: "probe", state: "half-open", activeProbes: 1 },
        { operation: "probe", state: "half-open", activeProbes: 0 },
      ]);
      const next = await manager.acquire(circuit);
      await next.complete({ outcome: "success" });
    } finally {
      release.resolve();
      await manager.close();
    }
  });

  it.each(["timeout", "abort", "close"] as const)("handles %s during a queued reservation", async (event) => {
    const clock = new ControlledClock();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(10) })
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return { admitted: true, remaining: 0 };
      })
      .mockResolvedValue({ admitted: true, remaining: 0 });
    const manager = new ThrottlingManager({ reserve }, {
      namespace: "test", now: clock.now, sleep: clock.sleep,
    });

    try {
      const first = manager.acquire(onePerSecond, { maxWaitMs: 100, signal: controller.signal });
      const firstResult = first.catch((error: unknown) => error);
      await settleMicrotasks();
      expect(clock.pendingSleeps).toBe(1);
      const second = manager.acquire(onePerSecond, { maxWaitMs: 200 });
      const secondResult = second.catch((error: unknown) => error);

      await clock.advance(10);
      await started.promise;
      if (event === "timeout") await clock.advance(90);
      else if (event === "abort") controller.abort();
      else void manager.close();
      release.resolve();

      if (event === "close") {
        await expect(firstResult).resolves.toBeInstanceOf(ThrottlingClosedError);
        await expect(secondResult).resolves.toBeInstanceOf(ThrottlingClosedError);
        expect(reserve).toHaveBeenCalledTimes(2);
      } else {
        const expected = event === "timeout" ? ThrottlingAcquisitionTimeoutError : ThrottlingAcquisitionAbortedError;
        await expect(firstResult).resolves.toBeInstanceOf(expected);
        // Losing the head's admission must not drop the next waiter.
        await expect(secondResult).resolves.toMatchObject({ definitionId: onePerSecond.id });
        const next = await second;
        await next.complete({ outcome: "success" });
        expect(reserve).toHaveBeenCalledTimes(3);
      }
    } finally {
      release.resolve();
      await manager.close();
    }
  });

  it("enforces the global pending acquisition bound", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock, { maxPendingAcquisitions: 1 });

    await manager.acquire(onePerSecond);
    const waiting = manager.acquire(onePerSecond, { maxWaitMs: 2_000 });

    await expect(manager.acquire(onePerSecond, { maxWaitMs: 2_000 }))
      .rejects.toBeInstanceOf(ThrottlingQueueFullError);

    await manager.close();
    await expect(waiting).rejects.toBeInstanceOf(ThrottlingClosedError);
  });

  it("keeps immediate callers behind a rate waiter and releases the queue on sleep failure", async () => {
    const clock = new ControlledClock();
    const failedSleep = Promise.withResolvers<void>();
    const sleep = vi.fn(() => failedSleep.promise);
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(1_000) })
      .mockResolvedValue({ admitted: true, remaining: 0 });
    const manager = new ThrottlingManager({ reserve }, { namespace: "test", now: clock.now, sleep });

    try {
      const pending = manager.acquire(onePerSecond, { maxWaitMs: 2_000 });
      const result = pending.catch((error: unknown) => error);
      await settleMicrotasks();
      expect(sleep).toHaveBeenCalledOnce();

      // An immediate call cannot jump the existing queue or probe storage again.
      await expect(manager.acquire(onePerSecond)).rejects.toMatchObject({ retryAt: new Date(1_000) });
      expect(reserve).toHaveBeenCalledOnce();
      const sleepError = new Error("wait clock failed");
      failedSleep.reject(sleepError);
      await expect(result).resolves.toBe(sleepError);
      const next = await manager.acquire(onePerSecond);
      await next.complete({ outcome: "success" });
      expect(reserve).toHaveBeenCalledTimes(2);
    } finally {
      failedSleep.resolve();
      await manager.close();
    }
  });

  it("retains FIFO order while half-open probe capacity is saturated", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);
    const breaker = circuitBreaker({ id: "shared-circuit", failureThreshold: 1, cooldown: seconds(1) });
    const policy = defineAdmissionPolicy({ id: "circuit-queue", limits: [breaker] });

    try {
      const initial = await manager.acquire(policy);
      // Feedback without a server retry date uses the configured cooldown.
      await initial.complete({ outcome: "failure", feedback: { kind: "throttled" } });
      const first = manager.acquire(policy, { maxWaitMs: 2_000 });
      const second = manager.acquire(policy, { maxWaitMs: 2_000 });
      void first.catch(() => {});
      void second.catch(() => {});
      await settleMicrotasks();
      await expect(manager.acquire(policy)).rejects.toMatchObject({
        name: "ThrottlingCircuitOpenError", circuitId: breaker.id, retryAt: new Date(1_000),
      });

      await clock.advance(1_000);
      const firstProbe = await first;
      await settleMicrotasks();
      // An occupied probe has no known completion time to advertise.
      await expect(manager.acquire(policy)).rejects.toBeInstanceOf(ThrottlingCircuitOpenError);
      await expect(manager.acquire(policy)).rejects.toMatchObject({ retryAt: undefined });
      await firstProbe.complete({ outcome: "success" });
      await settleMicrotasks();
      expect(clock.pendingSleeps).toBe(0);
      const next = await second;
      await next.complete({ outcome: "success" });
    } finally {
      await manager.close();
    }
  });

  it("keeps a pressure-blocked queue closed through a missing sample and retries on recovery", async () => {
    const clock = new ControlledClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    let value: number | undefined = 0.95;
    const monitor = new LocalResourcePressureMonitor([{
      supports: (id) => id === "cpu",
      read: () => value,
    }], { now: clock.now, monotonicNow: () => clock.now().getTime(), pressuredIntervalMs: 250 });
    const pressure = localResourcePressure({ id: "local-pressure", signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } } });
    const policy = defineAdmissionPolicy({ id: "pressure-queue", limits: [pressure] });
    const manager = new ThrottlingManager(new MemoryRateLimitAdapter({ now: clock.now }), {
      namespace: "test", now: clock.now, sleep: clock.sleep, resourcePressureMonitor: monitor,
      instrumentation: { record: (event) => events.push(event) },
    });

    try {
      const pending = manager.acquire(policy, { maxWaitMs: 1_000 });
      void pending.catch(() => {});
      await settleMicrotasks();
      await expect(manager.acquire(policy)).rejects.toBeInstanceOf(ThrottlingResourcePressureError);

      // A missing reader sample fails closed and carries no fabricated measurement.
      value = undefined;
      await clock.advance(250);
      expect(clock.pendingSleeps).toBe(1);
      await expect(manager.acquire(policy)).rejects.toMatchObject({
        name: "ThrottlingResourcePressureError", constraintId: pressure.id, signalIds: ["cpu"], retryAt: undefined,
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: "pressure", outcome: "failure",
        data: { key: "test:local-pressure", operation: "transition", signal: "cpu", previousState: "limited", state: "unknown" },
      }));

      value = 0.1;
      await clock.advance(250);
      const permit = await pending;
      await permit.complete({ outcome: "success" });
    } finally {
      await manager.close();
    }
  });

  it("closes idempotently and rejects later work", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);

    const firstClose = manager.close();
    const secondClose = manager.close();

    expect(firstClose).toBe(secondClose);
    await firstClose;
    await expect(manager.acquire(onePerSecond))
      .rejects.toBeInstanceOf(ThrottlingClosedError);
  });

  it("propagates handler errors and records permit completion once", async () => {
    const clock = new ControlledClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = createManager(clock, {
      instrumentation: { record: (event) => events.push(event) },
      monotonicNow: clock.monotonicNow,
    });
    const operationError = new Error("provider failed");

    await expect(manager.run(onePerSecond, () => {
      throw operationError;
    })).rejects.toBe(operationError);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "acquisition",
      outcome: "success",
      data: { key: "partner-api", result: "acquired" },
    });
    expect(events[1]).toMatchObject({
      type: "completion",
      outcome: "failure",
      data: { key: "partner-api", result: "failure" },
    });

    await manager.close();
  });

  it("prevents duplicate permit completion", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);
    const permit = await manager.acquire(onePerSecond);

    await permit.complete({ outcome: "success" });
    await expect(permit.complete({ outcome: "success" }))
      .rejects.toBeInstanceOf(ThrottlingPermitCompletedError);

    await manager.close();
  });

  it("contains instrumentation failures and formats logical keys", async () => {
    const clock = new ControlledClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    let calls = 0;
    const manager = createManager(clock, {
      formatObservationKey: (key) => `redacted:${key.length}`,
      instrumentation: {
        record(event) {
          calls += 1;

          if (calls === 1) {
            throw new Error("metrics unavailable");
          }

          events.push(event);
        },
      },
    });

    await expect(manager.run(onePerSecond, () => "done"))
      .resolves.toBe("done");
    expect(events[0]).toMatchObject({
      type: "completion",
      data: { key: "redacted:11" },
    });

    await manager.close();
  });

  it("rejects conflicting definitions sharing one logical id", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);
    const conflicting = defineRateLimit({
      id: onePerSecond.id,
      requests: 2,
      per: seconds(1),
    });

    await manager.acquire(onePerSecond);
    await expect(manager.acquire(conflicting)).rejects.toThrow(
      "already registered with another policy",
    );

    await manager.close();
  });

  it("reports retry metadata for immediate rejection", async () => {
    const clock = new ControlledClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = createManager(clock, {
      instrumentation: { record: (event) => events.push(event) },
    });

    await manager.acquire(onePerSecond);
    const rejection = manager.acquire(onePerSecond);

    await expect(rejection).rejects.toBeInstanceOf(ThrottlingRejectedError);
    expect(events.at(-1)).toMatchObject({
      type: "acquisition",
      outcome: "failure",
      data: {
        result: "rejected",
        retryAt: "1970-01-01T00:00:01.000Z",
      },
    });

    await manager.close();
  });

  it("reports the adapter source for distributed denials", async () => {
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = new ThrottlingManager(
      {
        reserve: async () => ({
          admitted: false,
          remaining: 0,
          retryAt: new Date(1_000),
          source: "denial-cache",
        }),
      },
      {
        namespace: "test",
        now: () => new Date(0),
        instrumentation: { record: (event) => events.push(event) },
      },
    );

    await expect(manager.acquire(onePerSecond)).rejects.toMatchObject({
      source: "denial-cache",
      remaining: 0,
    });
    expect(events).toMatchObject([{
      type: "acquisition",
      outcome: "failure",
      data: {
        result: "rejected",
        source: "denial-cache",
        remaining: 0,
      },
    }]);

    await manager.close();
  });
});

interface ManagerOverrides {
  maxPendingAcquisitions?: number;
  instrumentation?: { record(event: ThrottlingInstrumentationEvent): void };
  formatObservationKey?: (key: string) => string;
  monotonicNow?: () => number;
}

/** Creates one fully isolated manager and adapter around the same test clock. */
function createManager(
  clock: ControlledClock,
  overrides: ManagerOverrides = {},
): ThrottlingManager {
  return new ThrottlingManager(
    new MemoryRateLimitAdapter({ now: clock.now }),
    {
      namespace: "test",
      now: clock.now,
      sleep: clock.sleep,
      ...overrides,
    },
  );
}

interface PendingSleep {
  wakeAtMs: number;
  signal: AbortSignal;
  abortListener: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Deterministic per-test time source that restores every abort listener. */
class ControlledClock {
  private currentMs = 0;

  private monotonicMs = 0;

  private readonly sleepers: PendingSleep[] = [];

  public readonly now = (): Date => new Date(this.currentMs);

  public readonly monotonicNow = (): number => {
    this.monotonicMs += 1;
    return this.monotonicMs;
  };

  public readonly sleep = (
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const pending: PendingSleep = {
      wakeAtMs: this.currentMs + delayMs,
      signal,
      abortListener: () => undefined,
      resolve,
      reject,
    };
    pending.abortListener = () => {
      this.removeSleeper(pending);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", pending.abortListener, { once: true });
    this.sleepers.push(pending);
  });

  public get pendingSleeps(): number {
    return this.sleepers.length;
  }

  /** Advances time and resolves every sleep whose requested instant elapsed. */
  public async advance(delayMs: number): Promise<void> {
    this.currentMs += delayMs;

    for (const pending of [...this.sleepers]) {
      if (pending.wakeAtMs <= this.currentMs) {
        this.removeSleeper(pending);
        pending.resolve();
      }
    }

    await settleMicrotasks();
  }

  private removeSleeper(pending: PendingSleep): void {
    pending.signal.removeEventListener("abort", pending.abortListener);
    const index = this.sleepers.indexOf(pending);

    if (index >= 0) {
      this.sleepers.splice(index, 1);
    }
  }
}

/** Lets async queue continuations settle without changing global timers. */
async function settleMicrotasks(): Promise<void> {
  for (let iteration = 0; iteration < 6; iteration += 1) {
    await Promise.resolve();
  }
}
