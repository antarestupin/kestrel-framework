import { describe, expect, it, vi } from "vitest";

import { MemoryScheduledTaskAdapter } from "./adapter.js";
import type { ReserveScheduledTaskRequest, ScheduledTaskReservation } from "../../types.js";

const epoch = new Date("2026-01-01T00:00:00.000Z");
/** Own each adapter and injected clock per test so no reservation can leak across cases. */
function setup() {
  let elapsed = 0;
  let sequence = 0;
  const adapter = new MemoryScheduledTaskAdapter({ now: () => new Date(epoch.getTime() + elapsed), createReservationToken: () => `reservation-${++sequence}` });
  const request = (taskId = "first", overrides: Partial<ReserveScheduledTaskRequest> = {}): ReserveScheduledTaskRequest => ({ taskId, expectedScheduledAt: epoch, nextScheduledAt: new Date(epoch.getTime() + 60_000), overlap: "wait", leaseMs: 1_000, ...overrides });
  return { adapter, request, advance: (milliseconds: number) => { elapsed = milliseconds; } };
}
async function reserve(adapter: MemoryScheduledTaskAdapter, request: ReserveScheduledTaskRequest): Promise<ScheduledTaskReservation> {
  const result = await adapter.reserve(request);
  expect(result.status).toBe("reserved");
  if (result.status !== "reserved") throw new Error("Test fixture did not reserve an occurrence");
  return result.reservation;
}

