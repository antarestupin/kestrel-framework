import { sql } from "drizzle-orm";
import { z } from "zod";
import { workflowExecutionCursorCodec } from "../../execution_cursor.js";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  boolean,
  integer,
  jsonb,
  pgSchema,
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
  vi,
} from "vitest";
import type {
  Pool,
  PoolClient,
} from "pg";

import { createPostgresTestPool } from "../../../testing/postgres.js";
import {
  WorkflowConcurrencyConflictError,
  WorkflowJournalConflictError,
} from "../../errors.js";
import type { WorkflowExecutionError } from "../../errors.js";
import type { WorkflowPayload } from "../../serialization.js";
import {
  PostgresWorkflowAdapter,
  type PostgresWorkflowDatabase,
} from "./adapter.js";
import {
  workflowExecutions,
  workflowDispatchOutbox,
  workflowHistoryEvents,
  workflowHistoryArchives,
  workflowSignals,
  workflowTasks,
} from "./schema.js";

const testExecutions = pgTable("workflow_execution", {
  id: text("id").primaryKey(),
  workflowName: text("workflow_name").notNull(),
  workflowVersion: integer("workflow_version").notNull(),
  historyGeneration: integer("history_generation").default(1).notNull(),
  input: jsonb("input").$type<WorkflowPayload>(),
  initialInput: jsonb("initial_input").$type<{ value: WorkflowPayload }>(),
  status: text("status").$type<typeof workflowExecutions.$inferSelect.status>()
    .notNull(),
  output: jsonb("output").$type<WorkflowPayload>(),
  outputPresent: boolean("output_present").default(false).notNull(),
  error: jsonb("error").$type<WorkflowExecutionError>(),
  cancellationRequested: boolean("cancellation_requested")
    .default(false).notNull(),
  pausedAt: timestamp("paused_at", { mode: "date", withTimezone: true }),
  parentExecutionId: text("parent_execution_id"),
  parentCommandSequence: integer("parent_command_sequence"),
  rootExecutionId: text("root_execution_id").notNull(),
  retryOfExecutionId: text("retry_of_execution_id"),
  definitionConcurrencyLimit: integer("definition_concurrency_limit"),
  concurrencyKey: text("concurrency_key"),
  concurrencyKeyLimit: integer("concurrency_key_limit"),
  concurrencyConflict: text("concurrency_conflict").$type<
    "enqueue" | "reject" | "return-existing"
  >(),
  concurrencyScope: text("concurrency_scope").$type<
    "active-work" | "execution"
  >(),
  concurrencyAdmitted: boolean("concurrency_admitted").default(true).notNull(),
  revision: integer("revision").default(0).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
});

// Schema-qualified fixtures cover PostgreSQL syntax that temporary tables
// cannot exercise, while remaining isolated in the Kestrel test database.
const qualifiedFixtureSchema = pgSchema("workflow_adapter_qualified_test");
const qualifiedExecutions = qualifiedFixtureSchema.table("execution", {
  id: text("id").primaryKey(),
  workflowName: text("workflow_name").notNull(),
  workflowVersion: integer("workflow_version").notNull(),
  historyGeneration: integer("history_generation").default(1).notNull(),
  input: jsonb("input").$type<WorkflowPayload>(),
  initialInput: jsonb("initial_input").$type<{ value: WorkflowPayload }>(),
  status: text("status").$type<typeof workflowExecutions.$inferSelect.status>()
    .notNull(),
  output: jsonb("output").$type<WorkflowPayload>(),
  outputPresent: boolean("output_present").default(false).notNull(),
  error: jsonb("error").$type<WorkflowExecutionError>(),
  cancellationRequested: boolean("cancellation_requested")
    .default(false).notNull(),
  pausedAt: timestamp("paused_at", { mode: "date", withTimezone: true }),
  parentExecutionId: text("parent_execution_id"),
  parentCommandSequence: integer("parent_command_sequence"),
  rootExecutionId: text("root_execution_id").notNull(),
  retryOfExecutionId: text("retry_of_execution_id"),
  definitionConcurrencyLimit: integer("definition_concurrency_limit"),
  concurrencyKey: text("concurrency_key"),
  concurrencyKeyLimit: integer("concurrency_key_limit"),
  concurrencyConflict: text("concurrency_conflict").$type<
    "enqueue" | "reject" | "return-existing"
  >(),
  concurrencyScope: text("concurrency_scope").$type<
    "active-work" | "execution"
  >(),
  concurrencyAdmitted: boolean("concurrency_admitted").default(true).notNull(),
  revision: integer("revision").default(0).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
});
const qualifiedHistory = qualifiedFixtureSchema.table("history_event", {
  executionId: text("execution_id").notNull(),
  eventIndex: integer("event_index").notNull(),
  type: text("type").notNull(),
});
const qualifiedTasks = qualifiedFixtureSchema.table("task", {
  id: uuid("id").primaryKey(),
  executionId: text("execution_id").notNull(),
  kind: text("kind").notNull(),
  reservationToken: uuid("reservation_token"),
});

const testHistory = pgTable("workflow_history_event", {
  executionId: text("execution_id").notNull(),
  eventIndex: integer("event_index").notNull(),
  type: text("type").$type<typeof workflowHistoryEvents.$inferSelect.type>()
    .notNull(),
  commandSequence: integer("command_sequence"),
  completionOrder: integer("completion_order"),
  commandKind: text("command_kind"),
  target: text("target"),
  signalId: uuid("signal_id"),
  signalName: text("signal_name"),
  payload: jsonb("payload").$type<WorkflowPayload>(),
  payloadPresent: boolean("payload_present").default(false).notNull(),
  error: jsonb("error").$type<WorkflowExecutionError>(),
  sourceId: text("source_id"),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
});

