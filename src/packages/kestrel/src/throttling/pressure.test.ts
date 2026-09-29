import { describe, expect, it } from "vitest";

import {
  defineAdmissionPolicy,
  localResourcePressure,
  LocalResourcePressureMonitor,
  minutes,
  rateLimit,
  ThrottlingAcquisitionTimeoutError,
  type ThrottlingInstrumentationEvent,
  ThrottlingManager,
  ThrottlingResourcePressureError,
  type LocalResourcePressureSource,
} from "./index.js";

describe("process-local resource pressure", () => {
  it("admits degraded work and exposes the signal through inspection", async () => {
    const fixture = createFixture(0.85);

    const permit = await fixture.manager.acquire(fixture.policy);
    await permit.complete({ outcome: "success" });
    await expect(fixture.manager.inspect(fixture.policy)).resolves.toEqual({
      state: "degraded",
      reasons: [{
        constraintId: "process-pressure",
        kind: "pressure",
        signalId: "cpu",
        value: 0.85,
      }],
    });
    await fixture.manager.close();
  });

  it("rejects critical pressure before circuits, slots, or rate storage", async () => {
    let reservations = 0;
    const fixture = createFixture(0.95, {
      reserve: async () => {
        reservations += 1;
        return { admitted: true, remaining: 9 };
      },
      withRate: true,
    });

    await expect(fixture.manager.acquire(fixture.policy, {
      estimatedCost: { requests: 1 },
    })).rejects.toMatchObject({
      name: "ThrottlingResourcePressureError",
      constraintId: "process-pressure",
      signalIds: ["cpu"],
      retryAt: undefined,
    });
    expect(reservations).toBe(0);
    await fixture.manager.close();
  });

  it("supports explicit fail-open behavior for an unavailable signal", async () => {
    const fixture = createFixture(undefined, { onUnavailable: "ignore" });

    const permit = await fixture.manager.acquire(fixture.policy);
    await permit.complete({ outcome: "success" });
    await expect(fixture.manager.inspect(fixture.policy)).resolves.toEqual({
      state: "degraded",
      reasons: [{
        constraintId: "process-pressure",
        kind: "pressure",
        signalId: "cpu",
      }],
    });
    await fixture.manager.close();
  });

  it("fails closed and reports unknown when a required reader is unavailable", async () => {
    const fixture = createFixture(undefined);

    await expect(fixture.manager.acquire(fixture.policy)).rejects
      .toBeInstanceOf(ThrottlingResourcePressureError);
    await expect(fixture.manager.inspect(fixture.policy)).resolves.toEqual({
      state: "unknown",
      reasons: [{
        constraintId: "process-pressure",
        kind: "pressure",
        signalId: "cpu",
      }],
    });
    await fixture.manager.close();
  });

  it("retries cached pressure during a bounded wait", async () => {
    const clock = new PressureClock();
    const fixture = createFixture(0.95, { clock });
    const waiting = fixture.manager.acquire(fixture.policy, { maxWaitMs: 1_000 });
    await settleMicrotasks();

    expect(clock.pendingSleeps).toBe(1);
    fixture.source.value = 0.1;
    await clock.advance(250);
    const permit = await waiting;
    await permit.complete({ outcome: "success" });
    await fixture.manager.close();
  });

  it("times out a waiter without publishing a speculative retry date", async () => {
    const clock = new PressureClock();
    const fixture = createFixture(0.95, { clock });
    const waiting = fixture.manager.acquire(fixture.policy, { maxWaitMs: 200 });
    await settleMicrotasks();
    await clock.advance(200);

    await expect(waiting).rejects.toBeInstanceOf(
      ThrottlingAcquisitionTimeoutError,
    );
    await fixture.manager.close();
  });

  it("records bounded pressure transitions and rejected signals", async () => {
    const events: ThrottlingInstrumentationEvent[] = [];
    const clock = new PressureClock();
    const fixture = createFixture(0.95, { clock, events });

    await expect(fixture.manager.acquire(fixture.policy)).rejects
      .toBeInstanceOf(ThrottlingResourcePressureError);
    fixture.source.value = 0.1;
    await clock.advance(250);
    const permit = await fixture.manager.acquire(fixture.policy);
    await permit.complete({ outcome: "success" });

    expect(events.filter((event) => event.type === "pressure").map((event) =>
      event.data.operation)).toEqual(["rejection", "transition"]);
    await fixture.manager.close();
  });
});

function createFixture(
  initial: number | undefined,
  options: {
    clock?: PressureClock;
    events?: ThrottlingInstrumentationEvent[];
    onUnavailable?: "ignore" | "reject";
    reserve?: () => Promise<{ admitted: true; remaining: number }>;
    withRate?: boolean;
  } = {},
) {
  const clock = options.clock ?? new PressureClock();
  const source = new MutablePressureSource(initial);
  const monitor = new LocalResourcePressureMonitor([source], {
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    healthyIntervalMs: 1_000,
    nearThresholdIntervalMs: 500,
    pressuredIntervalMs: 250,
  });
  const pressure = localResourcePressure({
    id: "process-pressure",
    signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } },
    ...(options.onUnavailable === undefined
      ? {}
      : { onUnavailable: options.onUnavailable }),
  });
  const policy = defineAdmissionPolicy({
    id: "protected-operation",
    limits: options.withRate
      ? [
          pressure,
          rateLimit({
            id: "external-rate",
            unit: "requests",
            limit: 10,
            per: minutes(1),
          }),
        ]
      : [pressure],
  });
  const manager = new ThrottlingManager({
    reserve: options.reserve ?? (async () => {
      throw new Error("Pressure-only policies must not call rate storage.");
    }),
  }, {
    namespace: "test",
    now: clock.now,
    sleep: clock.sleep,
    resourcePressureMonitor: monitor,
    ...(options.events === undefined
      ? {}
      : { instrumentation: { record: (event) => options.events!.push(event) } }),
  });

  return { clock, manager, policy, source };
}

class MutablePressureSource implements LocalResourcePressureSource {
  public constructor(public value: number | undefined) {}

  public supports(signalId: string): boolean {
    return signalId === "cpu";
  }

  public read(): number | undefined {
    return this.value;
  }
}

interface PendingSleep {
  wakeAtMs: number;
  signal: AbortSignal;
  abortListener: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Deterministic per-test clock that removes every abort listener. */
class PressureClock {
  private currentMs = 0;

  private readonly sleepers: PendingSleep[] = [];

  public readonly now = (): Date => new Date(this.currentMs);

  public readonly monotonicNow = (): number => this.currentMs;

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
    const index = this.sleepers.indexOf(pending);
    if (index >= 0) this.sleepers.splice(index, 1);
    pending.signal.removeEventListener("abort", pending.abortListener);
  }
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
