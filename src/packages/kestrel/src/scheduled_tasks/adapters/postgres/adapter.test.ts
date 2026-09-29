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
