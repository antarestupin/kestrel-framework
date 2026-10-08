import type { Pool, PoolClient } from "pg";

import type { PostgresDrizzleConfig } from "./configuration.js";

export type PostgresPoolState = "unknown" | "healthy" | "degraded" | "closing" | "closed";
export type PostgresPoolFailure = "pool_error" | "acquisition_failed" | "queue_full" | "closing" | "shutdown_timeout" | "shutdown_failed";

/** Policy errors never imply that a failed write is safe to retry. */
export class PostgresPoolPolicyError extends Error {
  public constructor(public readonly code: PostgresPoolFailure) {
    super(`PostgreSQL pool policy: ${code}`);
    this.name = "PostgresPoolPolicyError";
  }
}

export interface PostgresPoolEvent {
  readonly type: "acquisition" | "pool_error" | "shutdown";
  readonly outcome: "success" | "failure";
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly failure?: PostgresPoolFailure;
  readonly errorCode?: string | undefined;
}

export interface PostgresPoolSnapshot {
  readonly state: PostgresPoolState;
  readonly total: number;
  readonly idle: number;
  /** Checked-out connections, including connections held between statements. */
  readonly active: number;
  readonly waiting: number;
  readonly acquiring: number;
  readonly acquisitions: number;
  readonly acquisitionFailures: number;
  readonly lastAcquisitionDurationMs?: number | undefined;
  readonly lastFailure?: PostgresPoolEvent | undefined;
}

type ConnectCallback = (error: Error | undefined, client?: PoolClient, release?: PoolClient["release"]) => void;

/** Owns pool admission and disposal without implementing SQL or Drizzle transactions. */
export class PostgresPoolRuntime {
  private state: PostgresPoolState = "unknown";
  private readonly pending = new Set<ConnectCallback>();
  private readonly leases = new Map<PoolClient, () => void>();
  private acquisitions = 0;
  private acquisitionFailures = 0;
  private lastAcquisitionDurationMs?: number;
  private lastFailure?: PostgresPoolEvent;
  private closePromise?: Promise<void>;
  private failureVersion = 0;
  private readonly reportedErrors = new WeakSet<Error>();

  public constructor(
    private readonly pool: Pool,
    private readonly policy: PostgresDrizzleConfig["resourcePolicy"],
    private readonly onEvent?: (event: PostgresPoolEvent) => void | Promise<void>,
  ) {
    // Idle pool errors and checked-out client errors can occur without a query observer.
    pool.on("error", this.onError);
    pool.on("connect", (client) => {
      client.on("error", this.onError);
      client.once("end", () => {
        this.leases.get(client)?.();
        client.removeListener("error", this.onError);
      });
    });
    const connect = pool.connect.bind(pool);
    pool.connect = ((callback?: ConnectCallback) => {
      if (callback !== undefined) {
        this.acquire(connect, callback);
        return;
      }
      const PromiseConstructor = pool.options.Promise ?? Promise;
      return new PromiseConstructor<PoolClient>((resolve, reject) => {
        this.acquire(connect, (error, client) => error ? reject(error) : resolve(client!));
      });
    }) as Pool["connect"];
  }

  public snapshot(): PostgresPoolSnapshot {
    return {
      state: this.state,
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      active: this.pool.totalCount - this.pool.idleCount,
      waiting: this.pool.waitingCount,
      acquiring: this.pending.size,
      acquisitions: this.acquisitions,
      acquisitionFailures: this.acquisitionFailures,
      lastAcquisitionDurationMs: this.lastAcquisitionDurationMs,
      lastFailure: this.lastFailure === undefined ? undefined : { ...this.lastFailure },
    };
  }

  /** A successful bounded query is evidence of recovery; acquisition alone is not. */
  public async checkHealth(): Promise<PostgresPoolSnapshot> {
    const version = this.failureVersion;
    try {
      await this.pool.query("select 1");
      if (!this.isClosing() && version === this.failureVersion) this.state = "healthy";
    } catch (error) {
      if (!this.isClosing() && !(error instanceof PostgresPoolPolicyError)) {
        this.state = "degraded";
        this.failureVersion++;
      }
      throw error;
    }
    return this.snapshot();
  }

