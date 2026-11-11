import {
  describe,
  expect,
  it,
  vi,
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

// Calendar boundaries are observable contracts; these cases avoid testing cron-parser internals.
describe("scheduled task calendar boundaries", () => {
  it("starts every schedules immediately when requested and preserves their metadata", () => {
    const schedule = every({ seconds: 1, start: "immediate" });
    const now = new Date(10_000);
    expect(schedule).toMatchObject({ kind: "every", intervalMs: 1_000, start: "immediate" });
    expect(schedule.initial(now)).toEqual(now);
    expect(schedule.initial(now)).not.toBe(now);
    for (const elapsed of [-1, 0, 999, 1_000, 1_001, 2_000]) {
      expect(schedule.next({ scheduledAt: now, completedAt: new Date(now.getTime() + elapsed) })).toEqual(new Date(now.getTime() + Math.max(1, Math.floor(elapsed / 1_000) + 1) * 1_000));
    }
  });

  it("supports delayed loop startup and calculates subsequent delays from completion", () => {
    const schedule = loop({ delay: { milliseconds: 5 }, start: "after-delay" });
    expect(schedule).toMatchObject({ kind: "loop", delayMs: 5, start: "after-delay" });
    expect(schedule.initial(new Date(1_000))).toEqual(new Date(1_005));
    expect(schedule.next({ scheduledAt: new Date(1_000), completedAt: new Date(2_000) })).toEqual(new Date(2_005));
    expect(loop({ delay: { seconds: 1 } }).start).toBe("immediate");
  });

  it("retains cron metadata and advances from completion rather than the original occurrence", () => {
    const schedule = cron("0 9 * * *", { timeZone: "Europe/Paris" });
    expect(schedule).toMatchObject({ kind: "cron", expression: "0 9 * * *", timeZone: "Europe/Paris" });
    expect(schedule.next({ scheduledAt: new Date("2026-07-01T07:00:00Z"), completedAt: new Date("2026-07-02T08:00:00Z") })).toEqual(new Date("2026-07-03T07:00:00Z"));
    // Make the documented default independent of the machine running this test.
    vi.stubEnv("TZ", "Europe/Paris");
    try {
      const utc = cron("0 9 * * *");
      expect(utc).not.toHaveProperty("timeZone");
      expect(utc.initial(new Date("2026-07-01T10:00:00Z"))).toEqual(new Date("2026-07-02T09:00:00Z"));
    } finally { vi.unstubAllEnvs(); }
  });

  it("accepts whitespace around and between the five cron fields", () => {
    expect(cron("  0   9 * * *  ").initial(new Date("2026-07-01T08:00:00Z"))).toEqual(new Date("2026-07-01T09:00:00Z"));
  });

  it("rejects invalid cron expressions and timezones eagerly", () => {
    expect(() => cron("0 30 * * *")).toThrow();
    expect(() => cron("0 9 * * *", { timeZone: "Invalid/Zone" })).toThrow();
  });

  it("adds every duration unit and supports finite fractional units", () => {
    expect(durationToMs({ milliseconds: 1, seconds: 1, minutes: 1, hours: 1, days: 1, weeks: 1 })).toBe(694_861_001);
    expect(durationToMs({ milliseconds: 0, seconds: 0.5 })).toBe(500);
  });

  it("rejects each invalid component even when the total would otherwise remain positive", () => {
    for (const unit of ["milliseconds", "seconds", "minutes", "hours", "days", "weeks"]) {
      for (const value of [-1, NaN, Infinity, -Infinity]) {
        expect(() => durationToMs({ weeks: 2, [unit]: value })).toThrow(expect.objectContaining({
          name: "TypeError", message: expect.stringContaining(unit),
        }));
      }
    }
    expect(() => durationToMs({})).toThrow(TypeError);
    expect(() => durationToMs({ weeks: Number.MAX_VALUE })).toThrow(TypeError);
  });
});
