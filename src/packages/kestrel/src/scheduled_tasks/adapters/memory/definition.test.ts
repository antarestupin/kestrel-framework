import { expect, it, vi } from "vitest";

import { scheduledTasksConfigBase } from "../../configuration.js";
import { memoryScheduledTasks } from "./definition.js";

it("constructs independent memory stores lazily with their injected clock and tokens", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const createReservationToken = vi.fn(() => "injected-token");
  const definition = memoryScheduledTasks({ now: () => now, createReservationToken });
  const resolve = vi.fn(() => { throw new Error("Memory adapter must not resolve infrastructure dependencies"); });
  expect(createReservationToken).not.toHaveBeenCalled();
  const first = definition.create(resolve, scheduledTasksConfigBase.schema.parse({}));
  const second = definition.create(resolve, scheduledTasksConfigBase.schema.parse({}));
  expect(first).not.toBe(second);
  await first.reconcile([{ taskId: "task", nextScheduledAt: now }]);
  expect(await first.reserve({ taskId: "task", expectedScheduledAt: now, overlap: "wait", leaseMs: 1_000 })).toMatchObject({
    status: "reserved", reservation: { reservationToken: "injected-token", reservedAt: now },
  });
  expect(await second.listStates(["task"])).toEqual([]);
  expect(resolve).not.toHaveBeenCalled();
  expect(createReservationToken).toHaveBeenCalledOnce();
});
