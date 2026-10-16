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
  const stop = () => clearInterval(interval);
  const interval = setInterval(() => {
    if (options.signal?.aborted) { stop(); return; }
    if (active !== undefined) return;
    active = options.extend().catch((error: unknown) => {
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
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  return {
    close: async () => {
      clearInterval(interval);
      options.signal?.removeEventListener("abort", stop);
      await active;
      if (failed) throw failure;
    },
  };
}
