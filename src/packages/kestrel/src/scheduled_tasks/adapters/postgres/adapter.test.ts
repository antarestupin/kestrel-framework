import { drizzle } from "drizzle-orm/node-postgres";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  Pool,
  PoolClient,
} from "pg";

import { createPostgresTestPool } from "../../../testing/postgres.js";
import {
  scheduledTaskRuns,
  scheduledTaskStates,
} from "./schema.js";
import {
  PostgresScheduledTaskAdapter,
  type PostgresScheduledTaskDatabase,
} from "./adapter.js";

// Connection-local tables exercise production SQL independently of migrations.
const testStates = pgTable("scheduled_task_state", {
  taskId: text("task_id").primaryKey(),
  paused: boolean("paused").default(false).notNull(),
  nextScheduledAt: timestamp("next_scheduled_at", {
    mode: "date",
    withTimezone: true,
  }),
  manualRunRequestedAt: timestamp("manual_run_requested_at", {
    mode: "date",
    withTimezone: true,
  }),
  lastStartedAt: timestamp("last_started_at", {
    mode: "date",
    withTimezone: true,
  }),
  lastCompletedAt: timestamp("last_completed_at", {
    mode: "date",
    withTimezone: true,
  }),
  lastOutcome: text("last_outcome").$type<"failure" | "success">(),
  lastError: jsonb("last_error"),
  updatedAt: timestamp("updated_at", {
    mode: "date",
    withTimezone: true,
  }).defaultNow().notNull(),
});

const testRuns = pgTable("scheduled_task_run", {
  reservationToken: uuid("reservation_token").primaryKey(),
  taskId: text("task_id").notNull(),
  scheduledAt: timestamp("scheduled_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  reservedAt: timestamp("reserved_at", {
    mode: "date",
    withTimezone: true,
  }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  trigger: text("trigger").$type<"manual" | "scheduled">().notNull(),
  attempt: integer("attempt").default(1).notNull(),
});

let pool: Pool;
let client: PoolClient;
let adapter: PostgresScheduledTaskAdapter;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();
  await client.query(`
    CREATE TEMPORARY TABLE scheduled_task_state (
      task_id text PRIMARY KEY,
      paused boolean DEFAULT false NOT NULL,
      next_scheduled_at timestamptz,
      manual_run_requested_at timestamptz,
      last_started_at timestamptz,
      last_completed_at timestamptz,
      last_outcome text,
      last_error jsonb,
      updated_at timestamptz DEFAULT now() NOT NULL
    ) ON COMMIT PRESERVE ROWS;

    CREATE TEMPORARY TABLE scheduled_task_run (
      reservation_token uuid PRIMARY KEY,
      task_id text NOT NULL,
      scheduled_at timestamptz NOT NULL,
      reserved_at timestamptz DEFAULT now() NOT NULL,
      expires_at timestamptz NOT NULL,
      trigger text NOT NULL,
      attempt integer DEFAULT 1 NOT NULL
    ) ON COMMIT PRESERVE ROWS;
  `);
  const database = drizzle(client) as PostgresScheduledTaskDatabase;
  adapter = new PostgresScheduledTaskAdapter(
    database,
    testStates as unknown as typeof scheduledTaskStates,
    testRuns as unknown as typeof scheduledTaskRuns,
  );
});

beforeEach(async () => {
  await client.query("TRUNCATE scheduled_task_run, scheduled_task_state");
});

afterAll(async () => {
  client.release();
  await pool.end();
});

