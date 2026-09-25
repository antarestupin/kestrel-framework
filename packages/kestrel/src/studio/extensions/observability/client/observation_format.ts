/** Formats an optional observation duration for compact list displays. */
export function formatObservationDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "running";
  }

  return durationMs < 1
    ? "<1 ms"
    : `${durationMs.toFixed(durationMs < 10 ? 1 : 0)} ms`;
}
