export interface LeaseHeartbeatOptions {
  intervalMs: number;
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

  return {
    close: async () => {
      clearInterval(interval);
      await active;
      if (failed) throw failure;
    },
  };
}