describe("PostgresScheduledTaskAdapter", () => {
  it("restores an earlier manual reservation ahead of a newer coalesced request", async () => {
    const token = "00000000-0000-4000-8000-000000000001";
    const earlier = new Date("2030-01-01T00:00:00.000Z");
    const newer = new Date("2031-01-01T00:00:00.000Z");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: newer }]);
    await client.query(`UPDATE scheduled_task_state SET manual_run_requested_at = $1 WHERE task_id = 'first'`, [newer]);
    await client.query(`INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger)
      VALUES ($1, 'first', $2, now() + interval '1 minute', 'manual')`, [token, earlier]);
    expect(await adapter.release({ taskId: "first", reservationToken: token })).toBe(true);
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ activeRuns: 0, manualRunRequestedAt: earlier, nextScheduledAt: newer });
  });

  it("preserves reconciled controls, filters requested states and validates controls", async () => {
    const initial = new Date("2026-01-01T00:00:00.000Z");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: initial }, { taskId: "second", nextScheduledAt: initial }]);
    await adapter.setPaused("first", true);
    await adapter.requestRun("first");
    const before = (await client.query("SELECT * FROM scheduled_task_state WHERE task_id = 'first'")).rows[0];
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: new Date("2030-01-01T00:00:00.000Z") }]);
    expect((await client.query("SELECT * FROM scheduled_task_state WHERE task_id = 'first'")).rows[0]).toEqual(before);
    expect((await adapter.listStates(["missing", "second"])).map((state) => state.taskId)).toEqual(["second"]);
    await expect(adapter.requestRun("missing")).rejects.toThrow(Error);
    await expect(adapter.setPaused("missing", true)).rejects.toThrow(Error);
    expect(await adapter.listStates([])).toEqual([]);
    await adapter.reconcile([]);
  });

  it("requires the exact occurrence and permits a manual request while paused", async () => {
    const initial = new Date("2026-01-01T00:00:00.000Z");
    const request = { taskId: "first", expectedScheduledAt: initial, overlap: "wait" as const, leaseMs: 60_000 };
    expect(await adapter.reserve(request)).toEqual({ status: "stale" });
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: initial }]);
    expect(await adapter.reserve({ ...request, expectedScheduledAt: new Date(initial.getTime() + 1) })).toEqual({ status: "stale" });
    await adapter.setPaused("first", true);
    expect(await adapter.reserve(request)).toEqual({ status: "paused" });
    await adapter.requestRun("first");
    const [state] = await adapter.listStates(["first"]);
    const manual = await adapter.reserve({ ...request, expectedScheduledAt: state!.manualRunRequestedAt! });
    expect(manual).toMatchObject({ status: "reserved", reservation: { trigger: "manual" } });
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ paused: true, nextScheduledAt: initial, activeRuns: 1 });
  });

  it("completes only the current owner and retains the later deferral and error summary", async () => {
    const firstToken = "00000000-0000-4000-8000-000000000001";
    const otherToken = "00000000-0000-4000-8000-000000000002";
    const initial = new Date("2026-01-01T00:00:00.000Z");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: initial }, { taskId: "other", nextScheduledAt: initial }]);
    await client.query(`INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger)
      VALUES ($1, 'first', now(), now() + interval '1 minute', 'scheduled'), ($2, 'other', now(), now() + interval '1 minute', 'scheduled')`, [firstToken, otherToken]);
    const error = { name: "HandlerFailure", message: "completion recorded" };
    const complete = { taskId: "first", reservationToken: firstToken, completedAt: initial, outcome: "failure" as const, error,
      nextScheduledAt: new Date("2030-01-01T00:00:00.000Z"), postponeUntil: new Date("2031-01-01T00:00:00.000Z") };
    expect(await adapter.complete({ ...complete, reservationToken: otherToken })).toBe(false);
    expect(await adapter.complete(complete)).toBe(true);
    expect(await adapter.complete(complete)).toBe(false);
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ activeRuns: 0, lastOutcome: "failure", lastError: error, lastCompletedAt: initial, nextScheduledAt: complete.postponeUntil });
    expect((await adapter.listStates(["other"]))[0]!.activeRuns).toBe(1);
  });

  it("does not advance regular cadence from a manual completion and clears stale failure metadata", async () => {
    const token = "00000000-0000-4000-8000-000000000001";
    const initial = new Date("2030-01-01T00:00:00.000Z");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: initial }]);
    await client.query(`UPDATE scheduled_task_state SET last_error = '{"name":"Prior","message":"prior failure"}'::jsonb WHERE task_id = 'first'`);
    await client.query(`INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger)
      VALUES ($1, 'first', now(), now() + interval '1 minute', 'manual')`, [token]);
    expect(await adapter.complete({ taskId: "first", reservationToken: token, completedAt: initial, outcome: "success", nextScheduledAt: new Date("2031-01-01T00:00:00.000Z") })).toBe(true);
    const [state] = await adapter.listStates(["first"]);
    expect(state).toMatchObject({ lastOutcome: "success", nextScheduledAt: initial });
    expect(state!.lastError).toBeUndefined();
  });

  it("restores released manual and scheduled occurrences without touching another owner", async () => {
    const scheduledToken = "00000000-0000-4000-8000-000000000001";
    const manualToken = "00000000-0000-4000-8000-000000000002";
    const original = new Date("2026-01-01T00:00:00.000Z");
    await adapter.reconcile([{ taskId: "scheduled", nextScheduledAt: new Date("2030-01-01T00:00:00.000Z") }, { taskId: "manual", nextScheduledAt: new Date("2030-01-01T00:00:00.000Z") }]);
    await client.query(`INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger)
      VALUES ($1, 'scheduled', $3, now() + interval '1 minute', 'scheduled'), ($2, 'manual', $3, now() + interval '1 minute', 'manual')`, [scheduledToken, manualToken, original]);
    expect(await adapter.release({ taskId: "manual", reservationToken: scheduledToken })).toBe(false);
    expect(await adapter.release({ taskId: "scheduled", reservationToken: scheduledToken })).toBe(true);
    expect(await adapter.release({ taskId: "manual", reservationToken: manualToken })).toBe(true);
    expect(await adapter.release({ taskId: "manual", reservationToken: manualToken })).toBe(false);
    expect((await adapter.listStates(["scheduled"]))[0]).toMatchObject({ activeRuns: 0, nextScheduledAt: original });
    expect((await adapter.listStates(["manual"]))[0]).toMatchObject({ activeRuns: 0, manualRunRequestedAt: original });
  });

  it("consumes only a matching unpaused occurrence when a run is already active", async () => {
    const token = "00000000-0000-4000-8000-000000000001";
    const initial = new Date("2026-01-01T00:00:00.000Z");
    const next = new Date("2030-01-01T00:00:00.000Z");
    const request = { taskId: "first", expectedScheduledAt: initial, nextScheduledAt: next, overlap: "skip" as const, leaseMs: 60_000 };
    expect(await adapter.skip(request)).toBe(false);
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: initial }]);
    expect(await adapter.skip(request)).toBe(false);
    await client.query(`INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger)
      VALUES ($1, 'first', $2, now() + interval '1 minute', 'scheduled')`, [token, initial]);
    expect(await adapter.skip({ ...request, expectedScheduledAt: next })).toBe(false);
    await adapter.setPaused("first", true);
    expect(await adapter.skip(request)).toBe(false);
    await adapter.setPaused("first", false);
    expect(await adapter.skip(request)).toBe(true);
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ activeRuns: 1, nextScheduledAt: next });
  });

  it("coalesces manual controls and only applies a resume date when unpausing", async () => {
    const initial = new Date("2026-01-01T00:00:00.000Z");
    const resumeAt = new Date("2030-01-01T00:00:00.000Z");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: initial }]);
    await adapter.requestRun("first");
    const first = (await adapter.listStates(["first"]))[0]!.manualRunRequestedAt;
    await adapter.requestRun("first");
    expect((await adapter.listStates(["first"]))[0]!.manualRunRequestedAt).toEqual(first);
    await adapter.setPaused("first", true, resumeAt);
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ paused: true, nextScheduledAt: initial });
    await adapter.setPaused("first", false, resumeAt);
    expect((await adapter.listStates(["first"]))[0]).toMatchObject({ paused: false, nextScheduledAt: resumeAt });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid lease/prune arguments %s", async (value) => {
    await expect(adapter.pruneExpiredRuns({ limit: value })).rejects.toThrow(TypeError);
    await expect(adapter.reserve({ taskId: "missing", expectedScheduledAt: new Date("2026-01-01T00:00:00.000Z"), overlap: "wait", leaseMs: value })).rejects.toThrow(TypeError);
  });

  it("extends only the matching task reservation using PostgreSQL time", async () => {
    const firstToken = "00000000-0000-4000-8000-000000000001";
    const secondToken = "00000000-0000-4000-8000-000000000002";
    const otherToken = "00000000-0000-4000-8000-000000000003";
    // Two runs share one task while a third has another owner: both WHERE predicates matter.
    await client.query(`
      INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger)
      VALUES
        ($1, 'maintenance', now(), now() + interval '1 minute', 'scheduled'),
        ($2, 'maintenance', now(), now() + interval '1 minute', 'manual'),
        ($3, 'other-task', now(), now() + interval '1 minute', 'scheduled')
    `, [firstToken, secondToken, otherToken]);
    const before = await client.query("SELECT * FROM scheduled_task_run ORDER BY reservation_token");
    const leaseMs = 180_000;
    const lowerClock = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    await expect(adapter.extendLease({ taskId: "maintenance", reservationToken: firstToken, leaseMs })).resolves.toBe(true);
    const after = await client.query("SELECT *, statement_timestamp() AS observed_at FROM scheduled_task_run ORDER BY reservation_token");
    const { observed_at: observedAt, ...extended } = after.rows[0]!;
    expect(extended).toEqual({ ...before.rows[0], expires_at: expect.any(Date) });
    expect(extended.expires_at.getTime()).toBeGreaterThan(before.rows[0]!.expires_at.getTime());
    // Bracket the server's clock instead of sleeping or relying on the host clock.
    expect(extended.expires_at.getTime()).toBeGreaterThanOrEqual(lowerClock.getTime() + leaseMs);
    expect(extended.expires_at.getTime()).toBeLessThanOrEqual(observedAt.getTime() + leaseMs);
    expect(after.rows.slice(1).map(({ observed_at: _observedAt, ...run }) => run)).toEqual(before.rows.slice(1));
  });

  it("rejects mismatched or stale leases without altering any run", async () => {
    const currentToken = "00000000-0000-4000-8000-000000000001";
    const staleToken = "00000000-0000-4000-8000-000000000099";
    await client.query(`
      INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger)
      VALUES ($1, 'maintenance', now(), now() + interval '1 minute', 'scheduled')
    `, [currentToken]);
    const before = await client.query("SELECT * FROM scheduled_task_run");
    await expect(adapter.extendLease({ taskId: "other-task", reservationToken: currentToken, leaseMs: 180_000 })).resolves.toBe(false);
    await expect(adapter.extendLease({ taskId: "maintenance", reservationToken: staleToken, leaseMs: 180_000 })).resolves.toBe(false);
    expect((await client.query("SELECT * FROM scheduled_task_run")).rows).toEqual(before.rows);
  });

  it("reconciles, reserves and completes an occurrence", async () => {
    const scheduledAt = new Date("2020-01-01T00:00:00.000Z");
    const nextScheduledAt = new Date("2030-01-01T00:00:00.000Z");
    await adapter.reconcile([{ taskId: "maintenance", nextScheduledAt: scheduledAt }]);

    const result = await adapter.reserve({
      taskId: "maintenance",
      expectedScheduledAt: scheduledAt,
      nextScheduledAt,
      overlap: "wait",
      leaseMs: 60_000,
    });

    expect(result.status).toBe("reserved");
    if (result.status !== "reserved") {
      throw new Error("Expected the task occurrence to be reserved.");
    }
    expect((await adapter.listStates(["maintenance"]))[0]).toMatchObject({
      activeRuns: 1,
      nextScheduledAt,
    });
    await expect(adapter.complete({
      taskId: "maintenance",
      reservationToken: result.reservation.reservationToken,
      completedAt: new Date(),
      outcome: "success",
    })).resolves.toBe(true);
    expect((await adapter.listStates(["maintenance"]))[0]).toMatchObject({
      activeRuns: 0,
      lastOutcome: "success",
    });
  });

  it("restores expired occurrences before exposing state", async () => {
    const scheduledAt = new Date("2020-01-01T00:00:00.000Z");
    await adapter.reconcile([{
      taskId: "recover",
      nextScheduledAt: new Date("2030-01-01T00:00:00.000Z"),
    }]);
    await client.query(
      `INSERT INTO scheduled_task_run (
        reservation_token, task_id, scheduled_at, expires_at, trigger
      ) VALUES ($1, $2, $3, now() - interval '1 second', 'scheduled')`,
      ["00000000-0000-4000-8000-000000000001", "recover", scheduledAt],
    );

    expect((await adapter.listStates(["recover"]))[0]).toMatchObject({
      activeRuns: 0,
      nextScheduledAt: scheduledAt,
    });
  });

  it("globally prunes a bounded batch of expired runs", async () => {
    const scheduledAt = new Date("2020-01-01T00:00:00.000Z");
    await adapter.reconcile([
      { taskId: "first", nextScheduledAt: new Date("2030-01-01T00:00:00.000Z") },
      { taskId: "second", nextScheduledAt: new Date("2030-01-01T00:00:00.000Z") },
    ]);
    await client.query(`
      INSERT INTO scheduled_task_run (
        reservation_token, task_id, scheduled_at, expires_at, trigger
      ) VALUES
        ('00000000-0000-4000-8000-000000000001', 'first', $1, now() - interval '2 seconds', 'scheduled'),
        ('00000000-0000-4000-8000-000000000002', 'second', $1, now() - interval '1 second', 'scheduled')
    `, [scheduledAt]);

    await expect(adapter.pruneExpiredRuns({ limit: 1 })).resolves.toBe(1);
    const result = await client.query(
      "SELECT task_id FROM scheduled_task_run ORDER BY task_id",
    );
    expect(result.rows).toEqual([{ task_id: "second" }]);
    const [first] = await adapter.listStates(["first"]);
    expect(first?.nextScheduledAt).toEqual(scheduledAt);
  });
});

