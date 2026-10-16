import { dep } from "../di/index.js";

export interface ShutdownOptions {
  /** Total budget shared by transport drain, scopes, diagnostics and disposers. */
  timeoutMs?: number;
  /** Time allowed for natural completion before cooperative cancellation. */
  drainMs?: number;
}

export const defaultShutdownOptions = Object.freeze({ timeoutMs: 30_000, drainMs: 20_000 });

export class ApplicationShutdownTimeoutError extends Error {
  public constructor(public readonly phase: string, public readonly timeoutMs: number) {
    super(`Application shutdown exceeded ${timeoutMs}ms during ${phase}.`);
    this.name = "ApplicationShutdownTimeoutError";
  }
}

/** Execution-owned code can inject this signal and forward it to cancellable I/O. */
export const executionSignalDependency = dep<AbortSignal>("executionSignal");

/** One monotonic deadline, created on first stop and never renewed by callers. */
export class ApplicationShutdown {
  private readonly controller = new AbortController();
  private readonly timeoutMs: number;
  private readonly drainMs: number;
  private startedAt: number | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters = new Set<(error: ApplicationShutdownTimeoutError) => void>();
  private readonly listeners = new Set<(error: ApplicationShutdownTimeoutError) => void>();
  private readonly drains = new Map<() => Promise<void>, Promise<void> | undefined>();
  private draining = false;
  private phase = "shutdown";
  private timeoutError: ApplicationShutdownTimeoutError | undefined;

  public get error(): ApplicationShutdownTimeoutError | undefined { return this.timeoutError; }

  public constructor(options: ShutdownOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? defaultShutdownOptions.timeoutMs;
    this.drainMs = options.drainMs ?? Math.min(defaultShutdownOptions.drainMs, this.timeoutMs);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(this.drainMs) || this.drainMs < 0 || this.drainMs > this.timeoutMs) {
      throw new TypeError("Shutdown requires 0 <= drainMs <= timeoutMs and a timeoutMs between 1 and 2147483647.");
    }
  }

  public get signal(): AbortSignal { return this.controller.signal; }

  public begin(): void {
    if (this.startedAt !== undefined) return;
    this.startedAt = performance.now();
    this.drainTimer = setTimeout(() => this.controller.abort(new Error("Application drain budget expired.")), this.drainMs);
    this.deadlineTimer = setTimeout(() => this.expire(), this.timeoutMs);
    // Embedded owners may abandon an app; these timers alone must not retain it.
    this.drainTimer.unref();
    this.deadlineTimer.unref();
  }

  /** Register transport ownership before it can admit application work. */
  public registerDrain(stop: () => Promise<void>): void {
    if (this.drains.has(stop)) return;
    this.drains.set(stop, undefined);
    if (this.draining) this.startDrain(stop);
  }

  public requestDrain(): void {
    this.draining = true;
    for (const stop of this.drains.keys()) this.startDrain(stop);
  }

  public async drained(): Promise<void> {
    this.requestDrain();
    const results = await Promise.allSettled([...this.drains.values()]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Transport drain failed.");
  }

  private startDrain(stop: () => Promise<void>): void {
    if (this.drains.get(stop) !== undefined) return;
    const draining = Promise.resolve().then(stop);
    this.drains.set(stop, draining);
    void draining.catch(() => undefined);
  }

  /** Process entry points may observe expiration without depending on app sinks. */
  public onTimeout(listener: (error: ApplicationShutdownTimeoutError) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Bound awaiting, without claiming cancellation of the underlying operation. */
  public async wait<Result>(phase: string, operation: () => Promise<Result> | Result): Promise<Result> {
    this.begin();
    this.phase = phase;
    if (this.remainingMs() <= 0) this.expire();
    if (this.error !== undefined) throw this.error;
    let rejectWait: (error: ApplicationShutdownTimeoutError) => void = () => undefined;
    const expired = new Promise<never>((_, reject) => { rejectWait = reject; });
    this.waiters.add(rejectWait);
    // A pending bounded wait keeps the deadline alive even without other handles.
    this.deadlineTimer?.ref();
    try {
      return await Promise.race([Promise.resolve().then(operation), expired]);
    } finally {
      this.waiters.delete(rejectWait);
      if (this.waiters.size === 0) this.deadlineTimer?.unref();
    }
  }

  public finish(): void {
    clearTimeout(this.drainTimer);
    clearTimeout(this.deadlineTimer);
    this.listeners.clear();
  }

  private remainingMs(): number {
    return this.timeoutMs - (performance.now() - this.startedAt!);
  }

  private expire(): void {
    if (this.error !== undefined) return;
    const error = new ApplicationShutdownTimeoutError(this.phase, this.timeoutMs);
    this.timeoutError = error;
    this.controller.abort(error);
    for (const reject of this.waiters) reject(error);
    for (const listener of this.listeners) {
      try { listener(error); } catch { /* Diagnostics cannot delay termination. */ }
    }
  }
}
