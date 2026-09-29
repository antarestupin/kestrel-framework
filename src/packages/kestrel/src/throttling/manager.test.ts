import { describe, expect, it } from "vitest";

import {
  defineRateLimit,
  MemoryRateLimitAdapter,
  seconds,
  ThrottlingAcquisitionAbortedError,
  ThrottlingAcquisitionTimeoutError,
  ThrottlingClosedError,
  type ThrottlingInstrumentationEvent,
  ThrottlingManager,
  ThrottlingPermitCompletedError,
  ThrottlingQueueFullError,
  ThrottlingRejectedError,
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
