import {
  describe,
  expect,
  it,
} from "vitest";

import {
  circuitBreaker,
  defineAdmissionPolicy,
  minutes,
  rateLimit,
  seconds,
  ThrottlingCircuitOpenError,
  type ThrottlingInstrumentationEvent,
  ThrottlingManager,
  ThrottlingRejectedError,
} from "./index.js";

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
    await secondProbe.complete({ outcome: "success" });
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

  it("checks circuits before consuming authoritative rate capacity", async () => {
    const clock = new CircuitClock();
    let rateReservations = 0;
    const manager = new ThrottlingManager({
      reserve: async () => {
        rateReservations += 1;
        return { admitted: true, remaining: 9 };
      },
    }, { namespace: "test", now: clock.now });
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
    const policy = defineAdmissionPolicy({
      id: "probe-compensation",
      limits: [
        circuitBreaker({
          id: "compensated-health",
          failureThreshold: 1,
          cooldown: seconds(1),
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
    admitRate = false;

    await expect(manager.acquire(policy, options)).rejects.toBeInstanceOf(
      ThrottlingRejectedError,
    );
    admitRate = true;
    const replacementProbe = await manager.acquire(policy, options);
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

    expect(events.filter((event) => event.type === "circuit").map((event) =>
      event.data.operation)).toEqual([
      "feedback",
      "transition",
      "transition",
      "probe",
      "feedback",
      "transition",
    ]);
    expect(events.find((event) => event.type === "completion")?.data)
      .toMatchObject({ feedback: "timeout" });
    await manager.close();
  });
});

function circuitPolicy(options: {
  failureThreshold: number;
  maxConcurrentProbes?: number;
  successThreshold?: number;
}) {
  return defineAdmissionPolicy({
    id: "partner-policy",
    limits: [circuitBreaker({
      id: "partner-health",
      failureThreshold: options.failureThreshold,
      cooldown: seconds(1),
      halfOpen: {
        maxConcurrentProbes: options.maxConcurrentProbes ?? 1,
        successThreshold: options.successThreshold ?? 1,
      },
    })],
  });
}

function createManager(
  clock: CircuitClock,
  events?: ThrottlingInstrumentationEvent[],
): ThrottlingManager {
  return new ThrottlingManager({
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

  private readonly sleepers: PendingSleep[] = [];

  public readonly now = (): Date => new Date(this.currentMs);

  public readonly sleep = (
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> => new Promise((resolve, reject) => {
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
  for (let iteration = 0; iteration < 8; iteration += 1) {
    await Promise.resolve();
  }
}