const testHistoryArchives = pgTable("workflow_history_archive", {
  executionId: text("execution_id").notNull(),
  historyGeneration: integer("history_generation").notNull(),
  workflowVersion: integer("workflow_version").notNull(),
  input: jsonb("input").$type<WorkflowPayload>(),
  history: jsonb("history").$type<unknown>().notNull(),
  continuedAt: timestamp("continued_at", {
    mode: "date",
    withTimezone: true,
  }).defaultNow().notNull(),
});

const testTasks = pgTable("workflow_task", {
  id: uuid("id").default(sql`uuidv7()`).primaryKey(),
  executionId: text("execution_id").notNull(),
  kind: text("kind").$type<"activity" | "timer" | "workflow">().notNull(),
  commandSequence: integer("command_sequence"),
  target: text("target"),
  payload: jsonb("payload").$type<WorkflowPayload>(),
  attempt: integer("attempt").default(0).notNull(),
  availableAt: timestamp("available_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  reservedAt: timestamp("reserved_at", { mode: "date", withTimezone: true }),
  reservationToken: uuid("reservation_token"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
});

const testSignals = pgTable("workflow_signal", {
  id: uuid("id").default(sql`uuidv7()`).primaryKey(),
  executionId: text("execution_id").notNull(),
  name: text("name").notNull(),
  payload: jsonb("payload").$type<WorkflowPayload>(),
  idempotencyKey: text("idempotency_key"),
  receivedAt: timestamp("received_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
});

const testDispatchOutbox = pgTable("workflow_dispatch_outbox", {
  id: uuid("id").default(sql`uuidv7()`).primaryKey(),
  executionId: text("execution_id").notNull(),
  commandSequence: integer("command_sequence").notNull(),
  target: text("target").notNull(),
  transport: text("transport").notNull(),
  payload: jsonb("payload").$type<WorkflowPayload>(),
  availableAt: timestamp("available_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
  reservedAt: timestamp("reserved_at", { mode: "date", withTimezone: true }),
  reservationToken: uuid("reservation_token"),
  attempt: integer("attempt").default(0).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
});

let pool: Pool;
let client: PoolClient;
let database: PostgresWorkflowDatabase;
let adapter: PostgresWorkflowAdapter;
let outboxAdapter: PostgresWorkflowAdapter;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();
  await client.query(`
    DROP SCHEMA IF EXISTS workflow_adapter_qualified_test CASCADE;
    CREATE SCHEMA workflow_adapter_qualified_test;
    CREATE TABLE workflow_adapter_qualified_test.execution (
      id text PRIMARY KEY,
      workflow_name text NOT NULL,
      workflow_version integer NOT NULL,
      history_generation integer DEFAULT 1 NOT NULL,
      input jsonb,
      initial_input jsonb,
      status text NOT NULL,
      output jsonb,
      output_present boolean DEFAULT false NOT NULL,
      error jsonb,
      cancellation_requested boolean DEFAULT false NOT NULL,
      paused_at timestamptz,
      parent_execution_id text,
      parent_command_sequence integer,
      root_execution_id text NOT NULL,
      retry_of_execution_id text,
      definition_concurrency_limit integer,
      concurrency_key text,
      concurrency_key_limit integer,
      concurrency_conflict text,
      concurrency_scope text,
      concurrency_admitted boolean DEFAULT true NOT NULL,
      revision integer DEFAULT 0 NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      completed_at timestamptz
    );
    CREATE TABLE workflow_adapter_qualified_test.history_event (
      execution_id text NOT NULL,
      event_index integer NOT NULL,
      type text NOT NULL
    );
    CREATE TABLE workflow_adapter_qualified_test.task (
      id uuid PRIMARY KEY,
      execution_id text NOT NULL,
      kind text NOT NULL,
      reservation_token uuid
    );

    CREATE TEMPORARY TABLE workflow_execution (
      id text PRIMARY KEY,
      workflow_name text NOT NULL,
      workflow_version integer NOT NULL,
      history_generation integer DEFAULT 1 NOT NULL,
      input jsonb,
      initial_input jsonb,
      status text NOT NULL,
      output jsonb,
      output_present boolean DEFAULT false NOT NULL,
      error jsonb,
      cancellation_requested boolean DEFAULT false NOT NULL,
      paused_at timestamptz,
      parent_execution_id text,
      parent_command_sequence integer,
      root_execution_id text NOT NULL,
      retry_of_execution_id text,
      definition_concurrency_limit integer,
      concurrency_key text,
      concurrency_key_limit integer,
      concurrency_conflict text,
      concurrency_scope text,
      concurrency_admitted boolean DEFAULT true NOT NULL,
      revision integer DEFAULT 0 NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      completed_at timestamptz
    ) ON COMMIT PRESERVE ROWS;

    CREATE TEMPORARY TABLE workflow_history_event (
      execution_id text NOT NULL,
      event_index integer NOT NULL,
      type text NOT NULL,
      command_sequence integer,
      completion_order integer,
      command_kind text,
      target text,
      signal_id uuid,
      signal_name text,
      payload jsonb,
      payload_present boolean DEFAULT false NOT NULL,
      error jsonb,
      source_id text,
      occurred_at timestamptz DEFAULT now() NOT NULL,
      PRIMARY KEY (execution_id, event_index)
    ) ON COMMIT PRESERVE ROWS;

    CREATE TEMPORARY TABLE workflow_history_archive (
      execution_id text NOT NULL,
      history_generation integer NOT NULL,
      workflow_version integer NOT NULL,
      input jsonb,
      history jsonb NOT NULL,
      continued_at timestamptz DEFAULT now() NOT NULL,
      PRIMARY KEY (execution_id, history_generation)
    ) ON COMMIT PRESERVE ROWS;

    CREATE TEMPORARY TABLE workflow_task (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      execution_id text NOT NULL,
      kind text NOT NULL,
      command_sequence integer,
      target text,
      payload jsonb,
      attempt integer DEFAULT 0 NOT NULL,
      available_at timestamptz DEFAULT now() NOT NULL,
      reserved_at timestamptz,
      reservation_token uuid,
      created_at timestamptz DEFAULT now() NOT NULL
    ) ON COMMIT PRESERVE ROWS;
    CREATE UNIQUE INDEX workflow_task_wakeup_idx
      ON workflow_task (execution_id)
      WHERE kind = 'workflow';

    CREATE TEMPORARY TABLE workflow_signal (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      execution_id text NOT NULL,
      name text NOT NULL,
      payload jsonb,
      idempotency_key text,
      received_at timestamptz DEFAULT now() NOT NULL,
      consumed_at timestamptz,
      UNIQUE NULLS NOT DISTINCT (execution_id, idempotency_key)
    ) ON COMMIT PRESERVE ROWS;

    CREATE TEMPORARY TABLE workflow_dispatch_outbox (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      execution_id text NOT NULL,
      command_sequence integer NOT NULL,
      target text NOT NULL,
      transport text NOT NULL,
      payload jsonb,
      available_at timestamptz DEFAULT now() NOT NULL,
      published_at timestamptz,
      reserved_at timestamptz,
      reservation_token uuid,
      attempt integer DEFAULT 0 NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      UNIQUE (execution_id, command_sequence, transport)
    ) ON COMMIT PRESERVE ROWS
  `);
  database = drizzle(client) as PostgresWorkflowDatabase;
  adapter = new PostgresWorkflowAdapter(
    database,
    { terminalPollIntervalMs: 1 },
    testExecutions as unknown as typeof workflowExecutions,
    testHistory as unknown as typeof workflowHistoryEvents,
    testTasks as unknown as typeof workflowTasks,
    testSignals as unknown as typeof workflowSignals,
    testDispatchOutbox as unknown as typeof workflowDispatchOutbox,
    testHistoryArchives as unknown as typeof workflowHistoryArchives,
  );
  outboxAdapter = new PostgresWorkflowAdapter(
    database,
    { terminalPollIntervalMs: 1, activityDispatchMode: "outbox" },
    testExecutions as unknown as typeof workflowExecutions,
    testHistory as unknown as typeof workflowHistoryEvents,
    testTasks as unknown as typeof workflowTasks,
    testSignals as unknown as typeof workflowSignals,
    testDispatchOutbox as unknown as typeof workflowDispatchOutbox,
    testHistoryArchives as unknown as typeof workflowHistoryArchives,
  );
});

beforeEach(async () => {
  await client.query(`
    TRUNCATE workflow_history_event;
    TRUNCATE workflow_history_archive;
    TRUNCATE workflow_task;
    TRUNCATE workflow_signal;
    TRUNCATE workflow_dispatch_outbox;
    TRUNCATE workflow_execution
  `);
});

afterAll(async () => {
  await client.query("DROP SCHEMA workflow_adapter_qualified_test CASCADE");
  client.release();
  await pool.end();
});

describe("PostgresWorkflowAdapter", () => {
  it("loads activations with schema-qualified production tables", async () => {
    const schemaAdapter = new PostgresWorkflowAdapter(
      database,
      {},
      qualifiedExecutions as unknown as typeof workflowExecutions,
      qualifiedHistory as unknown as typeof workflowHistoryEvents,
      qualifiedTasks as unknown as typeof workflowTasks,
      testSignals as unknown as typeof workflowSignals,
      testDispatchOutbox as unknown as typeof workflowDispatchOutbox,
      testHistoryArchives as unknown as typeof workflowHistoryArchives,
    );

    await expect(schemaAdapter.loadActivations([{
      taskId: "00000000-0000-0000-0000-000000000000",
      reservationToken: "00000000-0000-0000-0000-000000000000",
    }])).resolves.toEqual([]);
  });

  it("locks schema-qualified activation relations through aliases", async () => {
    const schemaAdapter = new PostgresWorkflowAdapter(
      database,
      {},
      qualifiedExecutions as unknown as typeof workflowExecutions,
      qualifiedHistory as unknown as typeof workflowHistoryEvents,
      qualifiedTasks as unknown as typeof workflowTasks,
      testSignals as unknown as typeof workflowSignals,
      testDispatchOutbox as unknown as typeof workflowDispatchOutbox,
      testHistoryArchives as unknown as typeof workflowHistoryArchives,
    );

    await expect(schemaAdapter.commitActivation({
      taskId: "00000000-0000-0000-0000-000000000000",
      reservationToken: "00000000-0000-0000-0000-000000000000",
      executionId: "missing-qualified-execution",
      expectedRevision: 0,
      commands: [],
      outcome: { status: "waiting" },
    })).resolves.toBe(false);
  });

  it("starts ten workflow executions in four SQL statements", async () => {
    const requests = Array.from(
      { length: 10 },
      (_, index) => startRequest(`execution-start-batch-${index}`),
    );
    const started = await countClientQueries(() => adapter.startMany(requests));

    expect(started.count).toBe(4);
    expect(started.result).toHaveLength(10);
    expect(started.result.every(({ created }) => created)).toBe(true);
    expect(started.result.map(({ execution }) => execution.executionId))
      .toEqual(requests.map(({ executionId }) => executionId));
    await expect(adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 10,
      leaseMs: 60_000,
    })).resolves.toHaveLength(10);
  });

  it("applies keyed return-existing in request order within one start batch", async () => {
    const concurrency = {
      keyed: {
        key: "user-start-batch",
        limit: 1,
        conflict: "return-existing" as const,
        scope: "execution" as const,
      },
    };

    await expect(adapter.startMany([
      { ...startRequest("batch-keyed-first"), concurrency },
      { ...startRequest("batch-keyed-second"), concurrency },
    ])).resolves.toMatchObject([
      { created: true, execution: { executionId: "batch-keyed-first" } },
      { created: false, execution: { executionId: "batch-keyed-first" } },
    ]);
    await expect(adapter.get("batch-keyed-second")).resolves.toBeUndefined();
  });

  it("returns repeated compatible execution IDs without creating duplicate work", async () => {
    const request = startRequest("batch-duplicate");

    await expect(adapter.startMany([
      request,
      { ...request, workflowVersion: 2 },
    ])).resolves.toMatchObject([
      { created: true, execution: { workflowVersion: 1 } },
      { created: false, execution: { workflowVersion: 1 } },
    ]);
    await expect(adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 10,
      leaseMs: 60_000,
    })).resolves.toHaveLength(1);
  });

  it("enqueues keyed overflow within one start batch", async () => {
    const concurrency = {
      keyed: {
        key: "user-enqueued-batch",
        limit: 1,
        conflict: "enqueue" as const,
        scope: "execution" as const,
      },
    };

    await expect(adapter.startMany([
      { ...startRequest("batch-admitted"), concurrency },
      { ...startRequest("batch-pending"), concurrency },
    ])).resolves.toMatchObject([
      {
        created: true,
        execution: { executionId: "batch-admitted", status: "queued" },
      },
      {
        created: true,
        execution: { executionId: "batch-pending", status: "pending" },
      },
    ]);
  });

  it("rolls back every start when one batch request is rejected", async () => {
    const concurrency = {
      keyed: {
        key: "user-rejected-batch",
        limit: 1,
        conflict: "reject" as const,
        scope: "execution" as const,
      },
    };

    await expect(adapter.startMany([
      { ...startRequest("batch-rejected-first"), concurrency },
      { ...startRequest("batch-rejected-second"), concurrency },
    ])).rejects.toBeInstanceOf(WorkflowConcurrencyConflictError);
    await expect(adapter.get("batch-rejected-first")).resolves.toBeUndefined();
    await expect(adapter.get("batch-rejected-second")).resolves.toBeUndefined();
  });

  it("acquires overlapping batch start keys without order-dependent deadlocks", async () => {
    const keyed = (key: string) => ({
      keyed: {
        key,
        limit: 1,
        conflict: "return-existing" as const,
        scope: "execution" as const,
      },
    });

    const [first, second] = await Promise.all([
      adapter.startMany([
        { ...startRequest("ordered-a"), concurrency: keyed("a") },
        { ...startRequest("ordered-b"), concurrency: keyed("b") },
      ]),
      adapter.startMany([
        { ...startRequest("reversed-b"), concurrency: keyed("b") },
        { ...startRequest("reversed-a"), concurrency: keyed("a") },
      ]),
    ]);

    expect(new Set([...first, ...second]
      .map(({ execution }) => execution.executionId)).size).toBe(2);
  });

  it("leases, publishes, and idempotently completes outbox activities", async () => {
    const request = startRequest("execution-outbox");
    await outboxAdapter.start(request);
    const [activation] = await outboxAdapter.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 1_000,
    });
    await outboxAdapter.commitActivation({
      ...toRef(activation!),
      executionId: request.executionId,
      expectedRevision: 0,
      commands: [{
        sequence: 0,
        kind: "activity",
        target: "example.outbox",
        payload: null,
      }],
      outcome: { status: "waiting" },
    });

    const [dispatch] = await outboxAdapter.reserveActivityDispatches({
      limit: 1,
      leaseMs: 1_000,
    });
    expect(dispatch).toMatchObject({
      executionId: request.executionId,
      sequence: 0,
      target: "example.outbox",
      payload: null,
    });
    await expect(outboxAdapter.markActivityDispatchesPublished([{
      dispatchId: dispatch!.id,
      reservationToken: dispatch!.reservationToken,
    }])).resolves.toHaveLength(1);
    const completion = {
      executionId: request.executionId,
      sequence: 0,
      sourceId: "external-message-id",
      status: "completed" as const,
      result: { ok: true },
    };
    await expect(outboxAdapter.completeExternalActivity(completion))
      .resolves.toBe(true);
    await expect(outboxAdapter.completeExternalActivity(completion))
      .resolves.toBe(true);
    expect((await outboxAdapter.getHistory(request.executionId)).filter(
      (event) => event.type === "command-completed",
    )).toMatchObject([{
      sequence: 0,
      sourceId: "external-message-id",
      result: { ok: true },
    }]);
  });

  it("starts idempotently and appends deduplicated signals", async () => {
    const request = startRequest("execution-start");

    await expect(adapter.start(request)).resolves.toMatchObject({ created: true });
    await expect(adapter.start({ ...request, workflowVersion: 2 }))
      .resolves.toMatchObject({
        created: false,
        execution: { workflowVersion: 1 },
      });
    const signal = {
      executionId: request.executionId,
      workflowName: request.workflowName,
      signalName: "example.approval",
      payload: { approved: true },
      idempotencyKey: "approval-1",
    };

    await expect(adapter.sendSignal(signal)).resolves.toMatchObject({
      accepted: true,
    });
    await expect(adapter.sendSignal(signal)).resolves.toMatchObject({
      accepted: false,
    });
    await expect(adapter.getHistory(request.executionId)).resolves.toMatchObject([
      { type: "signal-received", name: "example.approval" },
    ]);
  });

  it("atomically rotates history generations for continue-as-new", async () => {
    const request = { ...startRequest("execution-continue"), input: null };
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);

    await expect(adapter.continueAsNew({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot!.revision,
      workflowVersion: 2,
      input: { next: true },
    })).resolves.toBe(true);
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({
      workflowVersion: 2,
      historyGeneration: 2,
      input: { next: true },
      revision: 0,
      status: "queued",
    });
    await expect(adapter.getHistoryArchives(request.executionId))
      .resolves.toMatchObject([{
        historyGeneration: 1,
        workflowVersion: 1,
        input: null,
        history: [],
      }]);
    await expect(reserveOne("workflow")).resolves.toBeDefined();
    await expect(adapter.start(request)).resolves.toMatchObject({
      created: false,
      execution: { historyGeneration: 2, input: { next: true } },
    });
  });

  it("summarizes versions and narrowly recovers version-blocked executions", async () => {
    const request = startRequest("execution-version-ops");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);
    await adapter.commitActivation({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot!.revision,
      commands: [],
      outcome: {
        status: "blocked",
        error: {
          name: "WorkflowExecutionVersionUnsupportedError",
          message: "Version one is unavailable.",
        },
      },
    });

    await expect(adapter.summarizeExecutionVersions()).resolves.toEqual([{
      workflowName: request.workflowName,
      workflowVersion: 1,
      status: "blocked",
      count: 1,
    }]);
    await expect(adapter.recoverVersionBlockedExecution({
      executionId: request.executionId,
      workflowName: request.workflowName,
      workflowVersion: 1,
    })).resolves.toBe(true);
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({
      status: "queued",
    });
    await expect(reserveOne("workflow")).resolves.toBeDefined();
  });

  it("commits activation decisions and atomically wakes completed activities", async () => {
    const request = startRequest("execution-replay");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);

    await expect(adapter.commitActivation({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot!.revision,
      commands: [{
        sequence: 0,
        kind: "activity",
        target: "example.read",
        payload: null,
      }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const activity = await reserveOne("activity");
    await expect(adapter.completeActivities([{
      ...toRef(activity),
      executionId: request.executionId,
      sequence: 0,
      status: "completed",
      result: null,
    }])).resolves.toEqual([toRef(activity)]);

    await expect(adapter.getHistory(request.executionId)).resolves.toMatchObject([
      { type: "command-scheduled", payload: null },
      { type: "command-completed", result: null },
    ]);
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({
      revision: 2,
      status: "queued",
    });
    await expect(reserveOne("workflow")).resolves.toBeDefined();
  });

  it("keeps common durable transitions within their query budgets", async () => {
    const request = startRequest("execution-query-budget");
    await adapter.start({
      ...request,
      concurrency: {
        keyed: {
          key: "user-query-budget",
          limit: 1,
          conflict: "return-existing",
          scope: "execution",
        },
      },
    });
    const reservedActivation = await countClientQueries(() =>
      adapter.reserveTasks({
        kinds: ["workflow"],
        limit: 1,
        leaseMs: 60_000,
      }));
    const [activation] = reservedActivation.result;

    expect(reservedActivation.count).toBe(1);
    expect(activation).toMatchObject({
      workflowName: request.workflowName,
      workflowVersion: request.workflowVersion,
      historyGeneration: 1,
      rootExecutionId: request.executionId,
      kind: "workflow",
    });

    const loaded = await countClientQueries(() => loadOne(activation!));

    expect(loaded.count).toBe(1);
    const activationCommit = await countClientQueries(() =>
      adapter.commitActivation({
        ...toRef(activation!),
        executionId: request.executionId,
        expectedRevision: loaded.result!.revision,
        commands: [{
          sequence: 0,
          kind: "activity",
          target: "example.query-budget",
          payload: null,
        }],
        outcome: { status: "waiting" },
      }));

    expect(activationCommit).toEqual({ count: 1, result: true });
    const activity = await reserveOne("activity");
    expect(activity).toMatchObject({
      workflowName: request.workflowName,
      workflowVersion: request.workflowVersion,
      historyGeneration: 1,
      rootExecutionId: request.executionId,
      kind: "activity",
    });
    const activityCompletion = await countClientQueries(() =>
      adapter.completeActivities([{
        ...toRef(activity),
        executionId: request.executionId,
        sequence: 0,
        status: "completed",
        result: null,
      }]));

    expect(activityCompletion).toEqual({
      count: 1,
      result: [toRef(activity)],
    });

    const finalActivation = await reserveOne("workflow");
    const finalSnapshot = await countClientQueries(() =>
      loadOne(finalActivation));
    const terminalCommit = await countClientQueries(() =>
      adapter.commitActivation({
        ...toRef(finalActivation),
        executionId: request.executionId,
        expectedRevision: finalSnapshot.result!.revision,
        commands: [],
        outcome: { status: "completed", output: { ok: true } },
      }));

    expect(finalSnapshot.count).toBe(1);
    expect(terminalCommit).toEqual({ count: 1, result: true });
  });

  it("loads a batch of activation snapshots in one query", async () => {
    const requests = [
      startRequest("execution-batch-load-1"),
      startRequest("execution-batch-load-2"),
    ];
    await Promise.all(requests.map((request) => adapter.start(request)));
    const tasks = await adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 2,
      leaseMs: 60_000,
    });
    const loaded = await countClientQueries(() => adapter.loadActivations([
      ...tasks.map(toRef),
      {
        taskId: "00000000-0000-0000-0000-000000000000",
        reservationToken: "00000000-0000-0000-0000-000000000000",
      },
    ]));

    expect(loaded.count).toBe(1);
    expect(loaded.result.map(({ taskId }) => taskId).sort())
      .toEqual(tasks.map(({ id }) => id).sort());
    expect(loaded.result.map(({ snapshot }) => snapshot.executionId).sort())
      .toEqual(requests.map(({ executionId }) => executionId).sort());
  });

  it("projects execution diagnostics on timer reservations", async () => {
    const request = startRequest("execution-timer-diagnostics");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);
    await adapter.commitActivation({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot!.revision,
      commands: [{
        sequence: 0,
        kind: "timer",
        target: "sleep",
        payload: { durationMs: 0 },
      }],
      outcome: { status: "waiting" },
    });

    await expect(reserveOne("timer")).resolves.toMatchObject({
      workflowName: request.workflowName,
      workflowVersion: request.workflowVersion,
      historyGeneration: 1,
      rootExecutionId: request.executionId,
      kind: "timer",
    });
  });

  it("orders batched activity completions on one execution", async () => {
    const request = startRequest("execution-concurrent-completions");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);
    await adapter.commitActivation({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot!.revision,
      commands: [
        { sequence: 0, kind: "activity", target: "first", payload: null },
        { sequence: 1, kind: "activity", target: "second", payload: null },
      ],
      outcome: { status: "waiting" },
    });
    const activities = await adapter.reserveTasks({
      kinds: ["activity"],
      limit: 2,
      leaseMs: 60_000,
    });
    const requestedTargets = activities.map(({ target }) => target);

    const completedBatch = await countClientQueries(() =>
      adapter.completeActivities(activities.map((activity) => ({
        ...toRef(activity),
        executionId: request.executionId,
        sequence: activity.commandSequence!,
        status: "completed",
        result: activity.target ?? null,
      }))));

    expect(completedBatch.count).toBe(1);
    expect(completedBatch.result).toHaveLength(2);

    const completions = (await adapter.getHistory(request.executionId))
      .filter((event) => event.type === "command-completed");
    expect(completions.map(({ result }) => result)).toEqual(requestedTargets);
    expect(completions.map(({ completionOrder }) => completionOrder).sort())
      .toEqual([0, 1]);
    expect(new Set(completions.map(({ eventIndex }) => eventIndex)).size).toBe(2);
  });

  it("serializes concurrent completion batches on one execution", async () => {
    const request = startRequest("execution-concurrent-completion-batches");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);
    await adapter.commitActivation({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot.revision,
      commands: [
        { sequence: 0, kind: "activity", target: "first", payload: null },
        { sequence: 1, kind: "activity", target: "second", payload: null },
      ],
      outcome: { status: "waiting" },
    });
    const activities = await adapter.reserveTasks({
      kinds: ["activity"],
      limit: 2,
      leaseMs: 60_000,
    });

    await Promise.all(activities.map((activity) => adapter.completeActivities([{
      ...toRef(activity),
      executionId: request.executionId,
      sequence: activity.commandSequence!,
      status: "completed",
      result: activity.target ?? null,
    }])));

    const completions = (await adapter.getHistory(request.executionId))
      .filter((event) => event.type === "command-completed");
    expect(completions.map(({ completionOrder }) => completionOrder).sort())
      .toEqual([0, 1]);
    expect(new Set(completions.map(({ eventIndex }) => eventIndex)).size).toBe(2);
  });

  it("uses revision conflicts to reject a signal racing an activation", async () => {
    const request = startRequest("execution-conflict");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);
    await adapter.sendSignal({
      executionId: request.executionId,
      workflowName: request.workflowName,
      signalName: "example.signal",
      payload: null,
    });

    await expect(adapter.commitActivation({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot!.revision,
      commands: [],
      outcome: { status: "completed" },
    })).rejects.toBeInstanceOf(WorkflowJournalConflictError);
  });

  it("rejects stale tokens after an expired task is reserved again", async () => {
    const request = startRequest("execution-lease");
    await adapter.start(request);
    const first = await reserveOne("workflow");
    await client.query(
      "UPDATE workflow_task SET available_at = statement_timestamp() - interval '1 second' WHERE id = $1",
      [first.id],
    );
    const recovered = await reserveOne("workflow");

    expect(recovered.reservationToken).not.toBe(first.reservationToken);
    await expect(adapter.releaseTasks([toRef(first)])).resolves.toEqual([]);
    await expect(adapter.releaseTasks([toRef(recovered)]))
      .resolves.toEqual([toRef(recovered)]);
  });

  it("consumes buffered signals and removes their timeout task atomically", async () => {
    const request = startRequest("execution-signal");
    await adapter.start(request);
    const receipt = await adapter.sendSignal({
      executionId: request.executionId,
      workflowName: request.workflowName,
      signalName: "example.approval",
      payload: { approved: true },
    });
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);

    await adapter.commitActivation({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot!.revision,
      commands: [{
        sequence: 0,
        kind: "signal",
        target: "example.approval",
        payload: { timeoutMs: 60_000 },
      }],
      outcome: { status: "waiting" },
    });

    await expect(adapter.getHistory(request.executionId)).resolves.toMatchObject([
      { type: "signal-received", signalId: receipt.id },
      { type: "command-scheduled", kind: "signal" },
      {
        type: "command-completed",
        result: { approved: true },
        sourceId: receipt.id,
      },
    ]);
    await expect(adapter.reserveTasks({
      kinds: ["timer"],
      limit: 1,
      leaseMs: 60_000,
    })).resolves.toEqual([]);
  });

  it("propagates a child result into its parent command", async () => {
    const request = startRequest("execution-parent");
    await adapter.start(request);
    const parentActivation = await reserveOne("workflow");
    const parentSnapshot = await loadOne(parentActivation);

    await adapter.commitActivation({
      ...toRef(parentActivation),
      executionId: request.executionId,
      expectedRevision: parentSnapshot!.revision,
      commands: [{
        sequence: 0,
        kind: "child",
        target: "example.child",
        payload: { input: { value: "input" }, version: 1 },
      }],
      outcome: { status: "waiting" },
    });
    const childActivation = await reserveOne("workflow");
    expect(childActivation).toMatchObject({
      workflowName: "example.child",
      workflowVersion: 1,
      historyGeneration: 1,
      rootExecutionId: request.executionId,
      parentExecutionId: request.executionId,
      kind: "workflow",
    });
    const childSnapshot = await loadOne(childActivation);
    expect(childSnapshot).toMatchObject({
      executionId: `${request.executionId}:0`,
      workflowName: "example.child",
    });

    await adapter.commitActivation({
      ...toRef(childActivation),
      executionId: childSnapshot!.executionId,
      expectedRevision: childSnapshot!.revision,
      commands: [],
      outcome: { status: "completed", output: "done" },
    });

    await expect(adapter.get(request.executionId)).resolves.toMatchObject({
      status: "queued",
      revision: 2,
    });
    await expect(adapter.getHistory(request.executionId)).resolves.toMatchObject([
      { type: "command-scheduled", kind: "child" },
      { type: "command-completed", result: "done" },
    ]);
  });

  it("cancels pending work and propagates cancellation through child executions", async () => {
    const request = startRequest("execution-cancel");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);
    await adapter.commitActivation({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot!.revision,
      commands: [
        {
          sequence: 0,
          kind: "child",
          target: "example.child",
          payload: { input: null, version: 1 },
        },
        {
          sequence: 1,
          kind: "timer",
          target: "sleep",
          payload: { durationMs: 60_000 },
        },
      ],
      outcome: { status: "waiting" },
    });

    await expect(adapter.requestCancellation(request.executionId))
      .resolves.toBe(true);
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({
      cancellationRequested: true,
      status: "queued",
    });
    await expect(adapter.get(`${request.executionId}:0`)).resolves.toMatchObject({
      cancellationRequested: true,
      rootExecutionId: request.executionId,
      status: "queued",
    });
    await expect(adapter.getHistory(`${request.executionId}:0`))
      .resolves.toMatchObject([{ type: "cancellation-requested" }]);
    await expect(adapter.reserveTasks({
      kinds: ["activity", "timer"],
      limit: 10,
      leaseMs: 60_000,
    })).resolves.toEqual([]);
  });

  it("does not publish queued activity outbox entries after cancellation", async () => {
    const request = startRequest("execution-cancel-outbox");
    await outboxAdapter.start(request);
    const [activation] = await outboxAdapter.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 60_000,
    });
    const [loaded] = await outboxAdapter.loadActivations([toRef(activation!)]);
    await outboxAdapter.commitActivation({
      ...toRef(activation!),
      executionId: request.executionId,
      expectedRevision: loaded!.snapshot.revision,
      commands: [{
        sequence: 0,
        kind: "activity",
        target: "example.activity",
        payload: null,
      }],
      outcome: { status: "waiting" },
    });

    await outboxAdapter.requestCancellation(request.executionId);

    await expect(outboxAdapter.reserveActivityDispatches({
      limit: 10,
      leaseMs: 60_000,
    })).resolves.toEqual([]);
  });

  it("serializes execution-scoped keyed admission and releases permits", async () => {
    const concurrency = {
      keyed: {
        key: "order-42",
        limit: 1,
        conflict: "enqueue" as const,
        scope: "execution" as const,
      },
    };
    await adapter.start({ ...startRequest("keyed-first"), concurrency });
    await adapter.start({ ...startRequest("keyed-second"), concurrency });
    await adapter.start({ ...startRequest("keyed-third"), concurrency });

    await expect(adapter.get("keyed-first")).resolves.toMatchObject({
      status: "queued",
      concurrencyAdmitted: true,
    });
    await expect(adapter.get("keyed-second")).resolves.toMatchObject({
      status: "pending",
      concurrencyAdmitted: false,
    });
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);
    await adapter.commitActivation({
      ...toRef(activation),
      executionId: snapshot!.executionId,
      expectedRevision: snapshot!.revision,
      commands: [],
      outcome: { status: "completed" },
    });

    await expect(adapter.get("keyed-second")).resolves.toMatchObject({
      status: "queued",
      concurrencyAdmitted: true,
    });
    await expect(adapter.get("keyed-third")).resolves.toMatchObject({
      status: "pending",
      concurrencyAdmitted: false,
    });
  });

  it("supports keyed reject and return-existing start policies", async () => {
    const base = {
      keyed: {
        key: "order-42",
        limit: 1,
        scope: "execution" as const,
      },
    };
    await adapter.start({
      ...startRequest("reject-first"),
      concurrency: { keyed: { ...base.keyed, conflict: "reject" } },
    });
    await expect(adapter.start({
      ...startRequest("reject-second"),
      concurrency: { keyed: { ...base.keyed, conflict: "reject" } },
    })).rejects.toMatchObject({ name: "WorkflowConcurrencyConflictError" });

    await client.query("TRUNCATE workflow_history_event, workflow_task, workflow_signal, workflow_execution");
    const first = await adapter.start({
      ...startRequest("existing-first"),
      concurrency: {
        keyed: { ...base.keyed, conflict: "return-existing" },
      },
    });
    const attached = await adapter.start({
      ...startRequest("existing-second"),
      concurrency: {
        keyed: { ...base.keyed, conflict: "return-existing" },
      },
    });
    expect(attached).toMatchObject({
      created: false,
      execution: { executionId: first.execution.executionId },
    });
  });

  it("limits task reservations by definition and active-work key", async () => {
    await adapter.start({
      ...startRequest("limited-first"),
      concurrency: {
        definitionLimit: 1,
        keyed: {
          key: "order-42",
          limit: 1,
          conflict: "enqueue",
          scope: "active-work",
        },
      },
    });
    await adapter.start({
      ...startRequest("limited-second"),
      concurrency: {
        definitionLimit: 1,
        keyed: {
          key: "order-42",
          limit: 1,
          conflict: "enqueue",
          scope: "active-work",
        },
      },
    });

    await expect(adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 10,
      leaseMs: 60_000,
    })).resolves.toHaveLength(1);
  });

  it("paginates exact timestamps in one query after the boundary row is deleted", async () => {
    for (const [id, createdAt] of [
      ["d", "2026-09-18T12:00:00.123999Z"],
      ["c", "2026-09-18T12:00:00.123456Z"],
      ["b", "2026-09-18T12:00:00.123456Z"],
      ["a", "2026-09-18T12:00:00.123455Z"],
    ]) {
      await adapter.start(startRequest(id!));
      await client.query("UPDATE workflow_execution SET created_at = $1::timestamptz WHERE id = $2", [createdAt, id]);
    }
    await adapter.start({ ...startRequest("excluded"), workflowName: "other.run" });
    const workflowNames = [startRequest("unused").workflowName];
    const querySpy = vi.spyOn(client, "query");
    try {
      const first = await adapter.listExecutions({ limit: 2, workflowNames });
      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(first.items.map(({ executionId }) => executionId)).toEqual(["d", "c"]);
      expect(z.decode(workflowExecutionCursorCodec, first.nextCursor!)).toEqual({
        id: "c", createdAt: "2026-09-18T12:00:00.123456Z",
      });
      await client.query("DELETE FROM workflow_execution WHERE id = $1", ["c"]);
      await adapter.start(startRequest("newer"));
      querySpy.mockClear();
      const last = await adapter.listExecutions({ limit: 2, workflowNames, cursor: first.nextCursor! });
      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(last.items.map(({ executionId }) => executionId)).toEqual(["b", "a"]);
      expect(last.nextCursor).toBeUndefined();
      expect(last.items[0]).not.toHaveProperty("cursorCreatedAt");
      querySpy.mockClear();
      for (const cursor of ["c", "invalid", "", "a".repeat(4097)]) {
        await expect(adapter.listExecutions({ limit: 2, cursor })).rejects.toThrow(TypeError);
      }
      expect(querySpy).not.toHaveBeenCalled();
    } finally {
      querySpy.mockRestore();
    }
  });

  it("supports operational search, pause, termination and linked retry", async () => {
    await adapter.start(startRequest("active-operation"));
    const page = await adapter.listExecutions({
      limit: 10,
      search: "active-operation",
      statuses: ["queued"],
    });
    expect(page.items).toMatchObject([{ executionId: "active-operation" }]);

    await expect(adapter.setPaused("active-operation", true)).resolves.toBe(true);
    await expect(adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 10,
      leaseMs: 1_000,
    })).resolves.toHaveLength(0);
    await expect(adapter.setPaused("active-operation", false)).resolves.toBe(true);
    await expect(adapter.forceTerminate("active-operation", "operator test"))
      .resolves.toBe(true);
    await expect(adapter.get("active-operation")).resolves.toMatchObject({
      status: "terminated",
      error: { name: "WorkflowExecutionTerminatedError", message: "operator test" },
    });

    await adapter.start(startRequest("retry-source"));
    const activation = await reserveOne("workflow");
    await adapter.commitActivation({
      ...toRef(activation),
      executionId: "retry-source",
      expectedRevision: 0,
      commands: [],
      outcome: {
        status: "failed",
        error: { name: "TestError", message: "failed" },
      },
    });
    const retry = await adapter.retryExecution({
      sourceExecutionId: "retry-source",
      executionId: "retry-target",
      workflowVersion: 2,
    });
    expect(retry).toMatchObject({
      created: true,
      execution: {
        executionId: "retry-target",
        retryOfExecutionId: "retry-source",
        workflowVersion: 2,
        input: { value: "input" },
      },
    });
  });
});

function startRequest(executionId: string) {
  return {
    executionId,
    workflowName: "example.run",
    workflowVersion: 1,
    input: { value: "input" },
  } as const;
}

async function reserveOne(kind: "activity" | "timer" | "workflow") {
  const [task] = await adapter.reserveTasks({
    kinds: [kind],
    limit: 1,
    leaseMs: 60_000,
  });
  expect(task).toBeDefined();
  return task!;
}

async function loadOne(task: { id: string; reservationToken: string }) {
  const [loaded] = await adapter.loadActivations([toRef(task)]);
  expect(loaded).toBeDefined();
  return loaded!.snapshot;
}

function toRef(task: { id: string; reservationToken: string }) {
  return { taskId: task.id, reservationToken: task.reservationToken };
}

/** Counts driver round trips and always restores the shared test client. */
async function countClientQueries<Result>(
  run: () => Promise<Result>,
): Promise<{ count: number; result: Result }> {
  const originalQuery = client.query;
  let count = 0;
  client.query = ((...arguments_: unknown[]) => {
    count += 1;
    return Reflect.apply(originalQuery, client, arguments_);
  }) as typeof client.query;

  try {
    const result = await run();
    return { count, result };
  } finally {
    client.query = originalQuery;
  }
}
