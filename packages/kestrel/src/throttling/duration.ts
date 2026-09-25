/** Structured positive duration accepted by throttling definitions. */
export interface ThrottlingDuration {
  readonly milliseconds?: number;
  readonly seconds?: number;
  readonly minutes?: number;
  readonly hours?: number;
  readonly days?: number;
}

/** Creates a duration expressed in milliseconds. */
export function milliseconds(value: number): ThrottlingDuration {
  return { milliseconds: value };
}

/** Creates a duration expressed in seconds. */
export function seconds(value: number): ThrottlingDuration {
  return { seconds: value };
}

/** Creates a duration expressed in minutes. */
export function minutes(value: number): ThrottlingDuration {
  return { minutes: value };
}

/** Converts and validates a structured duration at the definition boundary. */
export function throttlingDurationToMs(
  duration: ThrottlingDuration,
): number {
  const values = [
    ["milliseconds", duration.milliseconds, 1],
    ["seconds", duration.seconds, 1_000],
    ["minutes", duration.minutes, 60_000],
    ["hours", duration.hours, 3_600_000],
    ["days", duration.days, 86_400_000],
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
    throw new TypeError("A throttling duration must be positive and finite.");
  }

  return total;
}
