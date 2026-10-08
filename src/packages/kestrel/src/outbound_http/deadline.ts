import { OutboundHttpAbortedError, OutboundHttpTimeoutError } from "./errors.js";

/** One cancellation boundary for preparation, middleware, body reads and decoding. */
export class OutboundHttpDeadline {
  public readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly expiration = Promise.withResolvers<never>();
  private readonly expiresAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly timeoutError: OutboundHttpTimeoutError | undefined;

  public constructor(
    private readonly operation: string,
    timeoutMs: number | undefined,
    callerSignal: AbortSignal | null | undefined,
  ) {
    this.signal = callerSignal == null
      ? this.controller.signal
      : AbortSignal.any([callerSignal, this.controller.signal]);
    // Install a rejection observer even when cancellation precedes the first run.
    void this.expiration.promise.catch(() => {});
    this.signal.addEventListener("abort", this.onAbort, { once: true });
    if (this.signal.aborted) this.onAbort();
    if (timeoutMs !== undefined) {
      this.expiresAt = performance.now() + timeoutMs;
      this.timeoutError = new OutboundHttpTimeoutError(operation, timeoutMs);
      this.schedule();
    }
  }

  public error(): Error {
    return this.signal.reason === this.timeoutError && this.timeoutError !== undefined
      ? this.timeoutError
      : new OutboundHttpAbortedError(this.operation, { cause: this.signal.reason });
  }

  public check(): void {
    // A synchronous decoder may finish before the overdue timer gets a turn.
    if (this.expiresAt !== undefined && performance.now() >= this.expiresAt) {
      this.controller.abort(this.timeoutError);
    }
    if (this.signal.aborted) throw this.error();
    if (this.closed) throw new Error("The outbound HTTP operation has completed.");
  }

  public async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.check();
    const result = await Promise.race([operation(), this.expiration.promise]);
    this.check();
    return result;
  }

  public close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.onAbort);
  }

  private schedule(): void {
    const remaining = this.expiresAt! - performance.now();
    if (remaining <= 0) {
      this.controller.abort(this.timeoutError);
      return;
    }
    // Node timers overflow beyond this range; long budgets need multiple intervals.
    this.timer = setTimeout(() => this.schedule(), Math.min(remaining, 2_147_483_647));
    this.timer.unref();
  }

  private readonly onAbort = (): void => {
    this.expiration.reject(this.error());
  };
}
