import { setImmediate } from "node:timers/promises";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  circuitBreaker,
  defineAdmissionPolicy,
  minutes,
  rateLimit,
  type RateLimitReservationResult,
  seconds,
  ThrottlingCircuitOpenError,
  type ThrottlingInstrumentationEvent,
  type ThrottlingPermit,
  ThrottlingManager,
  ThrottlingRejectedError,
} from "./index.js";

// Cleanup also runs after failed mutation assertions, including queued acquisitions.
const ownedManagers = new Set<ThrottlingManager>();
afterEach(async () => {
  const managers = [...ownedManagers];
  ownedManagers.clear();
  await Promise.all(managers.map((manager) => manager.close()));
});

describe("process-local circuit breaking", () => {
  it("opens after consecutive classified dependency failures", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 2 });

    await completeFailure(manager, policy);
    const second = await manager.acquire(policy);
    await second.complete({
      outcome: "failure",
      feedback: { kind: "timeout" },
    });

    await expect(manager.acquire(policy)).rejects.toMatchObject({
      name: "ThrottlingCircuitOpenError",
      circuitId: "partner-health",
      retryAt: new Date(1_000),
    });
    await expect(manager.inspect(policy)).resolves.toEqual({
      state: "limited",
      retryAt: new Date(1_000),
      reasons: [{
        constraintId: "partner-health",
        kind: "circuit",
        retryAt: new Date(1_000),
      }],
    });
    await manager.close();
  });

  it("bounds half-open probes and closes after the configured successes", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({
      failureThreshold: 1,
      maxConcurrentProbes: 2,
      successThreshold: 2,
    });
    await completeFailure(manager, policy);
    await clock.advance(1_000);

    const firstProbe = await manager.acquire(policy);
    const secondProbe = await manager.acquire(policy);
    await expect(manager.acquire(policy)).rejects.toBeInstanceOf(
      ThrottlingCircuitOpenError,
    );

    await firstProbe.complete({ outcome: "success" });
    const replacementProbe = await manager.acquire(policy);
    // A single success must not close the circuit or remove the probe limit.
    await expect(manager.acquire(policy)).rejects.toBeInstanceOf(ThrottlingCircuitOpenError);
    await expect(manager.inspect(policy)).resolves.toEqual({
      state: "limited", reasons: [{ constraintId: "partner-health", kind: "circuit" }],
    });
    await secondProbe.complete({ outcome: "success" });
    // After the threshold, ordinary admissions no longer consume probe capacity.
    const ordinary = await manager.acquire(policy);
    const another = await manager.acquire(policy);
    await ordinary.complete({ outcome: "success" });
    await another.complete({ outcome: "success" });
    await replacementProbe.complete({ outcome: "success" });

    const admitted = await manager.acquire(policy);
    await admitted.complete({ outcome: "success" });
    await manager.close();
  });

  it("ignores stale probe completions after another probe reopens the circuit", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({
      failureThreshold: 1,
      maxConcurrentProbes: 2,
      successThreshold: 2,
    });
    await completeFailure(manager, policy);
    await clock.advance(1_000);
    const failedProbe = await manager.acquire(policy);
    const staleProbe = await manager.acquire(policy);

    await failedProbe.complete({ outcome: "failure" });
    await staleProbe.complete({ outcome: "success" });

    await expect(manager.acquire(policy)).rejects.toMatchObject({
      retryAt: new Date(2_000),
    });
    await manager.close();
  });

  it("honors explicit throttling retry times without waiting for the threshold", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 10 });
    const permit = await manager.acquire(policy);

    await permit.complete({
      outcome: "failure",
      feedback: {
        kind: "throttled",
        retryAt: new Date(5_000),
      },
    });

    await expect(manager.acquire(policy)).rejects.toMatchObject({
      retryAt: new Date(5_000),
    });
    await manager.close();
  });

  it("treats permanent failures as healthy circuit feedback", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 2 });
    await completeFailure(manager, policy);
    const permanent = await manager.acquire(policy);
    await permanent.complete({
      outcome: "failure",
      feedback: { kind: "permanent" },
    });

    await completeFailure(manager, policy);
    const stillClosed = await manager.acquire(policy);
    await stillClosed.complete({ outcome: "success" });
    await manager.close();
  });

  it("keeps prior closed-state failures without adding a failure for cancellation", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 2 });
    const cancelled = new DOMException("caller cancelled", "AbortError");

    await completeFailure(manager, policy);
    await expect(manager.run(policy, (context) => {
      context.reportFeedback({ kind: "cancelled" });
      throw cancelled;
    })).rejects.toBe(cancelled);
    await expect(manager.inspect(policy)).resolves.toEqual({ state: "available", reasons: [] });

    // Cancellation must not erase an earlier dependency failure either.
    await completeFailure(manager, policy);
    await expect(manager.acquire(policy)).rejects.toBeInstanceOf(ThrottlingCircuitOpenError);
  });

  it("returns a cancelled half-open slot without reopening or advancing recovery", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 1, successThreshold: 2 });
    await completeFailure(manager, policy);
    await clock.advance(1_000);
    const abandoned = await manager.acquire(policy);
    await abandoned.complete({ outcome: "failure", feedback: { kind: "cancelled" } });

    const firstSuccess = await manager.acquire(policy);
    await expect(manager.acquire(policy)).rejects.toBeInstanceOf(ThrottlingCircuitOpenError);
    await firstSuccess.complete({ outcome: "success" });
    const finalProbe = await manager.acquire(policy);
    // Counting the cancelled probe as success would already have closed the circuit.
    await expect(manager.acquire(policy)).rejects.toBeInstanceOf(ThrottlingCircuitOpenError);
    await finalProbe.complete({ outcome: "success" });

    const closed = await manager.acquire(policy);
    const concurrent = await manager.acquire(policy);
    await Promise.all([closed.complete({ outcome: "success" }), concurrent.complete({ outcome: "success" })]);
  });

  it("checks circuits before consuming authoritative rate capacity", async () => {
    const clock = new CircuitClock();
    let rateReservations = 0;
    const manager = new ThrottlingManager({
      reserve: async () => {
        rateReservations += 1;
        return { admitted: true, remaining: 9 };
      },
    }, { namespace: "test", now: clock.now });
    ownedManagers.add(manager);
    const policy = defineAdmissionPolicy({
      id: "composed-partner",
      limits: [
        circuitBreaker({
          id: "partner-health",
          failureThreshold: 1,
          cooldown: seconds(1),
        }),
        rateLimit({
          id: "partner-rate",
          unit: "requests",
          limit: 10,
          per: minutes(1),
        }),
      ],
    });
    const permit = await manager.acquire(policy, {
      estimatedCost: { requests: 1 },
    });
    await permit.complete({ outcome: "failure" });

    await expect(manager.acquire(policy, {
      estimatedCost: { requests: 1 },
    })).rejects.toBeInstanceOf(ThrottlingCircuitOpenError);
    expect(rateReservations).toBe(1);
    await manager.close();
  });

  it("returns a half-open probe when a later rate constraint rejects", async () => {
    const clock = new CircuitClock();
    let admitRate = true;
    const manager = new ThrottlingManager({
      reserve: async () => admitRate
        ? { admitted: true, remaining: 9 }
        : {
            admitted: false,
            remaining: 0,
            retryAt: new Date(2_000),
          },
    }, { namespace: "test", now: clock.now });
    ownedManagers.add(manager);
    const policy = defineAdmissionPolicy({
      id: "probe-compensation",
      limits: [
        circuitBreaker({
          id: "compensated-health",
          failureThreshold: 1,
          cooldown: seconds(1),
          halfOpen: { maxConcurrentProbes: 2, successThreshold: 2 },
        }),
        rateLimit({
          id: "compensated-rate",
          unit: "requests",
          limit: 10,
          per: minutes(1),
        }),
      ],
    });
    const options = { estimatedCost: { requests: 1 } };
    const initial = await manager.acquire(policy, options);
    await initial.complete({ outcome: "failure" });
    await clock.advance(1_000);
    const outstandingProbe = await manager.acquire(policy, options);
    admitRate = false;

    await expect(manager.acquire(policy, options)).rejects.toBeInstanceOf(
      ThrottlingRejectedError,
    );
    admitRate = true;
    const replacementProbe = await manager.acquire(policy, options);
    // Compensation must return exactly one slot, preserving the other active probe.
    await expect(manager.acquire(policy, options)).rejects.toBeInstanceOf(ThrottlingCircuitOpenError);
    await outstandingProbe.complete({ outcome: "success" });
    await replacementProbe.complete({ outcome: "success" });
    await manager.close();
  });

  it("opens before synchronous cost reconciliation finishes", async () => {
    const clock = new CircuitClock();
    let finishReconciliation: () => void = () => undefined;
    const reconciliation = new Promise<void>((resolve) => {
      finishReconciliation = resolve;
    });
    const manager = new ThrottlingManager({
      reserve: async () => ({ admitted: true, remaining: 9 }),
      reconcile: async () => {
        await reconciliation;
        return { "test:independent-rate": 8 };
      },
    }, { namespace: "test", now: clock.now });
    ownedManagers.add(manager);
    const policy = defineAdmissionPolicy({
      id: "independent-circuit-accounting",
      limits: [
        circuitBreaker({
          id: "independent-health",
          failureThreshold: 1,
          cooldown: seconds(1),
        }),
        rateLimit({
          id: "independent-rate",
          unit: "requests",
          limit: 10,
          per: minutes(1),
        }),
      ],
      costAccounting: { reconciliation: "synchronous" },
    });
    const options = { estimatedCost: { requests: 1 } };
    const permit = await manager.acquire(policy, options);
    const completion = permit.complete({
      outcome: "failure",
      actualCost: { requests: 2 },
    });

    await expect(manager.acquire(policy, options)).rejects.toBeInstanceOf(
      ThrottlingCircuitOpenError,
    );
    finishReconciliation();
    await completion;
    await manager.close();
  });

  it("shares circuit health across policies without sharing policy identity", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const sharedCircuit = circuitBreaker({
      id: "shared-partner-health",
      failureThreshold: 1,
      cooldown: seconds(1),
    });
    const firstPolicy = defineAdmissionPolicy({
      id: "first-operation",
      limits: [sharedCircuit],
    });
    const secondPolicy = defineAdmissionPolicy({
      id: "second-operation",
      limits: [sharedCircuit],
    });
    const permit = await manager.acquire(firstPolicy);
    await permit.complete({ outcome: "failure" });

    await expect(manager.acquire(secondPolicy)).rejects.toMatchObject({
      circuitId: "shared-partner-health",
    });
    await manager.close();
  });

  it("records dependency feedback even when the caller returns a fallback", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 1 });

    await expect(manager.run(policy, ({ reportFeedback }) => {
      reportFeedback({ kind: "timeout" });
      return "fallback";
    })).resolves.toBe("fallback");
    await expect(manager.acquire(policy)).rejects.toBeInstanceOf(
      ThrottlingCircuitOpenError,
    );
    await manager.close();
  });

  it("wakes a bounded waiter when the cooldown reaches half-open", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 1 });
    await completeFailure(manager, policy);
    const waiting = manager.acquire(policy, { maxWaitMs: 2_000 });
    await settleMicrotasks();

    expect(clock.pendingSleeps).toBe(1);
    await clock.advance(1_000);
    const probe = await waiting;
    await probe.complete({ outcome: "success" });
    await manager.close();
  });

  it("reports feedback and every circuit transition through instrumentation", async () => {
    const clock = new CircuitClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = createManager(clock, events);
    const policy = circuitPolicy({ failureThreshold: 1 });

    await expect(manager.run(policy, ({ reportFeedback }) => {
      reportFeedback({ kind: "timeout" });
      throw new Error("timed out");
    })).rejects.toThrow("timed out");
    await clock.advance(1_000);
    const probe = await manager.acquire(policy);
    await probe.complete({ outcome: "success" });

    // Observe the full circuit contract, including absent stale retry timestamps.
    const base = { key: "test:partner-health", consecutiveFailures: 0, activeProbes: 0 };
    expect(events.filter((event) => event.type === "circuit")).toStrictEqual([
      { type: "circuit", outcome: "failure", durationMs: 0, data: { ...base, operation: "feedback", state: "closed", feedback: "timeout" } },
      { type: "circuit", outcome: "failure", durationMs: 0, data: { ...base, consecutiveFailures: 1, operation: "transition", state: "open", previousState: "closed", retryAt: new Date(1_000).toISOString() } },
      { type: "circuit", outcome: "success", durationMs: 0, data: { ...base, consecutiveFailures: 1, operation: "transition", state: "half-open", previousState: "open" } },
      { type: "circuit", outcome: "success", durationMs: 0, data: { ...base, consecutiveFailures: 1, activeProbes: 1, operation: "probe", state: "half-open" } },
      { type: "circuit", outcome: "success", durationMs: 0, data: { ...base, consecutiveFailures: 1, operation: "feedback", state: "half-open", feedback: "success" } },
      { type: "circuit", outcome: "success", durationMs: 0, data: { ...base, operation: "transition", state: "closed", previousState: "half-open" } },
    ]);
    expect(events.find((event) => event.type === "completion")?.data)
      .toMatchObject({ feedback: "timeout" });
    await manager.close();
  });

  it("refreshes inspection exactly at cooldown expiry and reports occupied probes", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 1 });
    await completeFailure(manager, policy);
    await clock.advance(999);
    await expect(manager.inspect(policy)).resolves.toMatchObject({ state: "limited", retryAt: new Date(1_000) });
    await clock.advance(1);
    // Inspection must refresh an expired open circuit without an intervening acquire.
    await expect(manager.inspect(policy)).resolves.toEqual({ state: "available", reasons: [] });
    const probe = await manager.acquire(policy);
    await expect(manager.inspect(policy)).resolves.toEqual({
      state: "limited", reasons: [{ constraintId: "partner-health", kind: "circuit" }],
    });
    await probe.complete({ outcome: "success" });
    await expect(manager.inspect(policy)).resolves.toEqual({ state: "available", reasons: [] });
  });

  it.each([undefined, new Date(-1), new Date(0)])("uses the cooldown when throttled retryAt is %s", async (retryAt) => {
    const clock = new CircuitClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = createManager(clock, events);
    const policy = circuitPolicy({ failureThreshold: 10 });
    const permit = await manager.acquire(policy);
    // Missing or expired upstream retry times must not bypass the local cooldown.
    await permit.complete({ outcome: "failure", feedback: { kind: "throttled", ...(retryAt === undefined ? {} : { retryAt }) } });
    await expect(manager.acquire(policy)).rejects.toMatchObject({ retryAt: new Date(1_000) });
    expect(events.filter((event) => event.type === "circuit")).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "failure", data: expect.objectContaining({ operation: "feedback", feedback: "throttled" }) }),
    ]));
    await clock.advance(999);
    await expect(manager.acquire(policy)).rejects.toBeInstanceOf(ThrottlingCircuitOpenError);
    await clock.advance(1);
    const probe = await manager.acquire(policy);
    await probe.complete({ outcome: "success" });
  });

  it.each(["success", "permanent", "transient", "timeout", "throttled"] as const)("reports %s feedback with its circuit outcome", async (kind) => {
    const clock = new CircuitClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = createManager(clock, events);
    const policy = circuitPolicy({ failureThreshold: 10 });
    const permit = await manager.acquire(policy);
    await permit.complete(kind === "success"
      ? { outcome: "success" }
      : { outcome: "failure", feedback: { kind } });
    // Closed-circuit feedback must retain classification even before any transition.
    expect(events.filter((event) => event.type === "circuit" && event.data.operation === "feedback")).toEqual([
      {
        type: "circuit", durationMs: 0,
        outcome: kind === "success" || kind === "permanent" ? "success" : "failure",
        data: { key: "test:partner-health", operation: "feedback", state: "closed", consecutiveFailures: 0, activeProbes: 0, feedback: kind },
      },
    ]);
  });

  it("ignores a stale failure after a newer generation has recovered", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 1 });
    const stale = await manager.acquire(policy);
    await completeFailure(manager, policy);
    await clock.advance(1_000);
    const probe = await manager.acquire(policy);
    await probe.complete({ outcome: "success" });
    // An old invocation must not reopen a freshly recovered closed circuit.
    await stale.complete({ outcome: "failure" });
    await expect(manager.inspect(policy)).resolves.toEqual({ state: "available", reasons: [] });
  });

  it("wakes a queued waiter immediately when a successful probe returns capacity", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const policy = circuitPolicy({ failureThreshold: 1, successThreshold: 2 });
    await completeFailure(manager, policy);
    await clock.advance(1_000);
    const first = await manager.acquire(policy);
    let admitted = false;
    // Attach rejection handling before any assertion so failed mutants cannot leak it.
    const waiting = manager.acquire(policy, { maxWaitMs: 10_000 }).then(
      (permit) => { admitted = true; return permit; },
      () => undefined,
    );
    await settleMicrotasks();
    expect(clock.pendingSleeps).toBe(1);
    expect(admitted).toBe(false);
    await first.complete({ outcome: "success" });
    await settleMicrotasks();
    // No clock advance: the waiter must be notified rather than timing out later.
    expect(admitted).toBe(true);
    const second = await waiting;
    expect(second).toBeDefined();
    await second!.complete({ outcome: "success" });
    await manager.close();
    expect(clock.pendingSleeps).toBe(0);
  });

  it("keeps waiters on independent circuits asleep when another circuit releases a probe", async () => {
    const clock = new CircuitClock();
    const manager = createManager(clock);
    const firstPolicy = circuitPolicy({ failureThreshold: 1, successThreshold: 2 });
    const otherPolicy = circuitPolicy({ failureThreshold: 1, successThreshold: 2 }, "other");
    await completeFailure(manager, firstPolicy);
    await completeFailure(manager, otherPolicy);
    await clock.advance(1_000);
    const firstProbe = await manager.acquire(firstPolicy);
    const otherProbe = await manager.acquire(otherPolicy);
    const firstWaiter = observeAcquisition(manager.acquire(firstPolicy, { maxWaitMs: 10_000 }));
    const otherWaiter = observeAcquisition(manager.acquire(otherPolicy, { maxWaitMs: 10_000 }));
    await settleMicrotasks();
    expect(clock.pendingSleeps).toBe(2);
    const sleepsBeforeRelease = clock.sleepCalls;

    await firstProbe.complete({ outcome: "success" });
    await settleMicrotasks();
    expect(firstWaiter.permit).toBeDefined();
    expect(otherWaiter.settled).toBe(false);
    // An unrelated queue must not be woken and rescheduled by this notification.
    expect(clock.sleepCalls).toBe(sleepsBeforeRelease);
    expect(clock.pendingSleeps).toBe(1);
    await otherProbe.complete({ outcome: "success" });
    await settleMicrotasks();
    expect(otherWaiter.permit).toBeDefined();
    await firstWaiter.permit!.complete({ outcome: "success" });
    await otherWaiter.permit!.complete({ outcome: "success" });
  });

  it("reschedules existing waiters to the new cooldown when a probe reopens the circuit", async () => {
    const clock = new CircuitClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = createManager(clock, events);
    const policy = circuitPolicy({ failureThreshold: 1 });
    await completeFailure(manager, policy);
    await clock.advance(1_000);
    const probe = await manager.acquire(policy);
    const waiting = observeAcquisition(manager.acquire(policy, { maxWaitMs: 10_000 }));
    await settleMicrotasks();
    expect(clock.nextWakeAtMs).toBe(11_000);

    await probe.complete({ outcome: "failure" });
    await settleMicrotasks();
    // The old deadline sleep must be replaced by the newly known retry time.
    expect(clock.nextWakeAtMs).toBe(2_000);
    await clock.advance(999);
    expect(waiting.settled).toBe(false);
    await clock.advance(1);
    expect(waiting.permit).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "acquisition", outcome: "success", data: { attempts: 2 } });
    await waiting.permit!.complete({ outcome: "success" });
  });

  it("replaces a recovered circuit blocker with the backend retry deadline", async () => {
    const clock = new CircuitClock();
    const reserve = vi.fn<() => Promise<RateLimitReservationResult>>()
      .mockResolvedValueOnce({ admitted: false, remaining: 0, retryAt: new Date(2_000) })
      .mockResolvedValue({ admitted: true, remaining: 9 });
    const manager = new ThrottlingManager({ reserve }, { namespace: "test", now: clock.now, sleep: clock.sleep });
    ownedManagers.add(manager);
    const health = circuitPolicy({ failureThreshold: 1, successThreshold: 2 });
    const policy = rateCircuitPolicy(1);
    const options = { estimatedCost: { requests: 1 } };
    await completeFailure(manager, health);
    const waiting = observeAcquisition(manager.acquire(policy, { ...options, maxWaitMs: 5_000 }));
    await settleMicrotasks();
    expect(clock.nextWakeAtMs).toBe(1_000);
    expect(reserve).not.toHaveBeenCalled();

    // The half-open retry reached storage, which now owns the advertised deadline.
    await clock.advance(1_000);
    expect(waiting.settled).toBe(false);
    await expect(manager.acquire(policy, options)).rejects.toMatchObject({
      name: "ThrottlingRejectedError", retryAt: new Date(2_000),
    });
    expect(clock.nextWakeAtMs).toBe(2_000);
    await clock.advance(1_000);
    expect(waiting.permit).toBeDefined();
    await waiting.permit!.complete({ outcome: "success" });
  });

  it("does not return an old probe into a newer half-open generation", async () => {
    const clock = new CircuitClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    const reservation = Promise.withResolvers<RateLimitReservationResult>();
    let deferNextReservation = false;
    const manager = new ThrottlingManager({
      reserve: async () => {
        if (deferNextReservation) {
          deferNextReservation = false;
          return reservation.promise;
        }
        return { admitted: true, remaining: 9 };
      },
    }, { namespace: "test", now: clock.now, instrumentation: { record: (event) => events.push(event) } });
    ownedManagers.add(manager);
    const policy = rateCircuitPolicy();
    const options = { estimatedCost: { requests: 1 } };
    try {
      const initial = await manager.acquire(policy, options);
      await initial.complete({ outcome: "failure" });
      await clock.advance(1_000);
      const failedProbe = await manager.acquire(policy, options);
      deferNextReservation = true;
      const stale = observeAcquisition(manager.acquire(policy, options));
      await settleMicrotasks();
      expect(stale.settled).toBe(false);
      await failedProbe.complete({ outcome: "failure" });
      await clock.advance(1_000);
      const currentFirst = await manager.acquire(policy, options);
      const currentSecond = await manager.acquire(policy, options);
      const eventCount = events.length;

      // Complete the old backend request only after the new generation is saturated.
      reservation.resolve({ admitted: false, remaining: 0, retryAt: new Date(3_000) });
      await settleMicrotasks();
      expect(stale.error).toBeInstanceOf(ThrottlingRejectedError);
      expect(events.slice(eventCount).filter((event) => event.type === "circuit")).toEqual([]);
      await expect(manager.acquire(policy, options)).rejects.toBeInstanceOf(ThrottlingCircuitOpenError);
      await currentFirst.complete({ outcome: "success" });
      await currentSecond.complete({ outcome: "success" });
    } finally {
      // Resolve even when a mutant fails early; no backend request outlives the test.
      reservation.resolve({ admitted: false, remaining: 0, retryAt: new Date(3_000) });
      await settleMicrotasks();
    }
  });

  it("notifies waiters and reports the returned probe when a backend reservation rejects", async () => {
    const clock = new CircuitClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    const reservation = Promise.withResolvers<RateLimitReservationResult>();
    let deferNextReservation = false;
    const manager = new ThrottlingManager({
      reserve: async () => {
        if (deferNextReservation) {
          deferNextReservation = false;
          return reservation.promise;
        }
        return { admitted: true, remaining: 9 };
      },
    }, { namespace: "test", now: clock.now, sleep: clock.sleep, instrumentation: { record: (event) => events.push(event) } });
    ownedManagers.add(manager);
    const policy = rateCircuitPolicy(1);
    const options = { estimatedCost: { requests: 1 } };
    try {
      const initial = await manager.acquire(policy, options);
      await initial.complete({ outcome: "failure" });
      await clock.advance(1_000);
      deferNextReservation = true;
      const rejected = observeAcquisition(manager.acquire(policy, options));
      const waiting = observeAcquisition(manager.acquire(policy, { ...options, maxWaitMs: 10_000 }));
      await settleMicrotasks();
      expect(clock.pendingSleeps).toBe(1);
      const eventCount = events.length;
      reservation.resolve({ admitted: false, remaining: 0, retryAt: new Date(2_000) });
      await settleMicrotasks();
      // Returning a probe is an immediate capacity notification, without advancing time.
      expect(rejected.error).toBeInstanceOf(ThrottlingRejectedError);
      expect(waiting.permit).toBeDefined();
      expect(events.slice(eventCount).filter((event) => event.type === "circuit")).toMatchObject([
        { data: { operation: "probe", state: "half-open", activeProbes: 0 } },
        { data: { operation: "probe", state: "half-open", activeProbes: 1 } },
      ]);
      await waiting.permit!.complete({ outcome: "success" });
    } finally {
      reservation.resolve({ admitted: false, remaining: 0, retryAt: new Date(2_000) });
      await settleMicrotasks();
    }
  });

  it("classifies an unreported failure as transient in circuit and completion events", async () => {
    const clock = new CircuitClock();
    const events: ThrottlingInstrumentationEvent[] = [];
    const manager = createManager(clock, events);
    const policy = circuitPolicy({ failureThreshold: 2 });
    await completeFailure(manager, policy);
    // The default classification is observable even before the circuit opens.
    expect(events.filter((event) => event.type === "circuit")).toMatchObject([
      { outcome: "failure", data: { operation: "feedback", state: "closed", feedback: "transient" } },
    ]);
    expect(events.find((event) => event.type === "completion")?.data).toMatchObject({ feedback: "transient" });
  });
});

