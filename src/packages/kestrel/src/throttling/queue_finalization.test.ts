import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import {
  defineAdmissionPolicy,
  rateLimit,
  seconds,
  ThrottlingAcquisitionAbortedError,
  ThrottlingManager,
  type RateLimitAdapter,
  type RateLimitBatchReservationResult,
  type ThrottlingManagerOptions,
} from "./index.js";

it.each([10, 1_000])("uses the new retry date while a queue previously blocked until %i is finishing", async (previousRetryAt) => {
  const policy = defineAdmissionPolicy({
    id: "finishing-queue",
    limits: ["global", "endpoint"].map((id) => rateLimit({
      id, unit: "requests", limit: 1, per: seconds(1),
    })),
  });
  const firstDenial = Promise.withResolvers<RateLimitBatchReservationResult>();
  const secondDenial = Promise.withResolvers<RateLimitBatchReservationResult>();
  const retryAt = new Date(10);
  const remaining = { "queue:global": 0, "queue:endpoint": 0 };
  const denied = { admitted: false, retryAt, remaining } as const;
  const reserveMany = vi.fn<NonNullable<RateLimitAdapter["reserveMany"]>>()
    .mockImplementationOnce(() => firstDenial.promise)
    .mockImplementationOnce(() => secondDenial.promise)
    .mockResolvedValue({ admitted: true, remaining });
  const sleep = vi.fn<NonNullable<ThrottlingManagerOptions["sleep"]>>((_delay, signal) =>
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })));
  let now = new Date(0);
  const manager = new ThrottlingManager({ reserve: vi.fn(), reserveMany }, {
    namespace: "queue", now: () => now, sleep,
  });
  const controller = new AbortController();
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  const onRemove = vi.spyOn(controller.signal, "removeEventListener").mockImplementation((...args) => {
    remove(...args);
    // This backend reply arrives as the last waiter is removed, before the old drain finalizes.
    secondDenial.resolve(denied);
  });

  try {
    const options = { maxWaitMs: 100, estimatedCost: { requests: 1 } };
    const first = manager.acquire(policy, { ...options, signal: controller.signal });
    const second = manager.acquire(policy, options);
    void first.catch(() => {});
    void second.catch(() => {});
    expect(reserveMany).toHaveBeenCalledTimes(2);
    firstDenial.resolve({ ...denied, retryAt: new Date(previousRetryAt) });
    await setImmediate();
    expect(sleep).toHaveBeenCalledExactlyOnceWith(Math.min(previousRetryAt, 100), expect.any(AbortSignal));

    now = retryAt;
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(ThrottlingAcquisitionAbortedError);
    await setImmediate();
    // Bound the assertion even if a regression leaves the second acquisition pending forever.
    expect(reserveMany).toHaveBeenCalledTimes(3);
    await (await second).complete({ outcome: "success" });
  } finally {
    firstDenial.resolve(denied);
    secondDenial.resolve(denied);
    await manager.close();
    onRemove.mockRestore();
  }
});
