import { describe, expect, it, vi } from "vitest";

import { localResourcePressure } from "../definitions.js";
import {
  LocalResourcePressureMonitor,
  type LocalResourcePressureSource,
} from "./monitor.js";

describe("LocalResourcePressureMonitor", () => {
  it("shares cached samples and progressively shortens configured intervals", () => {
    let nowMs = 0;
    const source = new MutablePressureSource("cpu", 0.1);
    const pressure = localResourcePressure({
      id: "process",
      signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } },
    });
    const monitor = new LocalResourcePressureMonitor([source], {
      now: () => new Date(nowMs),
      monotonicNow: () => nowMs,
      healthyIntervalMs: 1_000,
      nearThresholdIntervalMs: 500,
      pressuredIntervalMs: 250,
      nearThresholdRatio: 0.2,
    });

    expect(monitor.evaluate("process", pressure.signals, "reject"))
      .toMatchObject({ state: "healthy", refreshAt: new Date(1_000) });
    nowMs = 999;
    monitor.evaluate("process", pressure.signals, "reject");
    expect(source.reads).toBe(1);

    source.value = 0.7;
    nowMs = 1_000;
    expect(monitor.evaluate("process", pressure.signals, "reject"))
      .toMatchObject({ state: "healthy", refreshAt: new Date(1_500) });
    source.value = 0.85;
    nowMs = 1_500;
    expect(monitor.evaluate("process", pressure.signals, "reject"))
      .toMatchObject({ state: "degraded", refreshAt: new Date(1_750) });
    source.value = 0.95;
    nowMs = 1_750;
    expect(monitor.evaluate("process", pressure.signals, "reject"))
      .toMatchObject({ state: "limited", refreshAt: new Date(2_000) });
    expect(source.reads).toBe(4);
    monitor.close();
  });

  it("uses hysteresis while recovering and makes unavailable policy explicit", () => {
    let nowMs = 0;
    const source = new MutablePressureSource("cpu", 0.95);
    const pressure = localResourcePressure({
      id: "process",
      signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } },
    });
    const monitor = new LocalResourcePressureMonitor([source], {
      now: () => new Date(nowMs),
      monotonicNow: () => nowMs,
      healthyIntervalMs: 1,
      nearThresholdIntervalMs: 1,
      pressuredIntervalMs: 1,
    });

    expect(monitor.evaluate("process", pressure.signals, "reject").state)
      .toBe("limited");
    source.value = 0.86;
    nowMs += 1;
    expect(monitor.evaluate("process", pressure.signals, "reject").state)
      .toBe("limited");
    source.value = 0.75;
    nowMs += 1;
    expect(monitor.evaluate("process", pressure.signals, "reject").state)
      .toBe("degraded");
    source.value = 0.7;
    nowMs += 1;
    expect(monitor.evaluate("process", pressure.signals, "reject").state)
      .toBe("healthy");

    source.value = undefined;
    nowMs += 1;
    expect(monitor.evaluate("process", pressure.signals, "reject").state)
      .toBe("unknown");
    expect(monitor.evaluate("ignored", pressure.signals, "ignore").state)
      .toBe("degraded");
    monitor.close();
  });

  it("evaluates independent readers and refreshes at the earliest signal deadline", () => {
    let nowMs = 0;
    const cpu = new MutablePressureSource("cpu", 0.95);
    const memory = new MutablePressureSource("memory", 0.1);
    const pressure = localResourcePressure({
      id: "mixed",
      signals: {
        cpu: { degradedAt: 0.8, limitedAt: 0.9 },
        memory: { degradedAt: 0.8, limitedAt: 0.9 },
      },
    });
    const monitor = new LocalResourcePressureMonitor([cpu, memory], {
      now: () => new Date(nowMs), monotonicNow: () => nowMs,
    });

    try {
      // Each signal is supported by exactly one reader and retains its own refresh interval.
      expect(monitor.supports("cpu")).toBe(true);
      expect(monitor.supports("memory")).toBe(true);
      expect(monitor.supports("unknown")).toBe(false);
      expect(monitor.evaluate("mixed", pressure.signals, "reject")).toStrictEqual({
        state: "limited", refreshAt: new Date(250),
        signals: [
          { signalId: "cpu", state: "limited", value: 0.95 },
          { signalId: "memory", state: "healthy", value: 0.1 },
        ],
      });
      nowMs = 250;
      cpu.value = 0.8;
      expect(monitor.evaluate("mixed", pressure.signals, "reject")).toMatchObject({
        state: "degraded", refreshAt: new Date(500),
      });
      nowMs = 500;
      cpu.value = undefined;
      expect(monitor.evaluate("mixed", pressure.signals, "reject")).toMatchObject({
        state: "unknown", refreshAt: new Date(750),
      });
      expect(monitor.evaluate("mixed", pressure.signals, "ignore").state).toBe("degraded");
      expect(memory.reads).toBe(1);
    } finally {
      monitor.close();
    }
  });

  it("keeps hysteresis independent when multiple constraints share a signal", () => {
    let nowMs = 0;
    const source = new MutablePressureSource("cpu", 0.95);
    const recovering = [{ id: "cpu", degradedAt: 0.8, limitedAt: 0.9, recoveryRatio: 0.9 }];
    const other = [{ id: "cpu", degradedAt: 0.8, limitedAt: 0.92, recoveryRatio: 0.9 }];
    const monitor = new LocalResourcePressureMonitor([source], {
      now: () => new Date(nowMs), monotonicNow: () => nowMs,
    });

    try {
      expect(monitor.evaluate("recovering", recovering, "reject").state).toBe("limited");
      nowMs = 250;
      source.value = 0.86;
      // The new constraint has no prior limit to hold, even though it uses the same cached reading.
      expect(monitor.evaluate("other", other, "reject").state).toBe("degraded");
      expect(monitor.evaluate("recovering", recovering, "reject").state).toBe("limited");
      expect(source.reads).toBe(2);
    } finally {
      monitor.close();
    }
  });

  it("keeps opaque constraint and signal coordinates separate", () => {
    let nowMs = 0;
    const limited = new MutablePressureSource("c", 0.95);
    const fresh = new MutablePressureSource("b:c", 0.86);
    const thresholds = { degradedAt: 0.8, limitedAt: 0.9, recoveryRatio: 0.9 };
    const monitor = new LocalResourcePressureMonitor([limited, fresh], {
      now: () => new Date(nowMs), monotonicNow: () => nowMs,
    });
    try {
      expect(monitor.evaluate("a:b", [{ id: "c", ...thresholds }], "reject").state).toBe("limited");
      nowMs = 250;
      expect(monitor.evaluate("a", [{ id: "b:c", ...thresholds }], "reject")).toMatchObject({
        state: "degraded", signals: [{ signalId: "b:c", state: "degraded", value: 0.86 }],
      });
    } finally {
      monitor.close();
    }
  });

  it("returns a finite refresh deadline without any signal to sample", () => {
    const monitor = new LocalResourcePressureMonitor([], { now: () => new Date(500), monotonicNow: () => 100 });
    try {
      expect(monitor.evaluate("empty", [], "reject")).toEqual({
        state: "healthy", signals: [], refreshAt: new Date(1_500),
      });
    } finally {
      monitor.close();
    }
  });

  it("applies inclusive pressure thresholds and the earliest deadline across distinct signals", () => {
    let time = 0;
    const cpu = new MutablePressureSource("cpu", 0.25);
    const heap = new MutablePressureSource("heap", 0);
    const options = { degradedAt: 0.5, limitedAt: 1, recoveryRatio: 0.5 };
    const signals = [{ id: "cpu", ...options }, { id: "heap", ...options }];
    const monitor = new LocalResourcePressureMonitor([cpu, heap], {
      now: () => new Date(time), monotonicNow: () => time,
      healthyIntervalMs: 40, nearThresholdIntervalMs: 20, pressuredIntervalMs: 10, nearThresholdRatio: 0.5,
    });
    try {
      // Equality enters each state and retains it at its recovery threshold.
      for (const [at, value, state, refreshAt] of [
        [0, 0.25, "healthy", 20],
        [20, 0.5, "degraded", 30],
        [30, 0.25, "degraded", 40],
        [40, 1, "limited", 50],
        [50, 0.5, "limited", 60],
        [60, 0.4, "degraded", 70],
        [70, 0.24, "healthy", 80],
      ] as const) {
        time = at;
        cpu.value = value;
        expect(monitor.evaluate("process", signals, "reject")).toMatchObject({
          state, refreshAt: new Date(refreshAt), signals: [
            { signalId: "cpu", state, value }, { signalId: "heap", state: "healthy", value: 0 },
          ],
        });
      }
    } finally {
      monitor.close();
    }
  });

  it("accepts zero as a near-threshold ratio and reports unregistered signals without readings", () => {
    const monitor = new LocalResourcePressureMonitor([], {
      now: () => new Date(100), monotonicNow: () => 0, nearThresholdRatio: 0,
    });
    try {
      const signal = { id: "absent", degradedAt: 0.5, limitedAt: 1, recoveryRatio: 0.5 };
      expect(monitor.evaluate("process", [signal], "reject")).toStrictEqual({
        state: "unknown", signals: [{ signalId: "absent", state: "unknown" }], refreshAt: new Date(350),
      });
      expect(monitor.supports(signal.id)).toBe(false);
    } finally {
      monitor.close();
    }
  });

  it("validates the ordering of configurable sampling intervals", () => {
    expect(() => new LocalResourcePressureMonitor([], {
      healthyIntervalMs: 100,
      nearThresholdIntervalMs: 200,
      pressuredIntervalMs: 50,
    })).toThrow("must increase from pressured to healthy");
  });

  it("treats invalid samples and reader exceptions as unavailable until the next refresh", () => {
    let nowMs = 0;
    const signal = { id: "cpu", degradedAt: 0.8, limitedAt: 0.9, recoveryRatio: 0.9 };
    const read = vi.fn<LocalResourcePressureSource["read"]>()
      .mockReturnValueOnce(-1)
      .mockReturnValueOnce(Number.POSITIVE_INFINITY)
      .mockImplementationOnce(() => { throw new Error("reader unavailable"); })
      .mockReturnValue(0.2);
    const monitor = new LocalResourcePressureMonitor([{ supports: () => true, read }], {
      now: () => new Date(nowMs), monotonicNow: () => nowMs,
    });

    try {
      for (let sample = 1; sample <= 3; sample += 1) {
        expect(monitor.evaluate("process", [signal], "reject")).toStrictEqual({
          state: "unknown", signals: [{ signalId: "cpu", state: "unknown" }],
          refreshAt: new Date(nowMs + 250),
        });
        expect(monitor.evaluate("permissive", [signal], "ignore").state).toBe("degraded");
        expect(read).toHaveBeenCalledTimes(sample);
        nowMs += 250;
      }
      expect(monitor.evaluate("process", [signal], "reject")).toStrictEqual({
        state: "healthy", signals: [{ signalId: "cpu", state: "healthy", previousState: "unknown", value: 0.2 }],
        refreshAt: new Date(nowMs + 1_000),
      });
    } finally {
      monitor.close();
    }
  });

  it("closes each owned reader once and discards cached healthy readings", () => {
    const close = vi.fn();
    const read = vi.fn(() => 0.1);
    const monitor = new LocalResourcePressureMonitor([{ supports: () => true, read, close }], {
      now: () => new Date(0), monotonicNow: () => 0,
    });
    const signal = { id: "cpu", degradedAt: 0.8, limitedAt: 0.9, recoveryRatio: 0.9 };

    expect(monitor.evaluate("process", [signal], "reject").state).toBe("healthy");
    monitor.close();
    monitor.close();
    // Once closed, inspection is unavailable even with a previously healthy cached value.
    expect(monitor.evaluate("process", [signal], "ignore")).toStrictEqual({
      state: "unknown", signals: [{ signalId: "cpu", state: "unknown" }], refreshAt: new Date(250),
    });
    expect(monitor.evaluate("process", [signal], "reject").signals).toStrictEqual([{ signalId: "cpu", state: "unknown" }]);
    // Keeping a closed monitor reachable must not retain its cached samples or hysteresis.
    expect(monitor["cachedSignals"].size).toBe(0);
    expect(monitor["states"].size).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves each independent reader close failure and disposes each reader once", () => {
    const failures = [new Error("CPU reader"), new Error("heap reader")];
    const sources = failures.map((failure) => ({
      supports: () => false, read: () => undefined, close: vi.fn(() => { throw failure; }),
    }));
    const monitor = new LocalResourcePressureMonitor(sources);
    expect(() => monitor.close()).toThrow(expect.objectContaining({ name: "AggregateError", errors: failures }));
    expect(() => monitor.close()).not.toThrow();
    expect(sources.map((source) => source.close.mock.calls.length)).toEqual([1, 1]);
  });

  it("preserves the single close failure even when another reader closes normally", () => {
    const failure = new Error("Native reader close failed");
    const close = vi.fn();
    const monitor = new LocalResourcePressureMonitor([
      { supports: () => false, read: () => undefined, close: () => { throw failure; } },
      { supports: () => false, read: () => undefined, close },
    ]);
    expect(() => monitor.close()).toThrow(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(() => monitor.close()).not.toThrow();
  });

  it.each([
    { options: { healthyIntervalMs: 0 }, error: "healthyIntervalMs must be a positive finite number" },
    { options: { pressuredIntervalMs: Infinity }, error: "pressuredIntervalMs must be a positive finite number" },
    { options: { pressuredIntervalMs: 600 }, error: "must increase from pressured to healthy" },
    { options: { nearThresholdRatio: -0.1 }, error: "nearThresholdRatio must be between zero and one" },
    { options: { nearThresholdRatio: 1 }, error: "nearThresholdRatio must be between zero and one" },
    { options: { nearThresholdRatio: NaN }, error: "nearThresholdRatio must be between zero and one" },
  ])("rejects invalid sampling options $options", ({ options, error }) => {
    expect(() => new LocalResourcePressureMonitor([], options)).toThrow(error);
  });

  it.each([
    { options: { now: () => new Date(NaN) }, error: "clock returned an invalid date" },
    { options: { monotonicNow: () => Infinity }, error: "monotonic clock returned an invalid value" },
  ])("rejects an invalid clock before reading a signal ($error)", ({ options, error }) => {
    const read = vi.fn(() => 0.1);
    const monitor = new LocalResourcePressureMonitor([{ supports: () => true, read }], options);
    try {
      const signal = { id: "cpu", degradedAt: 0.8, limitedAt: 0.9, recoveryRatio: 0.9 };
      expect(() => monitor.evaluate("process", [signal], "reject")).toThrow(error);
      expect(read).not.toHaveBeenCalled();
    } finally {
      monitor.close();
    }
  });
});

class MutablePressureSource implements LocalResourcePressureSource {
  public reads = 0;

  public constructor(
    private readonly id: string,
    public value: number | undefined,
  ) {}

  public supports(signalId: string): boolean {
    return signalId === this.id;
  }

  public read(): number | undefined {
    this.reads += 1;
    return this.value;
  }
}
