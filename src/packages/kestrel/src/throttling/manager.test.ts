import { setImmediate } from "node:timers/promises";
import { getEventListeners } from "node:events";
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
    const first = vi.fn();
    const second = vi.fn();

    try {
      await manager.acquire(onePerSecond);
      void manager.run(onePerSecond, { maxWaitMs: 3_000 }, () => {
        completed.push("first");
      }).then(first, first);
      void manager.run(onePerSecond, { maxWaitMs: 3_000 }, () => {
        completed.push("second");
      }).then(second, second);
      await setImmediate();
      expect(clock.pendingSleeps).toBe(1);

      // Each progress check can fail immediately if a regression loses a queued waiter.
      await clock.advance(1_000);
      await setImmediate();
      expect(first).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(second).not.toHaveBeenCalled();
      expect(completed).toEqual(["first"]);
      expect(clock.pendingSleeps).toBe(1);

      await clock.advance(1_000);
      await setImmediate();
      expect(second).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(completed).toEqual(["first", "second"]);
    } finally {
      const closing = manager.close();
      await clock.advance(3_000);
      await closing;
    }
  });

  it("waits for a long retry deadline without overflowing the default Node timer", async () => {
    const retryAt = new Date(2_147_483_648);
    const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValue({ admitted: false, remaining: 0, retryAt });
    const warning = vi.spyOn(process, "emitWarning");
    const timer = vi.spyOn(globalThis, "setTimeout");
    const manager = new ThrottlingManager({ reserve }, { namespace: "test", now: () => new Date(0) });
    const controller = new AbortController();
    const settled = vi.fn();
    void manager.acquire(onePerSecond, { maxWaitMs: retryAt.getTime() + 1_000, signal: controller.signal }).then(settled, settled);
    try {
      await setImmediate();
      // An overflowing native timeout is coerced to one millisecond and would keep retrying.
      expect(warning.mock.calls.some(([message]) => String(message).includes("does not fit into a 32-bit signed integer"))).toBe(false);
      const deadlineTimer = timer.mock.calls.findIndex(([, delay]) => delay === 2_147_483_647);
      expect(timer.mock.results[deadlineTimer]?.value.hasRef()).toBe(true);
      expect(reserve).toHaveBeenCalledOnce();
      controller.abort();
      await setImmediate();
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingAcquisitionAbortedError));
    } finally {
      warning.mockRestore();
      // Break a mutant's pending sleep without waiting for the simulated long deadline.
      for (const result of timer.mock.results) {
        if (result.type === "return" && result.value !== undefined) clearTimeout(result.value);
      }
      timer.mockRestore();
      controller.abort();
      void manager.close().catch(() => undefined);
    }
  });

  it("times out and aborts queued acquisitions without leaking listeners", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);
    const controller = new AbortController();
    const timedOut = vi.fn();
    const aborted = vi.fn();

    try {
      await manager.acquire(onePerSecond);
      void manager.acquire(onePerSecond, { maxWaitMs: 100 }).then(timedOut, timedOut);
      void manager.acquire(onePerSecond, { maxWaitMs: 500, signal: controller.signal }).then(aborted, aborted);

      await setImmediate();
      controller.abort();
      await setImmediate();
      expect(aborted).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingAcquisitionAbortedError));

      await clock.advance(100);
      await setImmediate();
      expect(timedOut).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingAcquisitionTimeoutError));
    } finally {
      const closing = manager.close();
      await clock.advance(500);
      await closing;
    }
  });

  it("expires a later waiter at its own earlier deadline", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);
    const first = vi.fn();
    const second = vi.fn();

    try {
      await manager.acquire(onePerSecond);
      void manager.acquire(onePerSecond, { maxWaitMs: 900 }).then(first, first);
      await setImmediate();
      void manager.acquire(onePerSecond, { maxWaitMs: 100 }).then(second, second);
      await setImmediate();

      // The second request expires while the FIFO head and backend delay are still live.
      await clock.advance(100);
      await setImmediate();
      expect(second).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingAcquisitionTimeoutError));
      expect(first).not.toHaveBeenCalled();

      const closing = manager.close();
      await setImmediate();
      expect(first).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingClosedError));
      await closing;
    } finally {
      const closing = manager.close();
      // Exhaust the test's deadlines even if a regression leaves the queue open on close.
      await clock.advance(900);
      await closing;
    }
  });

  it("reclaims queue slots and detaches the caller's listener on every settlement", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock, { maxPendingAcquisitions: 1 });
    const aborting = new AbortController();
    const admitted = new AbortController();
    const abortedResult = vi.fn();
    const admittedResult = vi.fn();
    const laterResult = vi.fn();

    try {
      await manager.acquire(onePerSecond);
      void manager.acquire(onePerSecond, { maxWaitMs: 2_000, signal: aborting.signal }).then(abortedResult, abortedResult);
      await setImmediate();
      aborting.abort();
      await setImmediate();
      expect(abortedResult).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingAcquisitionAbortedError));
      expect(getEventListeners(aborting.signal, "abort")).toHaveLength(0);

      // Cancellation must free the sole pending slot for the next caller.
      void manager.run(onePerSecond, { maxWaitMs: 2_000, signal: admitted.signal }, () => "admitted")
        .then(admittedResult, admittedResult);
      await setImmediate();
      expect(admittedResult).not.toHaveBeenCalled();
      await clock.advance(1_000);
      await setImmediate();
      expect(admittedResult).toHaveBeenCalledExactlyOnceWith("admitted");
      expect(getEventListeners(admitted.signal, "abort")).toHaveLength(0);

      // Successful settlement must free the same slot again.
      void manager.run(onePerSecond, { maxWaitMs: 2_000 }, () => "later").then(laterResult, laterResult);
      await setImmediate();
      expect(laterResult).not.toHaveBeenCalled();
      await clock.advance(1_000);
      await setImmediate();
      expect(laterResult).toHaveBeenCalledExactlyOnceWith("later");
    } finally {
      await manager.close();
    }
  });

  it("wakes an aborted waiter even if a caller's listener stops propagation", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);
    const controller = new AbortController();
    const settled = vi.fn();
    controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });

    try {
      await manager.acquire(onePerSecond);
      void manager.acquire(onePerSecond, { maxWaitMs: 2_000, signal: controller.signal }).then(settled, settled);
      await setImmediate();
      expect(clock.pendingSleeps).toBe(1);
      controller.abort();
      await setImmediate();
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingAcquisitionAbortedError));
      expect(clock.pendingSleeps).toBe(0);
    } finally {
      const closing = manager.close();
      await clock.advance(2_000);
      await closing;
    }
  });

  it("rechecks the next waiter's own cost when the FIFO head aborts", async () => {
    const clock = new ControlledClock();
    const policy = defineAdmissionPolicy({ id: "variable-cost", limits: [
      rateLimit({ id: "variable-cost-rate", unit: "requests", limit: 10, per: seconds(1) }),
    ] });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 1, retryAt: new Date(1_000) })
      .mockResolvedValue({ admitted: true, remaining: 0 });
    const manager = new ThrottlingManager({ reserve }, { namespace: "test", now: clock.now, sleep: clock.sleep });
    const controller = new AbortController();
    const first = vi.fn();
    const second = vi.fn();

    try {
      void manager.acquire(policy, { maxWaitMs: 2_000, signal: controller.signal, estimatedCost: { requests: 2 } }).then(first, first);
      await setImmediate();
      void manager.run(policy, { maxWaitMs: 2_000, estimatedCost: { requests: 1 } }, () => "admitted").then(second, second);
      await setImmediate();
      expect(reserve).toHaveBeenCalledOnce();

      // The old retry time only applied to the head's two-unit request.
      controller.abort();
      await setImmediate();
      expect(first).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingAcquisitionAbortedError));
      expect(second).toHaveBeenCalledExactlyOnceWith("admitted");
      expect(reserve).toHaveBeenCalledTimes(2);
    } finally {
      const closing = manager.close();
      await clock.advance(2_000);
      await closing;
    }
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
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const events: ThrottlingInstrumentationEvent[] = [];
    const breaker = circuitBreaker({ id: "partner-health", failureThreshold: 1, cooldown: seconds(1) });
    const circuit = defineAdmissionPolicy({ id: "only-circuit", limits: [breaker] });
    const quota = rateLimit({ id: "partner-quota", unit: "requests", limit: 10, per: seconds(1) });
    const composed = defineAdmissionPolicy({ id: "external-operation", limits: [breaker, quota] });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>(async () => {
      await release.promise;
      return { admitted: true, remaining: 9 };
    });
    const manager = new ThrottlingManager({ reserve }, {
      namespace: "test", now: clock.now, instrumentation: { record: (event) => events.push(event) },
    });

    try {
      const permit = await manager.acquire(circuit);
      await permit.complete({ outcome: "failure" });
      await clock.advance(1_000);
      const outcome = vi.fn();
      void manager.acquire(composed, { estimatedCost: { requests: 1 }, signal: controller.signal })
        .then(outcome, outcome);
      // A half-open probe must reach the backend before this test cancels it.
      await setImmediate();
      expect(reserve).toHaveBeenCalledOnce();
      expect(outcome).not.toHaveBeenCalled();
      controller.abort();
      release.resolve();
      await setImmediate();
      expect(outcome).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingAcquisitionAbortedError));

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
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(10) })
      .mockImplementationOnce(async () => {
        await release.promise;
        return { admitted: true, remaining: 0 };
      })
      .mockResolvedValue({ admitted: true, remaining: 0 });
    const manager = new ThrottlingManager({ reserve, close }, {
      namespace: "test", now: clock.now, sleep: clock.sleep,
    });

    try {
      const firstResult = vi.fn();
      void manager.acquire(onePerSecond, { maxWaitMs: 100, signal: controller.signal }).then(firstResult, firstResult);
      await settleMicrotasks();
      expect(clock.pendingSleeps).toBe(1);
      const second = manager.acquire(onePerSecond, { maxWaitMs: 200 });
      const secondResult = vi.fn();
      void second.then(secondResult, secondResult);

      await clock.advance(10);
      await setImmediate();
      expect(reserve).toHaveBeenCalledTimes(2);
      if (event === "timeout") await clock.advance(90);
      else if (event === "abort") controller.abort();
      else {
        const closed = vi.fn();
        void manager.close().then(closed, closed);
        await setImmediate();
        // The adapter remains available until the in-flight queue drain has settled.
        expect(closed).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      }
      release.resolve();
      await setImmediate();

      if (event === "close") {
        expect(close).toHaveBeenCalledOnce();
        expect(firstResult).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingClosedError));
        expect(secondResult).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingClosedError));
        expect(reserve).toHaveBeenCalledTimes(2);
        await manager.close();
        expect(close).toHaveBeenCalledOnce();
      } else {
        const expected = event === "timeout" ? ThrottlingAcquisitionTimeoutError : ThrottlingAcquisitionAbortedError;
        expect(reserve).toHaveBeenCalledTimes(3);
        expect(firstResult).toHaveBeenCalledExactlyOnceWith(expect.any(expected));
        // Losing the head's admission must not drop the next waiter.
        expect(secondResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definitionId: onePerSecond.id }));
        const next = await second;
        await next.complete({ outcome: "success" });
        expect(reserve).toHaveBeenCalledTimes(3);
        // Settled rate partitions must release their queue entries before shutdown.
        expect(manager["waitQueues"].size).toBe(0);
      }
    } finally {
      release.resolve();
      await manager.close();
    }
  });

  it("enforces the global pending acquisition bound", async () => {
    const clock = new ControlledClock();
    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const manager = createManager(clock, { maxPendingAcquisitions: 1, instrumentation: { record } });

    const waiting = vi.fn();
    const overflowing = vi.fn();
    try {
      await manager.acquire(onePerSecond);
      void manager.acquire(onePerSecond, { maxWaitMs: 2_000 }).then(waiting, waiting);
      await setImmediate();

      void manager.acquire(onePerSecond, { maxWaitMs: 2_000 }).then(overflowing, overflowing);
      await setImmediate();
      expect(overflowing).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingQueueFullError));
      expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ type: "acquisition", outcome: "failure", data: {
        key: onePerSecond.id, mode: "wait", result: "queue-full", cost: 1,
        estimatedCost: { requests: 1 }, constraints: 1, attempts: 0, waitTimeoutMs: 2_000,
      } }));

      await manager.close();
      await setImmediate();
      expect(waiting).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingClosedError));
      expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ type: "acquisition", outcome: "failure",
        data: expect.objectContaining({ result: "closed", waitTimeoutMs: 2_000 }),
      }));
    } finally {
      const closing = manager.close();
      await clock.advance(2_000);
      await closing;
    }
  });

  it.each(["abort", "timeout"] as const)("keeps %s ahead of queue saturation when a pending reserve is denied", async (event) => {
    const clock = new ControlledClock();
    const controller = new AbortController();
    const reserve = Promise.withResolvers<Awaited<ReturnType<RateLimitAdapter["reserve"]>>>();
    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const manager = new ThrottlingManager({ reserve: () => reserve.promise }, {
      namespace: "test", now: clock.now, sleep: clock.sleep, maxPendingAcquisitions: 0, instrumentation: { record },
    });
    try {
      const pending = manager.acquire(onePerSecond, { maxWaitMs: 25, signal: controller.signal });
      void pending.catch(() => {});
      await settleMicrotasks();
      if (event === "abort") controller.abort();
      else await clock.advance(25);
      reserve.resolve({ admitted: false, remaining: 0, retryAt: new Date(50) });

      await expect(pending).rejects.toBeInstanceOf(event === "abort" ? ThrottlingAcquisitionAbortedError : ThrottlingAcquisitionTimeoutError);
      expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ type: "acquisition", outcome: "failure",
        data: expect.objectContaining({ result: event === "abort" ? "aborted" : "timeout", waitTimeoutMs: 25, attempts: 1 }),
      }));
    } finally {
      await manager.close();
    }
  });

  it("starts a fresh queue after another policy was rejected at the global queue bound", async () => {
    const clock = new ControlledClock();
    const controller = new AbortController();
    const other = defineRateLimit({ id: "other", requests: 1, per: seconds(1) });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(1_000) })
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(9_000) })
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(10) })
      .mockResolvedValueOnce({ admitted: true, remaining: 0 });
    const manager = new ThrottlingManager({ reserve }, {
      namespace: "test", now: clock.now, sleep: clock.sleep, maxPendingAcquisitions: 1,
    });

    try {
      const occupying = manager.acquire(onePerSecond, { maxWaitMs: 2_000, signal: controller.signal });
      void occupying.catch(() => {});
      await settleMicrotasks();
      await expect(manager.acquire(other, { maxWaitMs: 2_000 })).rejects.toBeInstanceOf(ThrottlingQueueFullError);
      controller.abort();
      await expect(occupying).rejects.toBeInstanceOf(ThrottlingAcquisitionAbortedError);

      const admitted = vi.fn();
      const waiting = manager.acquire(other, { maxWaitMs: 2_000 });
      void waiting.then(admitted, () => {});
      await settleMicrotasks();
      await clock.advance(10);
      await settleMicrotasks();
      expect(admitted).toHaveBeenCalledOnce();
      await (await waiting).complete({ outcome: "success" });
    } finally {
      await manager.close();
    }
  });

  it("publishes the close promise before an aborting sleeper can reenter close", async () => {
    const clock = new ControlledClock();
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValue({ admitted: false, remaining: 0, retryAt: new Date(1_000) });
    const close = vi.fn(async () => undefined);
    let reentrantClose: Promise<void> | undefined;
    const manager = new ThrottlingManager({ reserve, close }, {
      namespace: "test", now: clock.now,
      sleep: (_delay, signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reentrantClose = manager.close();
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }),
    });

    const outcome = vi.fn();
    void manager.acquire(onePerSecond, { maxWaitMs: 2_000 }).then(outcome, outcome);
    await settleMicrotasks();
    const closing = manager.close();
    await setImmediate();
    // Losing the close rejection must fail without waiting on the abandoned waiter.
    expect(outcome).toHaveBeenCalledExactlyOnceWith(expect.any(ThrottlingClosedError));
    await Promise.all([closing, reentrantClose]);
    expect(reentrantClose).toBe(closing);
    expect(close).toHaveBeenCalledOnce();
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

  it("keeps a queued operation waiting for the latest blocking resource and reports its final quota", async () => {
    const clock = new ControlledClock();
    const quota = rateLimit({ id: "queued-quota", unit: "requests", limit: 5, per: seconds(1) });
    const slots = concurrencyLimit({ id: "queued-slot", limit: 1 });
    const policy = defineAdmissionPolicy({ id: "queued-composite", limits: [quota, slots] });
    const slotOnly = defineAdmissionPolicy({ id: "slot-only", limits: [slots] });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(10), source: "authoritative" })
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(30), source: "authoritative" })
      .mockResolvedValue({ admitted: true, remaining: 3, source: "authoritative" });
    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const manager = new ThrottlingManager({ reserve }, {
      namespace: "test", now: clock.now, sleep: clock.sleep, monotonicNow: () => 0, instrumentation: { record },
    });
    try {
      const settled = vi.fn();
      const waiting = manager.acquire(policy, { maxWaitMs: 100, estimatedCost: { requests: 2 } });
      void waiting.then(settled, settled);
      await settleMicrotasks();
      const occupying = await manager.acquire(slotOnly);
      await clock.advance(10);
      await settleMicrotasks();
      expect(reserve).toHaveBeenCalledOnce();

      // The retry is blocked by concurrency now and must retry when the slot returns.
      await occupying.complete({ outcome: "success" });
      await settleMicrotasks();
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(settled).not.toHaveBeenCalled();

      const other = await manager.acquire(slotOnly);
      await other.complete({ outcome: "success" });
      await settleMicrotasks();
      // Rate storage supplied a later deadline, so another slot release cannot retry it early.
      expect(reserve).toHaveBeenCalledTimes(2);
      await clock.advance(20);
      await settleMicrotasks();
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definitionId: policy.id }));
      expect(record).toHaveBeenLastCalledWith({ type: "acquisition", durationMs: 0, outcome: "success", data: {
        key: policy.id, mode: "wait", result: "acquired", cost: 2, estimatedCost: { requests: 2 },
        constraints: 2, attempts: 4, remaining: 3, source: "authoritative", waitTimeoutMs: 100,
      } });
      await (await waiting).complete({ outcome: "success" });
    } finally {
      await manager.close();
    }
  });

  it("wakes a concurrency waiter only when the constraint blocking it is released", async () => {
    const clock = new ControlledClock();
    const sleep = vi.fn(clock.sleep);
    const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
    const blocking = concurrencyLimit({ id: "local-slot", limit: 1 });
    const sibling = concurrencyLimit({ id: "sibling-slot", limit: 1 });
    const local = defineAdmissionPolicy({ id: "local", limits: [blocking, sibling] });
    const blockingOnly = defineAdmissionPolicy({ id: "blocking-only", limits: [blocking] });
    const siblingOnly = defineAdmissionPolicy({ id: "sibling-only", limits: [sibling] });
    const other = defineAdmissionPolicy({ id: "other", limits: [concurrencyLimit({ id: "other-slot", limit: 1 })] });
    const manager = new ThrottlingManager(new MemoryRateLimitAdapter({ now: clock.now }), {
      namespace: "test", now: clock.now, sleep, instrumentation: { record },
    });

    try {
      const held = await manager.acquire(blockingOnly);
      const heldSibling = await manager.acquire(siblingOnly);
      const settled = vi.fn();
      const waiting = manager.acquire(local, { maxWaitMs: 1_000 });
      void waiting.then(settled, settled);
      await setImmediate();
      expect(sleep).toHaveBeenCalledOnce();

      // The first blocker still prevents admission even after the sibling slot is released.
      await heldSibling.complete({ outcome: "success" });
      await (await manager.acquire(other)).complete({ outcome: "success" });
      await (await manager.acquire(onePerSecond)).complete({ outcome: "success" });
      await setImmediate();
      expect(sleep).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();

      await held.complete({ outcome: "success" });
      await setImmediate();
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definitionId: local.id }));
      expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ type: "acquisition", data: expect.objectContaining({ attempts: 2 }) }));
      await (await waiting).complete({ outcome: "success" });

      // A permit releasing both slots must still wake a waiter blocked by just one.
      const both = await manager.acquire(local);
      const nextSettled = vi.fn();
      const next = manager.acquire(blockingOnly, { maxWaitMs: 1_000 });
      void next.then(nextSettled, nextSettled);
      await setImmediate();
      expect(nextSettled).not.toHaveBeenCalled();
      await both.complete({ outcome: "success" });
      await setImmediate();
      expect(nextSettled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definitionId: blockingOnly.id }));
      await (await next).complete({ outcome: "success" });
    } finally {
      await manager.close();
    }
  });

  it("replaces a queued rate denial with a pressure rejection and clears it after recovery", async () => {
    const clock = new ControlledClock();
    let load = 0;
    const monitor = new LocalResourcePressureMonitor([{ supports: (id) => id === "cpu", read: () => load }], {
      now: clock.now, monotonicNow: () => clock.now().getTime(),
      healthyIntervalMs: 10, nearThresholdIntervalMs: 10, pressuredIntervalMs: 10,
    });
    const pressure = localResourcePressure({ id: "host", signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } } });
    const quota = rateLimit({ id: "pressure-quota", unit: "requests", limit: 5, per: seconds(1) });
    const policy = defineAdmissionPolicy({ id: "pressured-queue", limits: [pressure, quota] });
    const reserve = vi.fn<RateLimitAdapter["reserve"]>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(10) })
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(30) })
      .mockResolvedValue({ admitted: true, remaining: 4 });
    const manager = new ThrottlingManager({ reserve }, {
      namespace: "test", now: clock.now, sleep: clock.sleep, resourcePressureMonitor: monitor,
    });
    const estimatedCost = { requests: 1 };
    try {
      const settled = vi.fn();
      const waiting = manager.acquire(policy, { maxWaitMs: 100, estimatedCost });
      void waiting.then(settled, settled);
      await settleMicrotasks();
      load = 1;
      await clock.advance(10);
      await expect(manager.acquire(policy, { estimatedCost })).rejects.toMatchObject({
        name: "ThrottlingResourcePressureError", constraintId: pressure.id, signalIds: ["cpu"],
      });
      expect(reserve).toHaveBeenCalledOnce();

      load = 0;
      await clock.advance(10);
      await settleMicrotasks();
      await expect(manager.acquire(policy, { estimatedCost })).rejects.toMatchObject({
        name: "ThrottlingRejectedError", retryAt: new Date(30),
      });
      expect(reserve).toHaveBeenCalledTimes(2);
      await clock.advance(10);
      await settleMicrotasks();
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definitionId: policy.id }));
      await (await waiting).complete({ outcome: "success" });
    } finally {
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

  it("returns the only half-open probe when a later concurrency constraint rejects", async () => {
    const clock = new ControlledClock();
    const manager = createManager(clock);
    const breaker = circuitBreaker({ id: "probe", failureThreshold: 1, cooldown: seconds(1) });
    const slots = concurrencyLimit({ id: "probe-slots", limit: 1 });
    const circuitOnly = defineAdmissionPolicy({ id: "circuit", limits: [breaker] });
    const concurrencyOnly = defineAdmissionPolicy({ id: "slots", limits: [slots] });
    const combined = defineAdmissionPolicy({ id: "combined", limits: [breaker, slots] });
    const outage = new Error("dependency failed");

    try {
      await expect(manager.run(circuitOnly, () => { throw outage; })).rejects.toBe(outage);
      await clock.advance(1_000);

      const held = await manager.acquire(concurrencyOnly);
      try {
        // Acquiring the circuit succeeds before the composed policy finds the busy slot.
        await expect(manager.acquire(combined)).rejects.toMatchObject({ name: "ThrottlingRejectedError", source: "local" });
      } finally {
        await held.complete({ outcome: "success" });
      }
      await expect(manager.run(combined, () => "probe admitted")).resolves.toBe("probe admitted");
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
