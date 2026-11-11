import { getEventListeners } from "node:events";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { abortableDelay } from "./abortable_delay.js";

describe("abortableDelay", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("resolves after elapsed time or shutdown abort", async () => {
    vi.useFakeTimers();
    const elapsedSignal = new AbortController().signal;
    const elapsed = vi.fn();
    void abortableDelay(100, elapsedSignal).then(elapsed);
    await vi.advanceTimersByTimeAsync(99);
    expect(elapsed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(elapsed).toHaveBeenCalledOnce();
    expect(getEventListeners(elapsedSignal, "abort")).toHaveLength(0);

    const controller = new AbortController();
    const aborted = vi.fn();
    void abortableDelay(100, controller.signal).then(aborted);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not allocate a timer for a signal that is already aborted", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const done = vi.fn();
    void abortableDelay(100, AbortSignal.abort()).then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
  });

  it("does not keep Node alive while waiting", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    const delay = abortableDelay(100, controller.signal);
    try {
      expect(timer.mock.results[0]?.value.hasRef()).toBe(false);
    } finally {
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);
      await delay;
    }
  });

  it("can keep Node alive for a deadline that owns its work", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    const delay = abortableDelay(100, controller.signal, { ref: true });
    try {
      expect(timer.mock.results[0]?.value.hasRef()).toBe(true);
    } finally {
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);
      await delay;
    }
  });

  it("waits across the maximum Node timer duration", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const maximum = 2_147_483_647;
    void abortableDelay(maximum + 100, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(maximum);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();
  });

  it("resolves on the boundary of one maximum-duration timer", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void abortableDelay(2_147_483_647, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(2_147_483_646);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();
  });

  it("observes abort even when another listener stops event propagation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
    const done = vi.fn();
    void abortableDelay(100, controller.signal).then(done);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
