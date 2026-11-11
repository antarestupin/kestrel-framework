import { getEventListeners } from "node:events";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { startLeaseHeartbeat } from "./lease_heartbeat.js";

describe("startLeaseHeartbeat", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("runs non-overlapping extensions until closed", async () => {
    vi.useFakeTimers();
    let finishExtension: (() => void) | undefined;
    const extension = new Promise<void>((resolve) => {
      finishExtension = resolve;
    });
    const extend = vi.fn(() => extension);
    const heartbeat = startLeaseHeartbeat({ intervalMs: 100, extend });

    await vi.advanceTimersByTimeAsync(300);
    expect(extend).toHaveBeenCalledOnce();

    finishExtension!();
    await heartbeat.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies once, stops and surfaces an extension failure", async () => {
    vi.useFakeTimers();
    const failure = new Error("extension failed");
    const onFailure = vi.fn();
    const heartbeat = startLeaseHeartbeat({
      intervalMs: 100,
      extend: async () => {
        throw failure;
      },
      onFailure,
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(failure);
    expect(vi.getTimerCount()).toBe(0);
    await expect(heartbeat.close()).rejects.toBe(failure);
  });

  it("stops immediately even when another listener stops abort propagation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
    const extend = vi.fn(async () => undefined);
    const heartbeat = startLeaseHeartbeat({ intervalMs: 50, extend, signal: controller.signal });
    try {
      controller.abort();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(extend).not.toHaveBeenCalled();
    } finally { await heartbeat.close(); }
  });

  it("owns a synchronous extension throw and reports the original cause", async () => {
    vi.useFakeTimers();
    const failure = new Error("synchronous renewal failure");
    const onFailure = vi.fn();
    const heartbeat = startLeaseHeartbeat({ intervalMs: 50, extend: () => { throw failure; }, onFailure });
    await vi.advanceTimersByTimeAsync(50);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);
    await expect(heartbeat.close()).rejects.toBe(failure);
  });

  it("clears an unreferenced interval and waits for a running extension after abort", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setInterval");
    const controller = new AbortController();
    const pending = Promise.withResolvers<void>();
    const extend = vi.fn(() => pending.promise);
    const heartbeat = startLeaseHeartbeat({ intervalMs: 50, signal: controller.signal, extend });
    let closed: Promise<void> | undefined;
    try {
      expect(timer.mock.results[0]?.value.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(extend).toHaveBeenCalledOnce();
      controller.abort();
      expect(vi.getTimerCount()).toBe(0);
      const done = vi.fn();
      closed = heartbeat.close().then(done);
      await vi.advanceTimersByTimeAsync(100);
      expect(extend).toHaveBeenCalledOnce();
      expect(done).not.toHaveBeenCalled();
      pending.resolve();
      await closed;
      expect(done).toHaveBeenCalledOnce();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      pending.resolve();
      await (closed ?? heartbeat.close());
    }
  });

  it("detaches the abort listener on close before the signal fires", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const heartbeat = startLeaseHeartbeat({ intervalMs: 50, signal: controller.signal, extend: async () => {} });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    await heartbeat.close();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule work for an already aborted owner", async () => {
    vi.useFakeTimers();
    const signal = AbortSignal.abort();
    const extend = vi.fn(async () => {});
    const heartbeat = startLeaseHeartbeat({ intervalMs: 50, signal, extend });
    try {
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(extend).not.toHaveBeenCalled();
    } finally { await heartbeat.close(); }
  });

  it("preserves a nullish rejection even if reporting throws", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn(() => { throw new Error("reporter failed"); });
    const heartbeat = startLeaseHeartbeat({ intervalMs: 50, extend: () => Promise.reject(undefined), onFailure });
    await vi.advanceTimersByTimeAsync(50);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(undefined);
    await expect(heartbeat.close()).rejects.toBeUndefined();
  });
});