function circuitPolicy(options: {
  failureThreshold: number;
  maxConcurrentProbes?: number;
  successThreshold?: number;
}, name = "partner") {
  return defineAdmissionPolicy({
    id: `${name}-policy`,
    limits: [circuitBreaker({
      id: `${name}-health`,
      failureThreshold: options.failureThreshold,
      cooldown: seconds(1),
      halfOpen: {
        maxConcurrentProbes: options.maxConcurrentProbes ?? 1,
        successThreshold: options.successThreshold ?? 1,
      },
    })],
  });
}

/** Composed policy whose backend can stay pending while local circuit state changes. */
function rateCircuitPolicy(maxConcurrentProbes = 2) {
  return defineAdmissionPolicy({
    id: "deferred-rate-policy",
    limits: [
      circuitBreaker({
        id: "partner-health", failureThreshold: 1, cooldown: seconds(1),
        halfOpen: { maxConcurrentProbes, successThreshold: 2 },
      }),
      rateLimit({ id: "partner-rate", unit: "requests", limit: 10, per: minutes(1) }),
    ],
  });
}

/** Observe progress without awaiting a mutant that might never notify its waiter. */
function observeAcquisition(acquisition: Promise<ThrottlingPermit>) {
  const progress = { settled: false, permit: undefined as ThrottlingPermit | undefined, error: undefined as unknown };
  void acquisition.then(
    (permit) => { progress.settled = true; progress.permit = permit; },
    (error: unknown) => { progress.settled = true; progress.error = error; },
  );
  return progress;
}

