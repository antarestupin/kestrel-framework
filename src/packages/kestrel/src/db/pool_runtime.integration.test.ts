import { once } from "node:events";
import { sql } from "drizzle-orm";
import { type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { createPostgresTestConfig, createPostgresTestPool } from "../testing/postgres.js";
import { postgresDrizzleConfigBase } from "./configuration.js";
import { PostgresDrizzleProvider, type PostgresDrizzleClient } from "./provider.js";

/** Each case owns its pool and session settings; no shared database objects are required. */
function fixture(overrides: Record<string, unknown> = {}) {
  const config = postgresDrizzleConfigBase.schema.parse({
    ...createPostgresTestConfig(), max: 1, connectionTimeoutMillis: 150,
    statement_timeout: 100, lock_timeout: 50, idle_in_transaction_session_timeout: 300,
    options: "-c transaction_timeout=2000", query_timeout: 1_000,
    resourcePolicy: { maxWaitingRequests: 1, shutdownTimeoutMs: 100 },
    ...overrides,
  });
  const app = new App({}).register(new PostgresDrizzleProvider(config));
  const client = app.container.resolve(dep<PostgresDrizzleClient>("databaseClient"));
  return { app, client };
}

describe("PostgreSQL provider failure recovery", () => {
  it("bounds exhaustion, rejects queue overflow, then recovers", async () => {
    const { app, client } = fixture();
    let held: PoolClient | undefined;
    try {
      held = await client.pool.connect();
      const start = performance.now();
      const waiting = client.pool.connect();
      const expired = expect(waiting).rejects.toThrow(/timeout/);
      await expect(client.pool.connect()).rejects.toMatchObject({ code: "queue_full" });
      expect(client.snapshot()).toMatchObject({ active: 1, waiting: 1 });
      await expired;
      expect(performance.now() - start).toBeLessThan(1_500);
      expect(client.snapshot().waiting).toBe(0);
      held.release();
      held = undefined;
      expect((await client.checkHealth()).state).toBe("healthy");
      expect(client.snapshot().lastAcquisitionDurationMs).toBeTypeOf("number");
    } finally {
      held?.release();
      await app.dispose();
    }
  });

  it("preserves native duplicate-release errors for normally returned leases", async () => {
    const { app, client } = fixture();
    try {
      const held = await client.pool.connect();
      held.release();
      expect(() => held.release()).toThrow(/already been released/);
      expect((await client.checkHealth()).state).toBe("healthy");
    } finally { await app.dispose(); }
  });

  it("cancels blocked statements on the server and permits a subsequent query", async () => {
    const { app, client } = fixture();
    try {
      const start = performance.now();
      await expect(client.pool.query("select pg_sleep(5)")).rejects.toMatchObject({ code: "57014" });
      expect(performance.now() - start).toBeLessThan(1_500);
      expect((await client.checkHealth()).state).toBe("healthy");
      expect(client.snapshot().active).toBe(0);
    } finally { await app.dispose(); }
  });

  it("times out lock contention and keeps Drizzle transaction options and savepoints", async () => {
    const { app, client } = fixture({ statement_timeout: 500 });
    const blockerPool = createPostgresTestPool();
    const blocker = await blockerPool.connect();
    try {
      // Advisory transaction locks avoid schema changes and release on rollback.
      await blocker.query("begin");
      const { rows: [row] } = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
      await blocker.query("select pg_advisory_xact_lock($1)", [row!.pid]);
      await expect(client.pool.query("select pg_advisory_xact_lock($1)", [row!.pid]))
        .rejects.toMatchObject({ code: "55P03" });
      await client.database.transaction(async (tx) => {
        const mode = await tx.execute(sql`show transaction_isolation`);
        expect(mode.rows[0]).toMatchObject({ transaction_isolation: "serializable" });
        await tx.transaction(async (nested) => { await nested.execute(sql`select 1`); });
      }, { isolationLevel: "serializable" });
      expect((await client.checkHealth()).state).toBe("healthy");
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await blockerPool.end();
      await app.dispose();
    }
  });

  it("evicts a server-terminated idle transaction even before its owner releases it", async () => {
    const { app, client } = fixture({ idle_in_transaction_session_timeout: 100 });
    const held = await client.pool.connect();
    try {
      // Attach before BEGIN to avoid missing the server's termination event.
      const ended = new Promise<void>((resolve) => held.once("end", resolve));
      await held.query("begin");
      await ended;
      expect(client.snapshot().state).toBe("degraded");
      expect(client.snapshot().active).toBe(0);
      held.release();
      expect((await client.checkHealth()).state).toBe("healthy");
    } finally { held.release(); await app.dispose(); }
  });

  it("applies the total transaction budget through native startup options", async () => {
    const { app, client } = fixture({
      statement_timeout: 1_000, idle_in_transaction_session_timeout: 1_000,
      options: "-c transaction_timeout=100",
    });
    try {
      await expect(client.database.transaction(async (tx) => {
        await tx.execute(sql`select pg_sleep(5)`);
      })).rejects.toThrow();
      // Preserve Drizzle's error semantics, including any rollback failure.
      expect((await client.checkHealth()).state).toBe("healthy");
      expect(client.snapshot().active).toBe(0);
    } finally { await app.dispose(); }
  });

  it("captures actual idle-client loss and establishes recovery with a fresh query", async () => {
    const { app, client } = fixture();
    const admin = createPostgresTestPool();
    try {
      const { rows: [row] } = await client.pool.query<{ pid: number }>("select pg_backend_pid() as pid");
      const lost = once(client.pool, "error");
      await admin.query("select pg_terminate_backend($1)", [row!.pid]);
      await lost;
      expect(client.snapshot().state).toBe("degraded");
      expect((await client.checkHealth()).state).toBe("healthy");
    } finally { await admin.end(); await app.dispose(); }
  });

  it("drains active work when it completes before shutdown", async () => {
    const { app, client } = fixture({ resourcePolicy: { shutdownTimeoutMs: 1_000 } });
    let released = false;
    const held = await client.pool.connect();
    const running = held.query("select pg_sleep(0.03)");
    const closing = client.close();
    try {
      await running;
      held.release();
      released = true;
      await closing;
      expect(client.snapshot()).toMatchObject({ state: "closed", total: 0 });
    } finally { if (!released) held.release(); await app.dispose(); }
  });

  it.each([false, true])("forces eviction at the shutdown deadline and rejects pending and future work (pipeline=%s)", async (pipeline) => {
    const { app, client } = fixture({ statement_timeout: 5_000, pipeline });
    const held = await client.pool.connect();
    const running = held.query("select pg_sleep(4)");
    const failedQuery = expect(running).rejects.toThrow();
    const pending = client.pool.connect();
    const failedAcquire = expect(pending).rejects.toMatchObject({ code: "closing" });
    const start = performance.now();
    try {
      await expect(client.close()).rejects.toMatchObject({ code: "shutdown_timeout" });
      await failedAcquire;
      await failedQuery;
      expect(performance.now() - start).toBeLessThan(1_500);
      expect(client.snapshot()).toMatchObject({ state: "closed", total: 0 });
      held.release();
      await expect(client.pool.query("select 1")).rejects.toMatchObject({ code: "closing" });
    } finally {
      held.release();
      // Application disposal preserves the same observable forced-shutdown failure.
      await expect(app.dispose()).rejects.toThrow();
    }
  });
});
