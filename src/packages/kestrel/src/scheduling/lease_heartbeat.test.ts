import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { startLeaseHeartbeat } from "./lease_heartbeat.js";

describe("startLeaseHeartbeat", () => {
  afterEach(() => vi.useRealTimers());

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
});
