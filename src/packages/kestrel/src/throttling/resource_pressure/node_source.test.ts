import { describe, expect, it, vi } from "vitest";

import {
  NodeLocalResourcePressureSource,
  processCpuPressureSignal,
  processEventLoopDelayPressureSignal,
  processHeapPressureSignal,
  processRssPressureSignal,
} from "./node_source.js";

describe("NodeLocalResourcePressureSource", () => {
  it("reports heap and RSS in their documented units and ignores unknown signals", () => {
    const source = new NodeLocalResourcePressureSource();
    try {
      expect(source.supports(processHeapPressureSignal)).toBe(true);
      expect(source.supports(processRssPressureSignal)).toBe(true);
      const heapFraction = source.read(processHeapPressureSignal)!;
      expect(heapFraction).toBeGreaterThan(0);
      expect(heapFraction).toBeLessThanOrEqual(1);
      const rss = source.read(processRssPressureSignal)!;
      expect(Number.isSafeInteger(rss)).toBe(true);
      expect(rss).toBeGreaterThan(0);
      expect(source.supports("application.custom")).toBe(false);
      expect(source.read("application.custom")).toBeUndefined();
    } finally {
      source.close();
    }
  });

  it("normalizes CPU usage by elapsed time and handles a zero-length sample", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const first = { user: 1_000, system: 2_000 };
    const second = { user: 1_250, system: 2_000 };
    const cpu = vi.spyOn(process, "cpuUsage")
      .mockReturnValueOnce(first)
      .mockReturnValueOnce({ user: 0, system: 0 })
      .mockReturnValueOnce(second)
      .mockReturnValueOnce({ user: 750, system: 250 })
      .mockReturnValueOnce({ user: 2_000, system: 2_250 });
    const source = new NodeLocalResourcePressureSource();

    try {
      expect(source.supports(processCpuPressureSignal)).toBe(true);
      expect(source.read(processCpuPressureSignal)).toBe(0);
      expect(cpu).toHaveBeenNthCalledWith(2, first);
      // One thousand CPU microseconds in two wall milliseconds is half a core.
      clock.mockReturnValue(1_002);
      expect(source.read(processCpuPressureSignal)).toBe(0.5);
      expect(cpu).toHaveBeenNthCalledWith(4, second);
    } finally {
      source.close();
      cpu.mockRestore();
      clock.mockRestore();
    }
  });

  it("starts event-loop sampling lazily and clears the sample on read or close", async () => {
    const source = new NodeLocalResourcePressureSource();
    try {
      expect(source.supports(processEventLoopDelayPressureSignal)).toBe(true);
      expect(source.read(processEventLoopDelayPressureSignal)).toBe(0);
      expect(source.read(processEventLoopDelayPressureSignal)).toBe(0);
      // Wait for a native histogram sample without assuming an exact scheduling delay.
      await vi.waitFor(() => {
        const delay = source.read(processEventLoopDelayPressureSignal)!;
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThan(0);
      }, { interval: 20, timeout: 1_000 });
      expect(source.read(processEventLoopDelayPressureSignal)).toBe(0);
      source.close();
      expect(source.read(processEventLoopDelayPressureSignal)).toBe(0);
    } finally {
      source.close();
    }
  });
});
