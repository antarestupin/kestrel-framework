import { describe, expect, it } from "vitest";

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

  it("validates the ordering of configurable sampling intervals", () => {
    expect(() => new LocalResourcePressureMonitor([], {
      healthyIntervalMs: 100,
      nearThresholdIntervalMs: 200,
      pressuredIntervalMs: 50,
    })).toThrow("must increase from pressured to healthy");
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