  /** Stop admission immediately, then drain until the deadline and evict owned leases. */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.state = "closing";
    // Start on a microtask so reentrant disposal always sees the same promise.
    this.closePromise = Promise.resolve().then(() => this.drain());
    return this.closePromise;
  }

  private async drain(): Promise<void> {
    for (const finish of [...this.pending]) {
      // User callbacks must not interrupt resource disposal by throwing synchronously.
      queueMicrotask(() => finish(new PostgresPoolPolicyError("closing")));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Destroy the transport as well: pg's pipelined end() otherwise waits for drain.
          for (const [client, evict] of [...this.leases]) {
            client.connection.stream.destroy();
            evict();
          }
          reject(new PostgresPoolPolicyError("shutdown_timeout"));
        }, this.policy.shutdownTimeoutMs);
      });
      await Promise.race([this.pool.end(), deadline]);
      this.report({ type: "shutdown", outcome: "success", timestamp: Date.now() });
    } catch (error) {
      this.report({
        type: "shutdown", outcome: "failure", timestamp: Date.now(),
        failure: error instanceof PostgresPoolPolicyError ? error.code : "shutdown_failed",
      });
      throw error;
    } finally {
      clearTimeout(timer);
      this.state = "closed";
      // Retain the error boundary for any late native connection completion.
    }
  }

  private acquire(connect: Pool["connect"], callback: ConnectCallback): void {
    const start = performance.now();
    let finished = false;
    const finish: ConnectCallback = (error, client, release) => {
      if (finished) {
        // A pending native connection may complete after shutdown rejected its caller.
        if (client !== undefined) (release ?? client.release.bind(client))(true);
        return;
      }
      // Native next-tick completion can beat the close microtask. Never hand out
      // a new lease after close() has synchronously stopped admission.
      if (this.isClosing() && client !== undefined) {
        (release ?? client.release.bind(client))(true);
        client = undefined;
        error = new PostgresPoolPolicyError("closing");
      }
      finished = true;
      this.pending.delete(finish);
      this.acquisitions++;
      this.lastAcquisitionDurationMs = performance.now() - start;
      if (error) this.acquisitionFailures++;
      if (error && !(error instanceof PostgresPoolPolicyError) && !this.isClosing()) {
        this.state = "degraded";
        this.failureVersion++;
      }
      this.report({
        type: "acquisition", outcome: error ? "failure" : "success", timestamp: Date.now(),
        durationMs: this.lastAcquisitionDurationMs,
        ...(error ? { failure: error instanceof PostgresPoolPolicyError ? error.code : "acquisition_failed", errorCode: safeErrorCode(error) } : {}),
      });
      if (client !== undefined) {
        const nativeRelease = release ?? client.release.bind(client);
        let released = false;
        let evicted = false;
        // Drizzle and pg callbacks may release after eviction; never release a new lease.
        const ownedRelease: PoolClient["release"] = (reason) => {
          if (released) {
            // Preserve pg double-release errors unless Kestrel already evicted the lease.
            if (!evicted) nativeRelease(reason);
            return;
          }
          released = true;
          this.leases.delete(client);
          nativeRelease(reason);
        };
        this.leases.set(client, () => {
          evicted = true;
          ownedRelease(true);
        });
        client.release = ownedRelease;
        callback(error, client, ownedRelease);
      } else {
        callback(error);
      }
    };
    if (this.isClosing()) {
      queueMicrotask(() => finish(new PostgresPoolPolicyError("closing")));
      return;
    }
    // Include in-flight acquisitions: pg can assign idle clients on the next tick.
    if (this.pending.size + this.leases.size >= this.pool.options.max! + this.policy.maxWaitingRequests) {
      queueMicrotask(() => finish(new PostgresPoolPolicyError("queue_full")));
      return;
    }
    this.pending.add(finish);
    connect((error, client, release) => finish(error ?? undefined, client, release));
  }

  private isClosing(): boolean {
    return this.state === "closing" || this.state === "closed";
  }

  private readonly onError = (error: Error): void => {
    // pg forwards the same idle-client error through both client and pool events.
    if (this.reportedErrors.has(error)) return;
    this.reportedErrors.add(error);
    if (!this.isClosing()) this.state = "degraded";
    this.failureVersion++;
    this.report({ type: "pool_error", outcome: "failure", timestamp: Date.now(), failure: "pool_error", errorCode: safeErrorCode(error) });
  };

  private report(event: PostgresPoolEvent): void {
    if (event.outcome === "failure") this.lastFailure = { ...event };
    try {
      // Sinks must not throw into pg event handlers or create unhandled rejections.
      const result = this.onEvent?.({ ...event });
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {
      // Diagnostics never alter database outcomes.
    }
  }
}

/** Error messages, SQL, credentials and arbitrary user-supplied codes are excluded. */
function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" && (/^[0-9A-Z]{5}$/.test(code) || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(code))
    ? code : undefined;
}
