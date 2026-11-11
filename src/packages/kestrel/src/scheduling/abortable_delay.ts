import { addAbortListener } from "node:events";

const MAXIMUM_TIMER_MS = 2_147_483_647;

/** Waits until the delay expires or the signal aborts. Timers are unrefed by default. */
export function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
  { ref = false }: { ref?: boolean } = {},
): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const finish = () => {
      subscription[Symbol.dispose]();
      clearTimeout(timeout);
      resolve();
    };

    // Node coerces oversized timers to 1 ms. Recheck long delays against a
    // monotonic deadline so a delayed segment does not extend the total wait.
    const deadline = performance.now() + delayMs;
    const arm = (remaining: number) => {
      if (Number.isFinite(remaining) && remaining > MAXIMUM_TIMER_MS) {
        timeout = setTimeout(() => arm(Math.max(0, deadline - performance.now())), MAXIMUM_TIMER_MS);
      } else {
        timeout = setTimeout(finish, remaining);
      }
      if (!ref) timeout.unref();
    };

    // Other consumers of this signal may stop event propagation.
    const subscription = addAbortListener(signal, finish);
    arm(delayMs);
  });
}