// Use explicit row state to exercise mixed recovery without depending on the wall-clock scheduler.
describe("PostgreSQL scheduled-task recovery and completion policies", () => {
  it("restores the earliest manual and scheduled occurrence independently for every task", async () => {
    const future = new Date("2035-01-01T00:00:00Z");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: future }, { taskId: "second", nextScheduledAt: future }]);
    await client.query(`INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger) VALUES
      ('00000000-0000-4000-8000-000000000001', 'first', '2022-01-01Z', now() - interval '1 second', 'scheduled'),
      ('00000000-0000-4000-8000-000000000002', 'first', '2020-01-01Z', now() - interval '1 second', 'scheduled'),
      ('00000000-0000-4000-8000-000000000003', 'first', '2023-01-01Z', now() - interval '1 second', 'manual'),
      ('00000000-0000-4000-8000-000000000004', 'first', '2021-01-01Z', now() - interval '1 second', 'manual'),
      ('00000000-0000-4000-8000-000000000005', 'second', '2024-01-01Z', now() - interval '1 second', 'manual'),
      ('00000000-0000-4000-8000-000000000006', 'second', '2025-01-01Z', now() + interval '1 minute', 'scheduled')`);
    expect(await adapter.pruneExpiredRuns({})).toBe(5);
    const states = await adapter.listStates(["first", "second"]);
    expect(states.find(({ taskId }) => taskId === "first")).toMatchObject({ nextScheduledAt: new Date("2020-01-01Z"), manualRunRequestedAt: new Date("2021-01-01Z"), activeRuns: 0 });
    expect(states.find(({ taskId }) => taskId === "second")).toMatchObject({ nextScheduledAt: future, manualRunRequestedAt: new Date("2024-01-01Z"), activeRuns: 1 });
  });

  it("recovers only the requested task before reserving and records its start timestamps", async () => {
    const initial = new Date("2020-01-01T00:00:00Z");
    const future = new Date("2035-01-01T00:00:00Z");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: future }, { taskId: "second", nextScheduledAt: future }]);
    await client.query(`INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger) VALUES
      ('00000000-0000-4000-8000-000000000001', 'first', $1, now() - interval '1 second', 'scheduled'),
      ('00000000-0000-4000-8000-000000000002', 'second', $1, now() - interval '1 second', 'manual')`, [initial]);
    const lower = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    const hostLower = Date.now();
    const result = await adapter.reserve({ taskId: "first", expectedScheduledAt: initial, nextScheduledAt: future, overlap: "wait", leaseMs: 60_000 });
    const hostUpper = Date.now();
    expect(result).toMatchObject({ status: "reserved", reservation: { taskId: "first", scheduledAt: initial, trigger: "scheduled" } });
    const upper = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    const [state] = await adapter.listStates(["first"]);
    // State diagnostics use the runtime clock; lease acquisition uses PostgreSQL's clock.
    expect(state!.lastStartedAt!.getTime()).toBeGreaterThanOrEqual(hostLower);
    expect(state!.lastStartedAt!.getTime()).toBeLessThanOrEqual(hostUpper);
    if (result.status !== "reserved") throw new Error("Expected recovered reservation");
    expect(result.reservation.reservedAt.getTime()).toBeGreaterThanOrEqual(lower.getTime());
    expect(result.reservation.reservedAt.getTime()).toBeLessThanOrEqual(upper.getTime());
    // Inspect SQL directly: listing another task here would itself trigger recovery.
    expect((await client.query("SELECT task_id FROM scheduled_task_run WHERE reservation_token = '00000000-0000-4000-8000-000000000002'")).rows).toEqual([{ task_id: "second" }]);
  });

  it.each(["next", "postpone", "next-later"] as const)("applies completion date policy %s without losing loop cadence", async (source) => {
    const initial = new Date("2020-01-01T00:00:00Z");
    const earlier = new Date("2030-01-01T00:00:00Z");
    const later = new Date("2031-01-01T00:00:00Z");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: initial }]);
    const result = await adapter.reserve({ taskId: "first", expectedScheduledAt: initial, overlap: "wait", leaseMs: 60_000 });
    if (result.status !== "reserved") throw new Error("Expected loop reservation");
    expect(await adapter.reserve({ taskId: "first", expectedScheduledAt: initial, overlap: "wait", leaseMs: 60_000 })).toEqual({ status: "stale" });
    expect(await adapter.complete({ ...result.reservation, completedAt: initial, outcome: "success", ...(source === "next" ? { nextScheduledAt: later } : source === "postpone" ? { postponeUntil: later } : { nextScheduledAt: later, postponeUntil: earlier }) })).toBe(true);
    expect((await adapter.listStates(["first"]))[0]!.nextScheduledAt).toEqual(later);
  });

  it("consumes a skipped manual occurrence without changing cadence or the last start timestamp", async () => {
    const regular = new Date("2030-01-01T00:00:00Z");
    const manual = new Date("2020-01-01T00:00:00Z");
    const started = new Date("2022-01-01T00:00:00Z");
    await adapter.reconcile([{ taskId: "first", nextScheduledAt: regular }]);
    await client.query("UPDATE scheduled_task_state SET manual_run_requested_at = $1, last_started_at = $2 WHERE task_id = 'first'", [manual, started]);
    await client.query(`INSERT INTO scheduled_task_run (reservation_token, task_id, scheduled_at, expires_at, trigger)
      VALUES ('00000000-0000-4000-8000-000000000001', 'first', $1, now() + interval '1 minute', 'scheduled')`, [started]);
    expect(await adapter.skip({ taskId: "first", expectedScheduledAt: manual, nextScheduledAt: new Date("2031-01-01T00:00:00Z"), overlap: "skip", leaseMs: 60_000 })).toBe(true);
    const [state] = await adapter.listStates(["first"]);
    expect(state).toMatchObject({ lastStartedAt: started, nextScheduledAt: regular, activeRuns: 1 });
    expect(state!.manualRunRequestedAt).toBeUndefined();
  });
});
