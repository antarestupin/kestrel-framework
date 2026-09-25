import { CronExpressionParser } from "cron-parser";

/** Human-readable duration accepted by scheduling helpers. */
export interface ScheduleDuration {
  milliseconds?: number;
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
  weeks?: number;
}

export interface ScheduleNextContext {
  scheduledAt: Date;
  completedAt: Date;
}

interface ScheduledTaskScheduleContract {
  initial(now: Date): Date;
  next(context: ScheduleNextContext): Date;
}

export interface EveryScheduledTaskSchedule extends ScheduledTaskScheduleContract {
  readonly kind: "every";
  readonly intervalMs: number;
  readonly start: "after-interval" | "immediate";
}

export interface LoopScheduledTaskSchedule extends ScheduledTaskScheduleContract {
  readonly kind: "loop";
  readonly delayMs: number;
  readonly start: "after-delay" | "immediate";
}

export interface CronScheduledTaskSchedule extends ScheduledTaskScheduleContract {
  readonly kind: "cron";
  readonly expression: string;
  readonly timeZone?: string;
}

/** Pure, inspectable calendar contract used by the scheduler and tooling. */
export type ScheduledTaskSchedule =
  | CronScheduledTaskSchedule
  | EveryScheduledTaskSchedule
  | LoopScheduledTaskSchedule;

export interface EveryScheduleOptions extends ScheduleDuration {
  start?: "after-interval" | "immediate";
}

export interface LoopScheduleOptions {
  delay: ScheduleDuration;
  start?: "after-delay" | "immediate";
}

export interface CronScheduleOptions {
  timeZone?: string;
}

/** Creates a fixed cadence whose occurrences stay aligned to their schedule. */
export function every(options: EveryScheduleOptions): EveryScheduledTaskSchedule {
  const intervalMs = durationToMs(options);
  const start = options.start ?? "after-interval";

  return {
    kind: "every",
    intervalMs,
    start,
    initial: (now) => start === "immediate"
      ? new Date(now)
      : new Date(now.getTime() + intervalMs),
    next: ({ scheduledAt, completedAt }) => {
      // Coalesce missed occurrences while preserving the original cadence.
      const elapsed = completedAt.getTime() - scheduledAt.getTime();
      const intervals = Math.max(1, Math.floor(elapsed / intervalMs) + 1);
      return new Date(scheduledAt.getTime() + intervals * intervalMs);
    },
  };
}

/** Creates a loop whose delay starts after the previous handler completes. */
export function loop(options: LoopScheduleOptions): LoopScheduledTaskSchedule {
  const delayMs = durationToMs(options.delay);
  const start = options.start ?? "immediate";

  return {
    kind: "loop",
    delayMs,
    start,
    initial: (now) => start === "immediate"
      ? new Date(now)
      : new Date(now.getTime() + delayMs),
    next: ({ completedAt }) => new Date(completedAt.getTime() + delayMs),
  };
}

/** Creates a timezone-aware five-field cron schedule. */
export function cron(
  expression: string,
  options: CronScheduleOptions = {},
): CronScheduledTaskSchedule {
  validateCron(expression, options);

  const nextAfter = (date: Date): Date => CronExpressionParser.parse(
    expression,
    {
      currentDate: date,
      ...(options.timeZone === undefined ? {} : { tz: options.timeZone }),
    },
  ).next().toDate();

  return {
    kind: "cron",
    expression,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    initial: nextAfter,
    next: ({ completedAt }) => nextAfter(completedAt),
  };
}

/** Converts a structured duration into a validated millisecond value. */
export function durationToMs(duration: ScheduleDuration): number {
  const values = [
    ["milliseconds", duration.milliseconds, 1],
    ["seconds", duration.seconds, 1_000],
    ["minutes", duration.minutes, 60_000],
    ["hours", duration.hours, 3_600_000],
    ["days", duration.days, 86_400_000],
    ["weeks", duration.weeks, 604_800_000],
  ] as const;
  let total = 0;

  for (const [name, value, multiplier] of values) {
    if (value === undefined) {
      continue;
    }

    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative finite number.`);
    }

    total += value * multiplier;
  }

  if (!Number.isFinite(total) || total <= 0) {
    throw new TypeError("A schedule duration must be positive and finite.");
  }

  return total;
}

function validateCron(
  expression: string,
  options: CronScheduleOptions,
): void {
  if (expression.trim().split(/\s+/u).length !== 5) {
    throw new TypeError("Cron schedules must use exactly five fields.");
  }

  // Parsing eagerly keeps invalid task definitions from reaching bootstrap.
  CronExpressionParser.parse(expression, {
    currentDate: new Date(0),
    ...(options.timeZone === undefined ? {} : { tz: options.timeZone }),
  });
}
