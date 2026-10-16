import { abortableDelay } from "./abortable_delay.js";

export interface PollingOptions {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  maxFailureDurationMs?: number;
  /** Unknown failures are terminal unless the owner explicitly classifies them. */
  isRecoverable?: (error: unknown) => boolean;
}

export interface PollingState {
  readonly status: "idle" | "running" | "backoff" | "stopped" | "failed";
  readonly consecutiveFailures: number;
  readonly successfulCycles: number;
  readonly lastSuccessfulCycleAt?: number;
  readonly nextRetryAt?: number | undefined;
  readonly error?: unknown;
}

/** Supervises infrastructure cycles; durable task retry remains a separate policy. */
export class PollingSupervisor {
  private current: PollingState = { status: "idle", consecutiveFailures: 0, successfulCycles: 0 };
  private readonly initial: number;
  private readonly maximum: number;
  private readonly failureBudget: number;

  public constructor(private readonly options: PollingOptions = {}) {
    this.initial = options.initialBackoffMs ?? 100;
    this.maximum = options.maxBackoffMs ?? 5_000;
    this.failureBudget = options.maxFailureDurationMs ?? 60_000;
    if ([this.initial, this.maximum, this.failureBudget].some((value) => !Number.isSafeInteger(value) || value <= 0)
      || this.maximum < this.initial || this.maximum > 2_147_483_647) throw new TypeError("Invalid polling backoff or failure budget.");
  }

  public get state(): PollingState { return { ...this.current }; }

  public async run(
    signal: AbortSignal,
    cycle: () => Promise<boolean>,
    idleMs: number,
    report: (error: unknown) => void = () => undefined,
  ): Promise<void> {
    let firstFailureAt: number | undefined;
    this.current = { ...this.current, status: "running" };
    try {
      while (!signal.aborted) {
        this.current = { ...this.current, status: "running", nextRetryAt: undefined };
        let useful: boolean;
        try {
          useful = await cycle();
        } catch (error) {
          if (signal.aborted) break;
          firstFailureAt ??= performance.now();
          const failures = this.current.consecutiveFailures + 1;
          this.current = { ...this.current, consecutiveFailures: failures, error };
          try { report(error); } catch { /* Reporting must not replace polling failures. */ }
          const remaining = this.failureBudget - (performance.now() - firstFailureAt);
          if (!(this.options.isRecoverable?.(error) ?? false) || remaining <= 0) throw error;
          const cap = Math.min(this.maximum, this.initial * 2 ** Math.min(failures - 1, 30));
          const delay = Math.min(remaining, cap * (0.5 + Math.random() * 0.5));
          this.current = { ...this.current, status: "backoff", nextRetryAt: Date.now() + delay };
          await abortableDelay(delay, signal);
          if (!signal.aborted && performance.now() - firstFailureAt >= this.failureBudget) throw error;
          continue;
        }
        firstFailureAt = undefined;
        this.current = {
          status: "running", consecutiveFailures: 0,
          successfulCycles: this.current.successfulCycles + 1, lastSuccessfulCycleAt: Date.now(),
        };
        if (!useful) await abortableDelay(idleMs, signal);
      }
      this.current = { ...this.current, status: "stopped", nextRetryAt: undefined };
    } catch (error) {
      this.current = { ...this.current, status: "failed", error, nextRetryAt: undefined };
      throw error;
    }
  }
}
