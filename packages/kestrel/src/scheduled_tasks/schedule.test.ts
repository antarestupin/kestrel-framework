import {
  describe,
  expect,
  it,
} from "vitest";

import {
  cron,
  durationToMs,
  every,
  loop,
} from "./schedule.js";

describe("scheduled task schedules", () => {
  it("keeps every schedules aligned while coalescing missed occurrences", () => {
    const schedule = every({ minutes: 1 });
    const initial = schedule.initial(new Date("2026-01-01T00:00:00.000Z"));

    expect(initial).toEqual(new Date("2026-01-01T00:01:00.000Z"));
    expect(schedule.next({
      scheduledAt: initial,
      completedAt: new Date("2026-01-01T00:03:10.000Z"),
    })).toEqual(new Date("2026-01-01T00:04:00.000Z"));
  });

  it("starts loop delays after handler completion", () => {
    const schedule = loop({ delay: { seconds: 30 } });

    expect(schedule.initial(new Date("2026-01-01T00:00:00.000Z")))
      .toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(schedule.next({
      scheduledAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:12.000Z"),
    })).toEqual(new Date("2026-01-01T00:00:42.000Z"));
  });

  it("calculates five-field cron occurrences in an explicit timezone", () => {
    const schedule = cron("0 9 * * *", { timeZone: "Europe/Paris" });

    expect(schedule.initial(new Date("2026-07-01T06:00:00.000Z")))
      .toEqual(new Date("2026-07-01T07:00:00.000Z"));
  });

  it("rejects invalid durations and non-standard cron field counts", () => {
    expect(() => durationToMs({ seconds: 0 })).toThrow(/positive/u);
    expect(() => cron("0 0 9 * * *")).toThrow(/five fields/u);
  });
});
