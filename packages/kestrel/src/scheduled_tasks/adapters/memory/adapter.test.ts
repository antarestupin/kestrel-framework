import {
  describe,
  expect,
  it,
} from "vitest";

import { MemoryScheduledTaskAdapter } from "./adapter.js";

describe("MemoryScheduledTaskAdapter", () => {
  it("reserves and completes token-owned occurrences", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryScheduledTaskAdapter({
      now: () => now,
      createReservationToken: () => "token-1",
    });
    await adapter.reconcile([{
      taskId: "maintenance.cache",
      nextScheduledAt: now,
    }]);

    const result = await adapter.reserve({
      taskId: "maintenance.cache",
      expectedScheduledAt: now,
      nextScheduledAt: new Date("2026-01-01T00:01:00.000Z"),
      overlap: "skip",
      leaseMs: 1_000,
    });

    expect(result).toMatchObject({
      status: "reserved",
      reservation: { reservationToken: "token-1" },
    });
    expect((await adapter.listStates(["maintenance.cache"]))[0])
      .toMatchObject({ activeRuns: 1 });
    now = new Date("2026-01-01T00:00:01.000Z");
    await expect(adapter.complete({
      taskId: "maintenance.cache",
      reservationToken: "token-1",
      completedAt: now,
      outcome: "success",
    })).resolves.toBe(true);
    expect((await adapter.listStates(["maintenance.cache"]))[0])
      .toMatchObject({
        activeRuns: 0,
        lastOutcome: "success",
        nextScheduledAt: new Date("2026-01-01T00:01:00.000Z"),
      });
  });

  it("restores an occurrence after its reservation lease expires", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryScheduledTaskAdapter({
      now: () => now,
      createReservationToken: () => "expired-token",
    });
    await adapter.reconcile([{ taskId: "recover", nextScheduledAt: now }]);
    await adapter.reserve({
      taskId: "recover",
      expectedScheduledAt: now,
      nextScheduledAt: new Date("2026-01-01T00:01:00.000Z"),
      overlap: "wait",
      leaseMs: 1_000,
    });

    now = new Date("2026-01-01T00:00:02.000Z");

    expect((await adapter.listStates(["recover"]))[0]).toMatchObject({
      activeRuns: 0,
      nextScheduledAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("keeps manual requests separate from pause and regular cadence", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const next = new Date("2026-01-01T01:00:00.000Z");
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    await adapter.reconcile([{ taskId: "report", nextScheduledAt: next }]);
    await adapter.setPaused("report", true);
    await adapter.requestRun("report");

    expect((await adapter.listStates(["report"]))[0]).toMatchObject({
      paused: true,
      manualRunRequestedAt: now,
      nextScheduledAt: next,
    });

    await adapter.setPaused("report", false, next);
    expect((await adapter.listStates(["report"]))[0]?.paused).toBe(false);
  });

  it("globally prunes a bounded batch and restores its occurrences", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let token = 0;
    const adapter = new MemoryScheduledTaskAdapter({
      now: () => now,
      createReservationToken: () => `token-${++token}`,
    });
    await adapter.reconcile([
      { taskId: "first", nextScheduledAt: now },
      { taskId: "second", nextScheduledAt: now },
    ]);

    for (const taskId of ["first", "second"]) {
      await adapter.reserve({
        taskId,
        expectedScheduledAt: now,
        nextScheduledAt: new Date("2026-01-01T01:00:00.000Z"),
        overlap: "wait",
        leaseMs: 1_000,
      });
    }
    now = new Date("2026-01-01T00:00:02.000Z");

    await expect(adapter.pruneExpiredRuns({ limit: 1 })).resolves.toBe(1);
    await expect(adapter.pruneExpiredRuns({ limit: 1 })).resolves.toBe(1);
    await expect(adapter.pruneExpiredRuns({ limit: 1 })).resolves.toBe(0);
    const states = adapter.inspectStates();
    expect(states.reduce((total, state) => total + state.activeRuns, 0)).toBe(0);
    expect(states.filter((state) =>
      state.nextScheduledAt?.getTime()
        === new Date("2026-01-01T00:00:00.000Z").getTime()
    )).toHaveLength(2);
  });
});
