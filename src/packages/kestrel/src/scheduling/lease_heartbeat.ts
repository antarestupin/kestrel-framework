import { addAbortListener } from "node:events";

export interface LeaseHeartbeatOptions {
  intervalMs: number;
  /** Stop renewing ownership when application work is cancelled. */
  signal?: AbortSignal | undefined;
  extend(): Promise<unknown>;
  onFailure?(error: unknown): void;
}

export interface LeaseHeartbeat {
  /** Stops future extensions and surfaces the last in-flight failure. */
  close(): Promise<void>;
}

/** Runs non-overlapping lease extensions until the owner closes the heartbeat. */
export function startLeaseHeartbeat(
  options: LeaseHeartbeatOptions,
): LeaseHeartbeat {
  let active: Promise<unknown> | undefined;
  let failure: unknown;
  let failed = false;
  const interval = setInterval(() => {
    if (active !== undefined) return;
    // Own the extension before invoking it so synchronous adapter failures and
    // rejected promises follow the same failure and cleanup path.
    active = Promise.resolve().then(() => options.extend()).catch((error: unknown) => {
      failed = true;
      failure = error;
      clearInterval(interval);

      try {
        options.onFailure?.(error);
      } catch {
        // Failure notification must not hide the extension failure.
      }
    }).finally(() => {
      active = undefined;
    });
  }, options.intervalMs);
  interval.unref();
  const signal = options.signal;
  // Stop immediately even when another shutdown listener stops propagation.
  const subscription = signal === undefined ? undefined : addAbortListener(signal, () => clearInterval(interval));
  if (signal?.aborted) clearInterval(interval);

  return {
    close: async () => {
      clearInterval(interval);
      subscription?.[Symbol.dispose]();
      await active;
      if (failed) throw failure;
    },
  };
}