function createManager(
  clock: CircuitClock,
  events?: ThrottlingInstrumentationEvent[],
): ThrottlingManager {
  const manager = new ThrottlingManager({
    reserve: async () => {
      throw new Error("Circuit-only policies must not call rate storage.");
    },
  }, {
    namespace: "test",
    now: clock.now,
    sleep: clock.sleep,
    ...(events === undefined
      ? {}
      : { instrumentation: { record: (event) => events.push(event) } }),
  });
  ownedManagers.add(manager);
  return manager;
}

async function completeFailure(
  manager: ThrottlingManager,
  policy: ReturnType<typeof circuitPolicy>,
): Promise<void> {
  const permit = await manager.acquire(policy);
  await permit.complete({ outcome: "failure" });
}

interface PendingSleep {
  wakeAtMs: number;
  signal: AbortSignal;
  abortListener: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Per-test wall clock that restores every abort listener it installs. */
class CircuitClock {
  private currentMs = 0;

  public sleepCalls = 0;

  private readonly sleepers: PendingSleep[] = [];

  public readonly now = (): Date => new Date(this.currentMs);

  public readonly sleep = (
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> => new Promise((resolve, reject) => {
    this.sleepCalls += 1;
    const pending: PendingSleep = {
      wakeAtMs: this.currentMs + delayMs,
      signal,
      abortListener: () => undefined,
      resolve,
      reject,
    };
    pending.abortListener = () => {
      this.remove(pending);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", pending.abortListener, { once: true });
    this.sleepers.push(pending);
  });

  public get pendingSleeps(): number {
    return this.sleepers.length;
  }

  public get nextWakeAtMs(): number {
    return Math.min(...this.sleepers.map((pending) => pending.wakeAtMs));
  }

  public async advance(delayMs: number): Promise<void> {
    this.currentMs += delayMs;

    for (const pending of [...this.sleepers]) {
      if (pending.wakeAtMs > this.currentMs) continue;
      this.remove(pending);
      pending.resolve();
    }

    await settleMicrotasks();
  }

  private remove(pending: PendingSleep): void {
    pending.signal.removeEventListener("abort", pending.abortListener);
    const index = this.sleepers.indexOf(pending);
    if (index >= 0) this.sleepers.splice(index, 1);
  }
}

async function settleMicrotasks(): Promise<void> {
  // Drain complete backend/queue promise chains without assuming a fixed depth.
  await setImmediate();
}
