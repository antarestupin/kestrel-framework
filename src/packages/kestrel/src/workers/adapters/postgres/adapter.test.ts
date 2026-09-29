import { sql } from "drizzle-orm";
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
import { createUuid } from "../../../utils/uuid.js";
import { WorkerJobIdentityConflictError } from "../../errors.js";
import {
  workerDeadLetterJobs,
  workerJobs,
  workerQueueControls,
} from "./schema.js";
import {
  PostgresWorkerAdapter,
  type PostgresWorkerDatabase,
} from "./adapter.js";

// Connection-local equivalents keep integration tests independent of the
// application migration state while exercising the production SQL.
function createTestWorkerJobs(name: string) {
  return pgTable(name, {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    identity: text("identity"),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    correlation: jsonb("correlation"),
    groupId: text("group_id"),
    executionId: uuid("execution_id"),
    attempt: integer("attempt").default(0).notNull(),
    availableAt: timestamp("available_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
    reservedAt: timestamp("reserved_at", {
      mode: "date",
      withTimezone: true,
    }),
    reservationToken: uuid("reservation_token"),
    state: text("state").$type<"pending" | "reserved">()
      .default("pending").notNull(),
    lastError: jsonb("last_error"),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  });
}

const testWorkerJobs = createTestWorkerJobs("worker_job");

const testDeadLetterJobs = pgTable("worker_dead_letter_queue", {
  id: uuid("id").default(sql`uuidv7()`).primaryKey(),
  originalJobId: uuid("original_job_id").notNull(),
  identity: text("identity"),
  queue: text("queue").notNull(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  correlation: jsonb("correlation"),
  groupId: text("group_id"),
  executionId: uuid("execution_id"),
  attempt: integer("attempt").notNull(),
  error: jsonb("error").notNull(),
  createdAt: timestamp("created_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  failedAt: timestamp("failed_at", {
    mode: "date",
    withTimezone: true,
  }).defaultNow().notNull(),
});

const testWorkerQueueControls = pgTable("worker_queue_control", {
  queue: text("queue").primaryKey(),
  enabled: boolean("enabled").default(true).notNull(),
  updatedAt: timestamp("updated_at", {
    mode: "date",
    withTimezone: true,
  }).defaultNow().notNull(),
});

let pool: Pool;
let client: PoolClient;
let database: PostgresWorkerDatabase;
let adapter: PostgresWorkerAdapter;

/** Captures actual driver commands, including transaction boundaries. */
function createCountingAdapter(queries: string[]): PostgresWorkerAdapter {
  return new PostgresWorkerAdapter(
    drizzle(client, { logger: { logQuery: (query) => queries.push(query) } }),
    testWorkerJobs as unknown as typeof workerJobs,
    testDeadLetterJobs as unknown as typeof workerDeadLetterJobs,
    testWorkerQueueControls as unknown as typeof workerQueueControls,
  );
}

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();
  await client.query(`
    CREATE TEMPORARY TABLE worker_job (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      identity text UNIQUE,
      queue text NOT NULL,
      payload jsonb NOT NULL,
      correlation jsonb,
      group_id text,
      execution_id uuid,
      attempt integer DEFAULT 0 NOT NULL,
      available_at timestamp with time zone DEFAULT now() NOT NULL,
      reserved_at timestamp with time zone,
      reservation_token uuid,
      state text DEFAULT 'pending' NOT NULL,
      last_error jsonb,
      created_at timestamp with time zone DEFAULT now() NOT NULL
    ) ON COMMIT PRESERVE ROWS;

    CREATE TEMPORARY TABLE worker_dead_letter_queue (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      original_job_id uuid NOT NULL,
      identity text,
      queue text NOT NULL,
      payload jsonb NOT NULL,
      correlation jsonb,
      group_id text,
      execution_id uuid,
      attempt integer NOT NULL,
      error jsonb NOT NULL,
      created_at timestamp with time zone NOT NULL,
      failed_at timestamp with time zone DEFAULT now() NOT NULL
    ) ON COMMIT PRESERVE ROWS;

    CREATE TEMPORARY TABLE worker_queue_control (
      queue text PRIMARY KEY,
      enabled boolean DEFAULT true NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    ) ON COMMIT PRESERVE ROWS
  `);
  database = drizzle(client) as PostgresWorkerDatabase;
  adapter = new PostgresWorkerAdapter(
    database,
    testWorkerJobs as unknown as typeof workerJobs,
    testDeadLetterJobs as unknown as typeof workerDeadLetterJobs,
    testWorkerQueueControls as unknown as typeof workerQueueControls,
  );
});