describe("memory scheduled-task ownership and recovery", () => {
  it("reconciles missing states without resetting existing controls or cadence", async () => {
    const { adapter } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    await adapter.setPaused("first", true);
    await adapter.requestRun("first");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: new Date(epoch.getTime() + 60_000) }, { taskId: "second", nextScheduledAt: epoch }]);
    expect(await adapter.listStates(["missing", "second", "first"])).toMatchObject([
      { taskId: "second", activeRuns: 0 },
      { taskId: "first", paused: true, nextScheduledAt: epoch, manualRunRequestedAt: epoch },
    ]);
  });

  it("does not expose mutable scheduling dates through state snapshots", async () => {
    const { adapter } = setup();
    const supplied = new Date(epoch);
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: supplied }]);
    supplied.setTime(0);
    const [snapshot] = await adapter.listStates(["first"]);
    snapshot!.nextScheduledAt!.setTime(0);
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toEqual(epoch);
  });

  it("uses the current time for reservations and manual requests without an injected clock", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(epoch);
      const adapter = new MemoryScheduledTaskAdapter();
      const { request } = setup();
      await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
      const reservation = await reserve(adapter, request());
      expect(reservation.reservedAt).toEqual(epoch);
      const requestedAt = new Date(epoch.getTime() + 50);
      vi.setSystemTime(requestedAt);
      await adapter.requestRun("first");
      expect((await adapter.listStates(["first"]))[0]).toMatchObject({ lastStartedAt: epoch, manualRunRequestedAt: requestedAt });
    } finally { vi.useRealTimers(); }
  });

  it("keeps persisted run diagnostics independent of mutable clocks, reservations and errors", async () => {
    const clock = new Date(epoch);
    const adapter = new MemoryScheduledTaskAdapter({ now: () => clock });
    const { request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    await adapter.requestRun("first");
    const manual = await reserve(adapter, request());
    // Mutable Date and error objects can be retained by adapter callers.
    manual.reservedAt.setTime(0);
    clock.setTime(epoch.getTime() + 1);
    expect((await adapter.listStates(["first"]))[0]!.lastStartedAt).toEqual(epoch);

    const error = { name: "TestFailure", message: "original failure" };
    expect(await adapter.complete({ ...manual, completedAt: epoch, outcome: "failure", error })).toBe(true);
    error.message = "changed by caller";
    const [snapshot] = await adapter.listStates(["first"]);
    expect(snapshot!.lastError!.message).toBe("original failure");
    snapshot!.lastError!.message = "changed through snapshot";
    expect((await adapter.listStates(["first"]))[0]!.lastError!.message).toBe("original failure");

    await adapter.requestRun("first");
    clock.setTime(epoch.getTime() + 2);
    expect((await adapter.listStates(["first"]))[0]!.manualRunRequestedAt).toEqual(new Date(epoch.getTime() + 1));
  });

  it("refuses unknown, stale and paused scheduled occurrences without adding a run", async () => {
    const { adapter, request } = setup();
    expect(await adapter.reserve(request())).toEqual({ status: "stale" });
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    expect(await adapter.reserve(request("first", { expectedScheduledAt: new Date(epoch.getTime() + 1) }))).toEqual({ status: "stale" });
    await adapter.setPaused("first", true);
    expect(await adapter.reserve(request())).toEqual({ status: "paused" });
    expect((await adapter.listStates(["first"]))[0]!.activeRuns).toBe(0);
  });

  it("prioritizes a matching manual request even when scheduling is paused", async () => {
    const { adapter, request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    await adapter.requestRun("first");
    await adapter.setPaused("first", true);
    const reservation = await reserve(adapter, request());
    expect(reservation.trigger).toBe("manual");
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ paused: true, nextScheduledAt: epoch, activeRuns: 1 });
    expect((await adapter.listStates(["first"]))[0]!.manualRunRequestedAt).toBeUndefined();
  });

  it("requires the matching task and token for completion, renewal and release", async () => {
    const { adapter, request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }, { taskId: "second", nextScheduledAt: epoch }]);
    const first = await reserve(adapter, request());
    const second = await reserve(adapter, request("second"));
    const mismatch = { taskId: "first", reservationToken: second.reservationToken };
    expect(await adapter.complete({ ...mismatch, completedAt: epoch, outcome: "success" })).toBe(false);
    expect(await adapter.extendLease({ ...mismatch, leaseMs: 5_000 })).toBe(false);
    expect(await adapter.release(mismatch)).toBe(false);
    expect(await adapter.complete({ ...first, completedAt: epoch, outcome: "success" })).toBe(true);
    expect(await adapter.complete({ ...first, completedAt: epoch, outcome: "failure" })).toBe(false);
    expect(await adapter.extendLease({ ...first, leaseMs: 5_000 })).toBe(false);
    expect(await adapter.release(first)).toBe(false);
    expect((await adapter.listStates(["second"]))[0]!.activeRuns).toBe(1);
  });

  it("rejects a duplicate generated token before consuming another occurrence", async () => {
    const createReservationToken = vi.fn(() => "unique-second").mockReturnValueOnce("shared").mockReturnValueOnce("shared");
    const adapter = new MemoryScheduledTaskAdapter({ now: () => epoch, createReservationToken });
    const { request } = setup();
    await adapter.reconcile(["first", "second"].map((taskId) => ({ taskId, nextScheduledAt: epoch })));
    const first = await reserve(adapter, request());

    await expect(adapter.reserve(request("second"))).rejects.toThrow(/reservation token.*already in use/u);
    expect(await adapter.listStates(["first", "second"])).toMatchObject([
      { taskId: "first", activeRuns: 1, nextScheduledAt: request().nextScheduledAt },
      { taskId: "second", activeRuns: 0, nextScheduledAt: epoch },
    ]);
    expect(await adapter.release(first)).toBe(true);
    expect((await reserve(adapter, request("second"))).reservationToken).toBe("unique-second");
  });

  it("replaces a prior failure summary on successful completion", async () => {
    const { adapter, request, advance } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const first = await reserve(adapter, request());
    const error = { name: "TestFailure", message: "first run failed" };
    await adapter.complete({ ...first, completedAt: epoch, outcome: "failure", error });
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ lastError: error, lastOutcome: "failure", lastCompletedAt: epoch });
    advance(60_000);
    const second = await reserve(adapter, request("first", { expectedScheduledAt: new Date(epoch.getTime() + 60_000) }));
    const completedAt = new Date(epoch.getTime() + 60_001);
    await adapter.complete({ ...second, completedAt, outcome: "success" });
    const [state] = await adapter.listStates(["first"]);
    expect(state).toMatchObject({ lastOutcome: "success", lastCompletedAt: completedAt, activeRuns: 0 });
    expect(state!.lastError).toBeUndefined();
  });

  it("advances loop cadence and deferral only to a later date", async () => {
    const { adapter, request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const { nextScheduledAt: _nextScheduledAt, ...loopRequest } = request();
    const first = await reserve(adapter, loopRequest);
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toBeUndefined();
    const next = new Date(epoch.getTime() + 60_000);
    const postponed = new Date(epoch.getTime() + 120_000);
    await adapter.complete({ ...first, completedAt: epoch, outcome: "success", nextScheduledAt: next, postponeUntil: postponed });
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toEqual(postponed);
  });

  it("retains absent cadence on completion and rejects earlier updates to existing cadence", async () => {
    const { adapter, request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }, { taskId: "second", nextScheduledAt: epoch }]);
    const { nextScheduledAt: _nextScheduledAt, ...loopRequest } = request();
    const loopRun = await reserve(adapter, loopRequest);
    expect(await adapter.complete({ ...loopRun, completedAt: epoch, outcome: "success" })).toBe(true);
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toBeUndefined();

    const regular = request("second");
    const regularRun = await reserve(adapter, regular);
    const earlier = new Date(epoch.getTime() + 10_000);
    expect(await adapter.complete({ ...regularRun, completedAt: epoch, outcome: "success", nextScheduledAt: earlier, postponeUntil: earlier })).toBe(true);
    expect((await adapter.listStates(["second"]))[0]!.nextScheduledAt).toEqual(regular.nextScheduledAt);
  });

  it("does not replace regular cadence with the completion of a manual run", async () => {
    const { adapter, request } = setup();
    const next = new Date(epoch.getTime() + 60_000);
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: next }]);
    await adapter.requestRun("first");
    const manual = await reserve(adapter, request());
    await adapter.complete({ ...manual, completedAt: epoch, outcome: "success", nextScheduledAt: new Date(epoch.getTime() + 120_000) });
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toEqual(next);
  });

  it("only skips an exact unpaused occurrence while another run is active", async () => {
    const { adapter, request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    expect(await adapter.skip(request())).toBe(false);
    await reserve(adapter, request());
    expect(await adapter.skip(request())).toBe(false);
    const next = new Date(epoch.getTime() + 60_000);
    await adapter.setPaused("first", true);
    expect(await adapter.skip(request("first", { expectedScheduledAt: next }))).toBe(false);
    await adapter.setPaused("first", false);
    expect(await adapter.skip(request("first", { expectedScheduledAt: next, nextScheduledAt: new Date(epoch.getTime() + 120_000) }))).toBe(true);
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toEqual(new Date(epoch.getTime() + 120_000));
  });

  it("does not use a different task's live reservation to discard an occurrence", async () => {
    const { adapter, request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }, { taskId: "second", nextScheduledAt: epoch }]);
    await reserve(adapter, request("second"));
    expect(await adapter.skip(request("first", { overlap: "skip" }))).toBe(false);
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ activeRuns: 0, nextScheduledAt: epoch });
  });

  it("skips a matching manual occurrence while paused without changing regular cadence", async () => {
    const { adapter, request, advance } = setup();
    const first = request();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    await reserve(adapter, first);
    advance(10);
    await adapter.requestRun("first");
    await adapter.setPaused("first", true);
    expect(await adapter.skip(request("first", { expectedScheduledAt: new Date(epoch.getTime() + 10), overlap: "skip" }))).toBe(true);
    expect(await adapter.listStates(["first"])).toEqual([{ taskId: "first", paused: true, activeRuns: 1, nextScheduledAt: first.nextScheduledAt, lastStartedAt: epoch }]);
  });

  it("does not discard a manual occurrence when the last overlapping lease expires", async () => {
    const { adapter, request, advance } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const previous = await reserve(adapter, request());
    advance(900);
    await adapter.requestRun("first");
    const manual = new Date(epoch.getTime() + 900);
    // Expiry can occur between admission's state read and the adapter's skip call.
    expect((await adapter.listStates(["first"]))[0]!.activeRuns).toBe(1);
    advance(1_000);
    expect(await adapter.skip(request("first", { expectedScheduledAt: manual, overlap: "skip" }))).toBe(false);
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ nextScheduledAt: epoch, manualRunRequestedAt: manual, activeRuns: 0 });
    expect(await adapter.release(previous)).toBe(false);
  });

  it.each(["release", "expiry"] as const)("restores the earliest unhandled manual occurrence after %s", async (reason) => {
    const { adapter, request, advance } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: new Date(epoch.getTime() + 60_000) }]);
    await adapter.requestRun("first");
    const manual = await reserve(adapter, request());
    advance(100);
    await adapter.requestRun("first");
    advance(200);
    await adapter.requestRun("first");
    if (reason === "release") expect(await adapter.release(manual)).toBe(true);
    else { advance(1_000); expect(await adapter.pruneExpiredRuns({ limit: 1 })).toBe(1); }
    expect((await adapter.listStates(["first"]))[0]!.manualRunRequestedAt).toEqual(epoch);
  });

  it("restores a manual occurrence without a pending request and retains it when a newer run is released", async () => {
    const { adapter, request, advance } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: new Date(epoch.getTime() + 60_000) }]);
    await adapter.requestRun("first");
    const older = await reserve(adapter, request());
    advance(100);
    await adapter.requestRun("first");
    const newer = await reserve(adapter, request("first", { expectedScheduledAt: new Date(epoch.getTime() + 100) }));
    expect((await adapter.listStates(["first"]))[0]!.manualRunRequestedAt).toBeUndefined();
    expect(await adapter.release(older)).toBe(true);
    expect((await adapter.listStates(["first"]))[0]!.manualRunRequestedAt).toEqual(epoch);
    expect(await adapter.release(newer)).toBe(true);
    expect((await adapter.listStates(["first"]))[0]!.manualRunRequestedAt).toEqual(epoch);
  });

  it("restores the earlier scheduled occurrence after release", async () => {
    const { adapter, request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const first = await reserve(adapter, request());
    expect(await adapter.release(first)).toBe(true);
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ activeRuns: 0, nextScheduledAt: epoch });
  });

  it("extends only its owned lease and expires it at the inclusive boundary", async () => {
    const { adapter, request, advance } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const first = await reserve(adapter, request());
    advance(500);
    expect(await adapter.extendLease({ ...first, leaseMs: 2_000 })).toBe(true);
    advance(1_000);
    expect(await adapter.pruneExpiredRuns({ limit: 1 })).toBe(0);
    advance(2_500);
    expect(await adapter.pruneExpiredRuns({ limit: 1 })).toBe(1);
    expect(await adapter.release(first)).toBe(false);
  });

  it("uses the default prune limit and leaves fresh reservations untouched", async () => {
    const { adapter, request, advance } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }, { taskId: "second", nextScheduledAt: epoch }]);
    await reserve(adapter, request());
    await reserve(adapter, request("second", { leaseMs: 2_000 }));
    advance(1_000);
    expect(await adapter.pruneExpiredRuns({})).toBe(1);
    expect((await adapter.listStates(["first", "second"])).map((state) => state.activeRuns)).toEqual([0, 1]);
  });

  it("applies pause resume dates defensively and ignores them when pausing", async () => {
    const { adapter } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const resume = new Date(epoch.getTime() + 60_000);
    await adapter.setPaused("first", true, resume);
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toEqual(epoch);
    await adapter.setPaused("first", false, resume);
    resume.setTime(0);
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toEqual(new Date(epoch.getTime() + 60_000));
  });

  it("rejects controls for unregistered task ids", async () => {
    const { adapter } = setup();
    await expect(adapter.requestRun("missing")).rejects.toThrow(/"missing"/u);
    await expect(adapter.setPaused("missing", true)).rejects.toThrow(/"missing"/u);
    expect(await adapter.skip({ taskId: "missing", expectedScheduledAt: epoch, overlap: "wait", leaseMs: 1 })).toBe(false);
  });

  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects an invalid prune limit ${String(limit)} and reservation lease`, async () => {
      const { adapter, request } = setup();
      await expect(adapter.pruneExpiredRuns({ limit })).rejects.toThrow(new TypeError("Scheduled task prune limit must be a positive integer."));
      await expect(adapter.reserve(request("first", { leaseMs: limit }))).rejects.toThrow(new TypeError("leaseMs must be a positive integer."));
    });
  }
});

// Recovery must behave identically when initiated by admission, inspection or bounded maintenance.
describe("memory scheduled-task implicit recovery and snapshots", () => {
  it("prunes by expiry and then token rather than reservation insertion order", async () => {
    let now = new Date(epoch);
    const tokens = ["z", "b", "a"];
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now, createReservationToken: () => tokens.shift()! });
    const ids = ["later", "tie-second", "tie-first"];
    await adapter.reconcile(ids.map((taskId) => ({ taskId, nextScheduledAt: epoch })));
    for (const [index, taskId] of ids.entries()) {
      const nextScheduledAt = new Date(epoch.getTime() + 60_000);
      await reserve(adapter, { taskId, expectedScheduledAt: epoch, nextScheduledAt, overlap: "wait", leaseMs: index === 0 ? 2_000 : 1_000 });
    }
    now = new Date(epoch.getTime() + 2_000);
    expect(await adapter.pruneExpiredRuns({ limit: 1 })).toBe(1);
    // Completing untouched runs proves which owner remains without triggering automatic recovery.
    expect(await adapter.complete({ taskId: "tie-first", reservationToken: "a", completedAt: now, outcome: "success" })).toBe(false);
    expect(await adapter.complete({ taskId: "tie-second", reservationToken: "b", completedAt: now, outcome: "success" })).toBe(true);
    expect(await adapter.complete({ taskId: "later", reservationToken: "z", completedAt: now, outcome: "success" })).toBe(true);
  });

  it("recovers expired ownership at the exact boundary before a new reservation", async () => {
    const { adapter, request, advance } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const old = await reserve(adapter, request());
    advance(1_000);
    const current = await reserve(adapter, request());
    expect(current.reservationToken).not.toBe(old.reservationToken);
    expect(await adapter.release(old)).toBe(false);
    expect(await adapter.complete({ ...current, completedAt: epoch, outcome: "success" })).toBe(true);
  });

  it("recovers expired ownership before exposing an inspection snapshot", async () => {
    const { adapter, request, advance } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const old = await reserve(adapter, request());
    advance(1_000);
    expect(adapter.inspectStates()).toMatchObject([{ taskId: "first", activeRuns: 0, nextScheduledAt: epoch }]);
    expect(await adapter.release(old)).toBe(false);
  });

  it("does not expose mutable manual, start or completion timestamps", async () => {
    const { adapter, request, advance } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: new Date(epoch.getTime() + 60_000) }]);
    await adapter.requestRun("first");
    const [pending] = await adapter.listStates(["first"]);
    pending!.manualRunRequestedAt!.setTime(0);
    expect((await adapter.listStates(["first"]))[0]!.manualRunRequestedAt).toEqual(epoch);
    const manual = await reserve(adapter, request());
    const [active] = await adapter.listStates(["first"]);
    expect(active!.lastStartedAt).toEqual(epoch);
    active!.lastStartedAt!.setTime(0);
    expect((await adapter.listStates(["first"]))[0]!.lastStartedAt).toEqual(epoch);
    advance(100);
    const completedAt = new Date(epoch.getTime() + 100);
    await adapter.complete({ ...manual, completedAt, outcome: "success" });
    const [complete] = await adapter.listStates(["first"]);
    complete!.lastCompletedAt!.setTime(0);
    completedAt.setTime(0);
    expect((await adapter.listStates(["first"]))[0]!.lastCompletedAt).toEqual(new Date(epoch.getTime() + 100));
  });

  it.each(["next", "postpone"] as const)("retains completion's sole %s scheduling date", async (source) => {
    const { adapter, request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const { nextScheduledAt: _nextScheduledAt, ...loopRequest } = request();
    const current = await reserve(adapter, loopRequest);
    const next = new Date(epoch.getTime() + 5_000);
    await adapter.complete({ ...current, completedAt: epoch, outcome: "success", ...(source === "next" ? { nextScheduledAt: next } : { postponeUntil: next }) });
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toEqual(next);
  });

  it("refuses a consumed loop occurrence without treating an absent cadence as a date", async () => {
    const { adapter, request } = setup();
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: epoch }]);
    const { nextScheduledAt: _nextScheduledAt, ...loopRequest } = request();
    await reserve(adapter, loopRequest);
    expect(await adapter.reserve(loopRequest)).toEqual({ status: "stale" });
    expect(await adapter.skip(loopRequest)).toBe(false);
  });
});
