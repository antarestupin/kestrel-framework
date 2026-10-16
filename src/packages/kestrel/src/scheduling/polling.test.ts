import { afterEach, describe, expect, it, vi } from "vitest";
import { PollingSupervisor } from "./polling.js";

afterEach(() => vi.useRealTimers());

describe("PollingSupervisor", () => {
  it("recovers with bounded backoff and counts healthy empty cycles", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const transient = new Error("transient");
    const cycle = vi.fn().mockRejectedValueOnce(transient).mockImplementation(async () => { controller.abort(); return false; });
    const polling = new PollingSupervisor({ initialBackoffMs: 10, maxBackoffMs: 20, isRecoverable: (error) => error === transient });
    const running = polling.run(controller.signal, cycle, 10);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(polling.state).toMatchObject({ status: "backoff", consecutiveFailures: 1 });
      await vi.advanceTimersByTimeAsync(10);
      await running;
      expect(cycle).toHaveBeenCalledTimes(2);
      expect(polling.state).toMatchObject({ status: "stopped", successfulCycles: 1, consecutiveFailures: 0 });
    } finally { controller.abort(); await running; }
  });

  it("terminates persistent transient failures at the configured failure budget", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const failure = new Error("offline");
    const polling = new PollingSupervisor({ initialBackoffMs: 10, maxBackoffMs: 20, maxFailureDurationMs: 30, isRecoverable: () => true });
    const running = polling.run(controller.signal, async () => { throw failure; }, 10);
    const result = expect(running).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(30);
    await result;
    expect(polling.state.status).toBe("failed");
  });

  it("propagates unknown failures even if diagnostic reporting throws", async () => {
    const failure = new Error("invalid invariant");
    const polling = new PollingSupervisor();
    await expect(polling.run(new AbortController().signal, async () => { throw failure; }, 10,
      () => { throw new Error("broken logger"); })).rejects.toBe(failure);
    expect(polling.state).toMatchObject({ status: "failed", error: failure });
  });

  it("interrupts a retry delay immediately", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cycle = vi.fn(async () => { throw new Error("offline"); });
    const polling = new PollingSupervisor({ isRecoverable: () => true });
    const running = polling.run(controller.signal, cycle, 10);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await running;
    expect(cycle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
