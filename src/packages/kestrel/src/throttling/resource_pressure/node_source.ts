import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

import type { LocalResourcePressureSource } from "./monitor.js";

export const processCpuPressureSignal = "process.cpu";
export const processHeapPressureSignal = "process.heap";
export const processRssPressureSignal = "process.rss-bytes";
export const processEventLoopDelayPressureSignal =
  "process.event-loop-delay-p99-ms";

const supportedSignals = new Set([
  processCpuPressureSignal,
  processHeapPressureSignal,
  processRssPressureSignal,
  processEventLoopDelayPressureSignal,
]);

/** Reads built-in Node.js process pressure without application dependencies. */
export class NodeLocalResourcePressureSource
implements LocalResourcePressureSource {
  private previousCpu = process.cpuUsage();

  private previousCpuAt = performance.now();

  // Infer the histogram contract across supported Node 24 type-definition revisions.
  private eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | undefined;

  public supports(signalId: string): boolean {
    return supportedSignals.has(signalId);
  }

  public read(signalId: string): number | undefined {
    if (signalId === processCpuPressureSignal) return this.readCpu();
    if (signalId === processHeapPressureSignal) return this.readHeap();
    if (signalId === processRssPressureSignal) return process.memoryUsage.rss();
    if (signalId === processEventLoopDelayPressureSignal) {
      return this.readEventLoopDelay();
    }

    return undefined;
  }

  public close(): void {
    this.eventLoopDelay?.disable();
    this.eventLoopDelay = undefined;
  }

  private readCpu(): number {
    const now = performance.now();
    const usage = process.cpuUsage(this.previousCpu);
    const elapsedMicros = (now - this.previousCpuAt) * 1_000;
    this.previousCpu = process.cpuUsage();
    this.previousCpuAt = now;

    // One unit represents one fully occupied CPU core during the sample.
    return elapsedMicros <= 0
      ? 0
      : (usage.user + usage.system) / elapsedMicros;
  }

  private readHeap(): number {
    const heapLimit = getHeapStatistics().heap_size_limit;
    return heapLimit <= 0 ? 0 : process.memoryUsage().heapUsed / heapLimit;
  }

  private readEventLoopDelay(): number {
    if (this.eventLoopDelay === undefined) {
      this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
      this.eventLoopDelay.enable();
      return 0;
    }

    if (this.eventLoopDelay.count === 0) return 0;
    const percentileMs = this.eventLoopDelay.percentile(99) / 1_000_000;
    this.eventLoopDelay.reset();
    return percentileMs;
  }
}
