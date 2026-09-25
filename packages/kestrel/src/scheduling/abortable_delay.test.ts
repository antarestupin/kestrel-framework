import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { abortableDelay } from "./abortable_delay.js";

describe("abortableDelay", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves after elapsed time or shutdown abort", async () => {
    vi.useFakeTimers();
    const elapsed = abortableDelay(100, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await expect(elapsed).resolves.toBeUndefined();

    const controller = new AbortController();
    const aborted = abortableDelay(100, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
