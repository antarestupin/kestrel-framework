import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import {
  defineAdmissionPolicy,
  defineRateLimit,
  rateLimit,
  seconds,
  ThrottlingAcquisitionAbortedError,
  ThrottlingManager,
  type ThrottlingPermit,
  type RateLimitAdapter,
  type RateLimitBatchReservationResult,
  type RateLimitReservationResult,
  type ThrottlingManagerOptions,
} from "./index.js";

const onePerSecond = defineRateLimit({ id: "queue-transition", requests: 1, per: seconds(1) });

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

it("admits an immediate request when the previous head has left a finishing queue", async () => {
  const retryAt = new Date(10);
  const denied = { admitted: false, remaining: 0, retryAt } as const;
  const allowed = { admitted: true, remaining: 1 } as const;
  const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockResolvedValueOnce(denied).mockResolvedValue(allowed);
  const sleeping = Promise.withResolvers<void>();
  const controller = new AbortController();
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  let now = new Date(0);
  const manager = new ThrottlingManager({ reserve }, { namespace: "queue", now: () => now, sleep: () => sleeping.promise });
  const immediate = vi.fn<(result: unknown) => void>();
  const removed = vi.spyOn(controller.signal, "removeEventListener").mockImplementation((...args) => {
    remove(...args);
    // The old waiter has left the queue, although its drain still owns finalization.
    void manager.acquire(onePerSecond).then(immediate, immediate);
  });

  try {
    const waiting = manager.acquire(onePerSecond, { maxWaitMs: 100, signal: controller.signal });
    void waiting.catch(() => undefined);
    await setImmediate();
    now = retryAt;
    sleeping.resolve();
    await setImmediate();
    expect(immediate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ definitionId: onePerSecond.id }));
    expect(reserve).toHaveBeenCalledTimes(3);
    await (await waiting).complete({ outcome: "success" });
    await (immediate.mock.calls[0]![0] as ThrottlingPermit).complete({ outcome: "success" });
  } finally {
    sleeping.resolve();
    removed.mockRestore();
    await manager.close();
  }
});

it("keeps the FIFO head's deadline when a concurrent first attempt is denied later", async () => {
  const head = Promise.withResolvers<RateLimitReservationResult>();
  const follower = Promise.withResolvers<RateLimitReservationResult>();
  const headDenial = { admitted: false, remaining: 0, retryAt: new Date(50) } as const;
  const followerDenial = { admitted: false, remaining: 0, retryAt: new Date(10) } as const;
  const reserve = vi.fn<RateLimitAdapter["reserve"]>().mockReturnValueOnce(head.promise).mockReturnValueOnce(follower.promise)
    .mockResolvedValue(headDenial);
  const sleep = vi.fn<NonNullable<ThrottlingManagerOptions["sleep"]>>((_delay, signal) =>
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })));
  const manager = new ThrottlingManager({ reserve }, { namespace: "queue", now: () => new Date(0), sleep });

  try {
    void manager.acquire(onePerSecond, { maxWaitMs: 100 }).catch(() => undefined);
    void manager.acquire(onePerSecond, { maxWaitMs: 100 }).catch(() => undefined);
    head.resolve(headDenial);
    await setImmediate();
    expect(sleep).toHaveBeenLastCalledWith(50, expect.any(AbortSignal));

    follower.resolve(followerDenial);
    await setImmediate();
    // A later result cannot replace the earlier waiter's retry date.
    expect(sleep).toHaveBeenLastCalledWith(50, expect.any(AbortSignal));
    expect(reserve).toHaveBeenCalledTimes(2);
  } finally {
    head.resolve(headDenial);
    follower.resolve(followerDenial);
    await manager.close();
  }
});