beforeEach(async () => {
  await client.query(`
    TRUNCATE worker_job;
    TRUNCATE worker_dead_letter_queue;
    TRUNCATE worker_queue_control
  `);
});

afterAll(async () => {
  client.release();
  await pool.end();
});

describe("PostgresWorkerAdapter", () => {
  it.each([
    { size: 100, commands: 1 },
    { size: 1_001, commands: 4 },
  ])("publishes $size ordinary jobs in $commands SQL commands with IDs in input order", async ({ size, commands }) => {
    const queries: string[] = [];
    const counted = createCountingAdapter(queries);
    const ids = await counted.enqueue(Array.from({ length: size }, (_, value) => ({
      queue: "queue",
      payload: { value },
    })));
    expect(queries).toHaveLength(commands);
    const stored = await client.query<{ id: string; payload: { value: number } }>(
      "SELECT id, payload FROM worker_job ORDER BY (payload->>'value')::integer",
    );
    expect(ids).toEqual(stored.rows.map((row) => row.id));
    expect(ids).toHaveLength(size);
  });

  it("batches identity locks, reads, and inserts while preserving mixed request order", async () => {
    const queries: string[] = [];
    const counted = createCountingAdapter(queries);
    const keyed = Array.from({ length: 100 }, (_, value) => ({
      identity: `identity-${value}`,
      queue: "queue",
      payload: value,
    }));
    const ids = await counted.enqueue(keyed);
    expect(queries).toHaveLength(5);
    queries.length = 0;
    const result = await counted.enqueue([
      keyed[3]!,
      { queue: "ordinary", payload: 200 },
      { identity: "new", queue: "queue", payload: 300 },
      keyed[0]!,
      { identity: "new", queue: "queue", payload: 300 },
    ]);
    expect(queries).toHaveLength(5);
    expect(result).toEqual([
      ids[3], expect.any(String), expect.any(String), ids[0], result[2],
    ]);
    const ordinary = await client.query<{ id: string }>(
      "SELECT id FROM worker_job WHERE queue = 'ordinary'",
    );
    expect(result[1]).toBe(ordinary.rows[0]!.id);
    queries.length = 0;
    await expect(counted.enqueue(keyed)).resolves.toEqual(ids);
    expect(queries).toHaveLength(4);
  });

  it.each([false, true])("rejects conflicting identities atomically (previously stored: %s)", async (stored) => {
    const request = { identity: "identity", queue: "queue", payload: 1 };
    if (stored) await adapter.enqueue([request]);
    await expect(adapter.enqueue([
      { queue: "ordinary", payload: 0 },
      request,
      { ...request, payload: 2 },
    ])).rejects.toBeInstanceOf(WorkerJobIdentityConflictError);
    const rows = await client.query("SELECT id FROM worker_job");
    expect(rows.rowCount).toBe(stored ? 1 : 0);
  });

  it("rolls back every insert chunk if a later chunk is invalid", async () => {
    const requests = Array.from({ length: 1_001 }, (_, payload) => ({
      queue: "queue",
      payload,
      ...(payload === 1_000 ? { executionId: "invalid-uuid" } : {}),
    }));
    await expect(adapter.enqueue(requests)).rejects.toThrow();
    const rows = await client.query("SELECT id FROM worker_job");
    expect(rows.rowCount).toBe(0);
  });

  it("deduplicates concurrent publications with opposite identity order", async () => {
    // Separate sessions need a shared relation. Its unique name and cleanup
    // keep this concurrency probe independent of other suites and app tables.
    const name = `worker_enqueue_${createUuid().replaceAll("-", "")}`;
    const table = createTestWorkerJobs(name);
    const secondClient = await pool.connect();
    try {
      await client.query(`CREATE TABLE "${name}" (LIKE worker_job INCLUDING ALL)`);
      const first = new PostgresWorkerAdapter(drizzle(client), table as unknown as typeof workerJobs);
      const second = new PostgresWorkerAdapter(drizzle(secondClient), table as unknown as typeof workerJobs);
      const requests = Array.from({ length: 20 }, (_, payload) => ({
        identity: `${name}:${payload}`,
        queue: "queue",
        payload,
      }));
      const results = await Promise.allSettled([
        first.enqueue(requests),
        second.enqueue(requests.toReversed()),
      ]);
      expect(results[0]!.status).toBe("fulfilled");
      expect(results[1]!.status).toBe("fulfilled");
      if (results[0]!.status === "fulfilled" && results[1]!.status === "fulfilled") {
        expect(results[0]!.value).toEqual(results[1]!.value.toReversed());
      }
      const rows = await client.query(`SELECT id FROM "${name}"`);
      expect(rows.rowCount).toBe(20);
    } finally {
      await client.query(`DROP TABLE IF EXISTS "${name}"`);
      secondClient.release();
    }
  });

  it("deduplicates stable identities transactionally", async () => {
    const request = {
      identity: "workflow/activity/1",
      queue: "queue",
      payload: { value: 1 },
      correlation: { namespace: "workflow.activity", id: "execution/1" },
    } as const;

    const [first] = await adapter.enqueue([request]);
    await expect(adapter.enqueue([request])).resolves.toEqual([first]);
    await expect(adapter.enqueue([{ ...request, payload: { value: 2 } }]))
      .rejects.toBeInstanceOf(WorkerJobIdentityConflictError);
    const stored = await client.query("SELECT id FROM worker_job");
    expect(stored.rowCount).toBe(1);
  });

  it("pauses reservations and reports queue job counts", async () => {
    await adapter.enqueue([
      { queue: "queue", payload: 1 },
      {
        queue: "queue",
        payload: 2,
        availableAt: new Date("2999-01-01T00:00:00.000Z"),
      },
    ]);

    await expect(adapter.listQueueStatistics(["queue", "empty"]))
      .resolves.toEqual([
        {
          queue: "queue",
          enabled: true,
          ready: 1,
          scheduled: 1,
          reserved: 0,
        },
        {
          queue: "empty",
          enabled: true,
          ready: 0,
          scheduled: 0,
          reserved: 0,
        },
      ]);

    // A live lease is reported separately from jobs that are still waiting.
    await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 60_000,
    });
    await adapter.enqueue([{ queue: "queue", payload: 3 }]);

    await adapter.setQueueEnabled("queue", false);

    await expect(adapter.listReadyQueues(["queue"])).resolves.toEqual([]);
    await expect(adapter.listQueueStatistics(["queue"]))
      .resolves.toMatchObject([{
        enabled: false,
        ready: 1,
        scheduled: 1,
        reserved: 1,
      }]);
  });

  it("enqueues multiple jobs in one adapter operation", async () => {
    const executionId = "00000000-0000-4000-8000-000000000001";
    const ids = await adapter.enqueue([
      {
        queue: "queue",
        payload: { value: 1 },
        groupId: "group",
        executionId,
      },
      { queue: "queue", payload: { value: 2 }, groupId: "group" },
    ]);
    const stored = await client.query<{
      execution_id: string | null;
      group_id: string;
      payload: { value: number };
    }>(`
      SELECT execution_id, group_id, payload
      FROM worker_job
      ORDER BY payload->>'value'
    `);

    expect(ids).toHaveLength(2);
    expect(stored.rows).toEqual([
      { execution_id: executionId, group_id: "group", payload: { value: 1 } },
      { execution_id: null, group_id: "group", payload: { value: 2 } },
    ]);

    const jobs = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 2, allowOverflow: true }],
      totalLimit: 2,
      leaseMs: 60_000,
    });
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: { value: 1 },
        executionId,
      }),
    ]));
  });

  it("reserves allocations then fills remaining capacity in queue order", async () => {
    for (let index = 0; index < 4; index += 1) {
      await adapter.enqueue([{ queue: "first", payload: index }]);
      await adapter.enqueue([{ queue: "second", payload: index }]);
    }

    const jobs = await adapter.reserve({
      queues: [
        { queue: "first", reservationLimit: 1, allowOverflow: true },
        { queue: "second", reservationLimit: 2, allowOverflow: false },
      ],
      totalLimit: 5,
      leaseMs: 60_000,
    });

    // UPDATE RETURNING does not guarantee row order; allocation is asserted by
    // queue counts while the scheduler retains its own queue priority order.
    expect(jobs.filter((job) => job.queue === "first")).toHaveLength(3);
    expect(jobs.filter((job) => job.queue === "second")).toHaveLength(2);
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attempt: 1,
        reservationToken: expect.any(String),
      }),
    ]));
  });

  it("lets only the current reservation token mutate a job", async () => {
    await adapter.enqueue([{ queue: "queue", payload: "payload" }]);
    const [first] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 60_000,
    });
    await client.query(`
      UPDATE worker_job
      SET available_at = statement_timestamp() - interval '1 second'
    `);
    const [second] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 60_000,
    });

    await expect(adapter.ack([{
      jobId: first!.id,
      reservationToken: first!.reservationToken,
    }])).resolves.toEqual([]);
    await expect(adapter.ack([{
      jobId: second!.id,
      reservationToken: second!.reservationToken,
    }])).resolves.toHaveLength(1);
  });

  it("moves a failed reservation to the DLQ atomically", async () => {
    const executionId = "00000000-0000-4000-8000-000000000001";
    await adapter.enqueue([{
      queue: "queue",
      payload: { value: 1 },
      executionId,
    }]);
    const [job] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 60_000,
    });

    await expect(adapter.deadLetter([{
      jobId: job!.id,
      reservationToken: job!.reservationToken,
      error: { name: "Error", message: "failed" },
    }])).resolves.toHaveLength(1);

    const active = await client.query("SELECT * FROM worker_job");
    const failed = await client.query<{
      execution_id: string | null;
      original_job_id: string;
      error: { message: string };
    }>(`
      SELECT execution_id, original_job_id, error
      FROM worker_dead_letter_queue
    `);
    expect(active.rows).toHaveLength(0);
    expect(failed.rows).toEqual([{
      execution_id: executionId,
      original_job_id: job!.id,
      error: { name: "Error", message: "failed" },
    }]);
  });

  it("defers an unstarted reservation without consuming an attempt", async () => {
    await adapter.enqueue([{ queue: "queue", payload: "payload" }]);
    const [job] = await adapter.reserve({
      queues: [{ queue: "queue", reservationLimit: 1, allowOverflow: true }],
      totalLimit: 1,
      leaseMs: 60_000,
    });
    const availableAt = new Date("2030-01-01T00:00:00.000Z");

    // A stale scheduler must not defer a reservation owned by another process.
    await expect(adapter.defer([{
      jobId: job!.id,
      reservationToken: "00000000-0000-4000-8000-000000000000",
      availableAt,
    }])).resolves.toEqual([]);
    await expect(adapter.defer([{
      jobId: job!.id,
      reservationToken: job!.reservationToken,
      availableAt,
    }])).resolves.toHaveLength(1);
    const stored = await client.query<{
      attempt: number;
      available_at: Date;
      reservation_token: string | null;
      state: string;
    }>(`
      SELECT attempt, available_at, reservation_token, state
      FROM worker_job
    `);
    expect(stored.rows).toMatchObject([{
      attempt: 0,
      available_at: availableAt,
      reservation_token: null,
      state: "pending",
    }]);
  });
});
