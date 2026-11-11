import { afterEach, describe, expect, it, vi } from "vitest";
import { PollingSupervisor } from "./polling.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PollingSupervisor", () => {
  it.each([
    { initialBackoffMs: 0 },
    { maxBackoffMs: 1.5 },
    { maxFailureDurationMs: Number.NaN },
    { initialBackoffMs: 10, maxBackoffMs: 9 },
    { maxBackoffMs: 2_147_483_648 },
  ])("rejects invalid backoff or failure budget options %j", (options) => {
    expect(() => new PollingSupervisor(options)).toThrowError("Invalid polling backoff or failure budget.");
  });

  it("allows a backoff cap at the maximum Node timer duration", () => {
    expect(() => new PollingSupervisor({ maxBackoffMs: 2_147_483_647 })).not.toThrow();
  });

  it("uses capped jitter and starts a fresh failure window after a healthy cycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await vi.advanceTimersByTimeAsync(100);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const controller = new AbortController();
    const failure = new Error("transient outage");
    const report = vi.fn();
    const cycle = vi.fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(failure)
      .mockImplementation(async () => { controller.abort(); return true; });
    const polling = new PollingSupervisor({ initialBackoffMs: 16, maxBackoffMs: 40, maxFailureDurationMs: 70, isRecoverable: () => true });
    expect(polling.state).toEqual({ status: "idle", consecutiveFailures: 0, successfulCycles: 0 });
    const running = polling.run(controller.signal, cycle, 8, report);
    const stopped = vi.fn();
    const failed = vi.fn();
    void running.then(stopped, failed);
    try {
      expect(polling.state.status).toBe("running");
      await vi.advanceTimersByTimeAsync(0);
      for (const [attempt, delay] of [12, 24, 30].entries()) {
        expect(polling.state).toMatchObject({ status: "backoff", nextRetryAt: Date.now() + delay, consecutiveFailures: attempt + 1, error: failure });
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(cycle).toHaveBeenCalledTimes(attempt + 1);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(polling.state).toEqual({ status: "running", consecutiveFailures: 0, successfulCycles: 1, lastSuccessfulCycleAt: Date.now() });
      await vi.advanceTimersByTimeAsync(7);
      expect(cycle).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(polling.state).toMatchObject({ status: "backoff", nextRetryAt: Date.now() + 12, consecutiveFailures: 1 });
      await vi.advanceTimersByTimeAsync(12);
      expect(stopped).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
      expect(report.mock.calls).toEqual([[failure], [failure], [failure], [failure]]);
      expect(polling.state).toMatchObject({ status: "stopped", successfulCycles: 2, consecutiveFailures: 0, nextRetryAt: undefined });
    } finally { controller.abort(); }
  });

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
      expect(cycle).toHaveBeenCalledTimes(2);
      expect(polling.state).toMatchObject({ status: "stopped", successfulCycles: 1, consecutiveFailures: 0 });
    } finally { controller.abort(); void running.catch(() => undefined); }
  });

  it("starts the next cycle immediately after useful work", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cycle = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockImplementation(async () => { controller.abort(); return false; });
    const polling = new PollingSupervisor();
    const failed = vi.fn();
    void polling.run(controller.signal, cycle, 100).catch(failed);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(cycle).toHaveBeenCalledTimes(2);
      expect(failed).not.toHaveBeenCalled();
      expect(polling.state).toMatchObject({ status: "stopped", successfulCycles: 2 });
    } finally { controller.abort(); }
  });

  it("terminates persistent transient failures at the configured failure budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    await vi.advanceTimersByTimeAsync(100);
    const controller = new AbortController();
    const failure = new Error("offline");
    const cycle = vi.fn<() => Promise<boolean>>().mockRejectedValue(failure);
    const polling = new PollingSupervisor({ initialBackoffMs: 10, maxBackoffMs: 20, maxFailureDurationMs: 30, isRecoverable: () => true });
    const failed = vi.fn();
    void polling.run(controller.signal, cycle, 10).catch(failed);
    try {
      await vi.advanceTimersByTimeAsync(29);
      expect(polling.state).toMatchObject({ status: "backoff", consecutiveFailures: 4 });
      expect(failed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(cycle).toHaveBeenCalledTimes(4);
      expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
      expect(polling.state).toMatchObject({ status: "failed", error: failure, nextRetryAt: undefined });
    } finally { controller.abort(); }
  });

  it("fails immediately when reporting consumes the remaining budget", async () => {
    const controller = new AbortController();
    const failure = new Error("outage");
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const cycle = vi.fn<() => Promise<boolean>>().mockRejectedValue(failure);
    const polling = new PollingSupervisor({ maxFailureDurationMs: 10, isRecoverable: () => true });
    const failed = vi.fn();
    void polling.run(controller.signal, cycle, 10, () => { clock.mockReturnValue(110); }).catch(failed);
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
      expect(cycle).toHaveBeenCalledOnce();
    } finally { controller.abort(); }
  });

  it("propagates unknown failures even if diagnostic reporting throws", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const failure = new Error("invalid invariant");
    const polling = new PollingSupervisor();
    const failed = vi.fn();
    void polling.run(controller.signal, async () => { throw failure; }, 10,
      () => { throw new Error("broken logger"); }).catch(failed);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
      expect(polling.state).toMatchObject({ status: "failed", error: failure });
    } finally { controller.abort(); }
  });

  it("interrupts a retry delay immediately", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const controller = new AbortController();
    const cycle = vi.fn(async () => { throw new Error("offline"); });
    const polling = new PollingSupervisor({ maxFailureDurationMs: 50, isRecoverable: () => true });
    const stopped = vi.fn();
    const failed = vi.fn();
    // Abort on the same timer tick as the budget deadline.
    setTimeout(() => controller.abort(), 50);
    void polling.run(controller.signal, cycle, 10).then(stopped, failed);
    await vi.advanceTimersByTimeAsync(0);
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(cycle).toHaveBeenCalledOnce();
      expect(stopped).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
      expect(polling.state).toMatchObject({ status: "stopped", nextRetryAt: undefined });
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); }
  });

  it("disregards a cycle rejection during shutdown", async () => {
    const controller = new AbortController();
    const report = vi.fn();
    const polling = new PollingSupervisor();
    const cycle = vi.fn(async () => {
      controller.abort();
      throw new Error("connection closed during shutdown");
    });
    await expect(polling.run(controller.signal, cycle, 10, report)).resolves.toBeUndefined();
    expect(cycle).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    expect(polling.state).toMatchObject({ status: "stopped", consecutiveFailures: 0, successfulCycles: 0 });
  });
});
