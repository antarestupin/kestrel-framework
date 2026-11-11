import { randomBytes } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
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
  afterEach,
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
  WorkflowExecutionClosedError,
  WorkflowExecutionConflictError,
  WorkflowExecutionNotFoundError,
  WorkflowJournalConflictError,
  WorkflowSignalConflictError,
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
// The race fixtures span connections and must remain isolated across test processes.
const qualifiedSchemaName = `workflow_adapter_test_${randomBytes(6).toString("hex")}`;
const qualifiedFixtureSchema = pgSchema(qualifiedSchemaName);
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
  id: uuid("id").default(sql`uuidv7()`).primaryKey(),
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
    CREATE SCHEMA ${qualifiedSchemaName};
    CREATE TABLE ${qualifiedSchemaName}.execution (
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
    CREATE TABLE ${qualifiedSchemaName}.history_event (
      execution_id text NOT NULL,
      event_index integer NOT NULL,
      type text NOT NULL
    );
    CREATE TABLE ${qualifiedSchemaName}.task (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
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
      UNIQUE (execution_id, idempotency_key)
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
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${qualifiedSchemaName} CASCADE`);
  } finally {
    client.release();
    await pool.end();
  }
});

describe("PostgresWorkflowAdapter", () => {
  it("wakes a resumed waiting root after its previous activation was consumed", async () => {
    await adapter.start(startRequest("resume-waiting"));
    const task = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(task), executionId: "resume-waiting", expectedRevision: 0, commands: [], outcome: { status: "waiting" } });
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["resume-waiting"])).rows).toEqual([]);
    await adapter.setPaused("resume-waiting", true);
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["resume-waiting"])).rows).toEqual([]);
    expect(await adapter.setPaused("resume-waiting", false)).toBe(true);
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["resume-waiting"])).rows).toMatchObject([{ kind: "workflow" }]);
  });

  it("keeps parent completion order and root identity when terminating a child with descendants", async () => {
    await adapter.start(startRequest("ordered-parent"));
    const parent = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(parent), executionId: "ordered-parent", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "child.run", payload: { version: 1, input: null, executionId: "first-child" } }, { kind: "child", sequence: 1, target: "child.run", payload: { version: 1, input: null, executionId: "second-child" } }], outcome: { status: "waiting" } });
    const children = await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });
    const first = children.find(({ executionId }) => executionId === "first-child")!;
    const second = children.find(({ executionId }) => executionId === "second-child")!;
    await adapter.commitActivation({ ...toRef(first), executionId: "first-child", expectedRevision: 0, commands: [], outcome: { status: "completed", output: { done: true } } });
    await adapter.commitActivation({ ...toRef(second), executionId: "second-child", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "grandchild.run", payload: { version: 1, input: null, executionId: "grandchild" } }], outcome: { status: "waiting" } });
    expect(await adapter.forceTerminate("second-child", "ordered operator stop")).toBe(true);
    const completions = (await adapter.getHistory("ordered-parent")).filter(({ type }) => type === "command-completed");
    expect(completions).toMatchObject([{ sequence: 0, completionOrder: 0 }, { sequence: 1, completionOrder: 1, error: { name: "WorkflowExecutionTerminatedError", message: 'Child workflow "second-child" was terminated: ordered operator stop' } }]);
    expect(await adapter.get("ordered-parent")).toMatchObject({ status: "queued", revision: 4 });
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["ordered-parent"])).rows).toMatchObject([{ kind: "workflow" }]);
    expect((await adapter.get("grandchild"))?.status).toBe("terminated");
  });

  it("notifies a waiting parent when its capacity-pending child is cancelled", async () => {
    const concurrency = { keyed: { key: "pending-child-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
    await adapter.start({ ...startRequest("child-key-holder"), workflowName: "child.run", concurrency });
    await adapter.start(startRequest("pending-child-parent"));
    const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });
    const parent = tasks.find(({ executionId }) => executionId === "pending-child-parent")!;
    await adapter.commitActivation({ ...toRef(parent), executionId: "pending-child-parent", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "first-child.run", payload: { version: 1, input: null, executionId: "already-completed-child" } }, { kind: "child", sequence: 1, target: "child.run", payload: { version: 1, input: null, executionId: "capacity-pending-child", concurrency } }], outcome: { status: "waiting" } });
    const firstChild = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(firstChild), executionId: "already-completed-child", expectedRevision: 0, commands: [], outcome: { status: "completed" } });
    expect((await adapter.get("capacity-pending-child"))?.status).toBe("pending");
    expect(await adapter.requestCancellation("capacity-pending-child")).toBe(true);
    expect(await adapter.get("pending-child-parent")).toMatchObject({ status: "queued", revision: 4 });
    const history = await adapter.getHistory("pending-child-parent");
    expect(history.at(-1)).toMatchObject({ type: "command-completed", sequence: 1, completionOrder: 1, error: { name: "WorkflowCancellationError", message: 'Child workflow "capacity-pending-child" was cancelled.', details: { executionId: "capacity-pending-child" } } });
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["pending-child-parent"])).rows).toMatchObject([{ kind: "workflow" }]);
    expect(await adapter.requestCancellation("capacity-pending-child")).toBe(false);
    expect(await adapter.getHistory("pending-child-parent")).toEqual(history);
  });

  it("keeps a failed parent immutable when cancellation immediately closes its pending child", async () => {
    const concurrency = { keyed: { key: "failed-parent-child-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
    await adapter.start({ ...startRequest("failed-parent-holder"), workflowName: "child.run", concurrency });
    await adapter.start(startRequest("failed-pending-parent"));
    const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 });
    const parent = tasks.find(({ executionId }) => executionId === "failed-pending-parent")!;
    await adapter.commitActivation({ ...toRef(parent), executionId: "failed-pending-parent", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "child.run", payload: { version: 1, input: null, executionId: "failed-parent-pending-child", concurrency } }], outcome: { status: "failed", error: { name: "ParentFailure", message: "failed before child admission" } } });
    expect(await adapter.get("failed-parent-pending-child")).toMatchObject({ status: "cancelled", cancellationRequested: true });
    expect(await adapter.get("failed-pending-parent")).toMatchObject({ status: "failed", revision: 1, error: { message: "failed before child admission" } });
    expect((await adapter.getHistory("failed-pending-parent")).filter(({ type }) => type === "command-completed")).toEqual([]);
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["failed-pending-parent"])).rows).toEqual([]);
  });

  it("cancels a paused pending root once without admitting it or altering its key holder", async () => {
    const concurrency = { keyed: { key: "cancel-pending-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
    await adapter.start({ ...startRequest("cancel-key-holder"), concurrency });
    await adapter.start({ ...startRequest("cancel-pending"), concurrency });
    await adapter.start({ ...startRequest("cancel-pending-peer"), concurrency });
    await adapter.setPaused("cancel-pending", true);
    const holder = await adapter.get("cancel-key-holder");
    const lower = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    expect(await adapter.requestCancellation("cancel-pending")).toBe(true);
    const upper = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    const cancelled = (await adapter.get("cancel-pending"))!;
    expect(cancelled).toMatchObject({ status: "cancelled", cancellationRequested: true, concurrencyAdmitted: false, revision: 1 });
    expect(cancelled).not.toHaveProperty("pausedAt");
    expect(cancelled.completedAt!.getTime()).toBeGreaterThanOrEqual(lower.getTime());
    expect(cancelled.completedAt!.getTime()).toBeLessThanOrEqual(upper.getTime());
    const history = await adapter.getHistory("cancel-pending");
    expect(history).toMatchObject([{ type: "cancellation-requested", eventIndex: 0 }]);
    expect(await adapter.requestCancellation("cancel-pending")).toBe(false);
    expect(await adapter.setPaused("cancel-pending", true)).toBe(false);
    expect(await adapter.forceTerminate("cancel-pending", "different reason")).toBe(false);
    expect(await adapter.get("cancel-pending")).toEqual(cancelled);
    expect(await adapter.getHistory("cancel-pending")).toEqual(history);
    expect(await adapter.get("cancel-key-holder")).toEqual(holder);
    expect((await adapter.get("cancel-pending-peer"))?.status).toBe("pending");
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["cancel-pending"])).rows).toEqual([]);
  });

  it("pauses and resumes idempotently while keeping capacity-pending roots without tasks", async () => {
    const concurrency = { keyed: { key: "paused-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
    await adapter.start({ ...startRequest("pause-holder"), concurrency });
    await adapter.start({ ...startRequest("pause-pending"), concurrency });
    expect(await adapter.setPaused("pause-holder", true)).toBe(true);
    const paused = await adapter.get("pause-holder");
    expect(paused?.pausedAt).toBeInstanceOf(Date);
    expect(await adapter.setPaused("pause-holder", true)).toBe(false);
    expect(await adapter.get("pause-holder")).toEqual(paused);
    expect(await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 })).toEqual([]);
    expect(await adapter.setPaused("pause-holder", false)).toBe(true);
    const resumed = await adapter.get("pause-holder");
    expect(resumed).not.toHaveProperty("pausedAt");
    expect(await adapter.setPaused("pause-holder", false)).toBe(false);
    expect(await adapter.get("pause-holder")).toEqual(resumed);
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["pause-holder"])).rows).toHaveLength(1);
    await adapter.setPaused("pause-pending", true);
    expect(await adapter.setPaused("pause-pending", false)).toBe(true);
    expect((await adapter.get("pause-pending"))?.status).toBe("pending");
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["pause-pending"])).rows).toEqual([]);
  });

  it("propagates cooperative cancellation to open children and removes local activity/timer work", async () => {
    await adapter.start(startRequest("cancel-parent"));
    const task = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(task), executionId: "cancel-parent", expectedRevision: 0,
      commands: [{ kind: "activity", sequence: 0, target: "activity.run", payload: null }, { kind: "timer", sequence: 1, target: "timer", payload: { durationMs: 60_000 } }, { kind: "child", sequence: 2, target: "child.run", payload: { version: 1, input: null, executionId: "cancel-child" } }], outcome: { status: "waiting" },
    });
    await adapter.start(startRequest("cancel-unrelated"));
    const unrelatedTask = (await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 1_000 })).find(({ executionId }) => executionId === "cancel-unrelated")!;
    await adapter.commitActivation({ ...toRef(unrelatedTask), executionId: "cancel-unrelated", expectedRevision: 0,
      commands: [{ kind: "activity", sequence: 0, target: "activity.run", payload: null }, { kind: "timer", sequence: 1, target: "timer", payload: { durationMs: 60_000 } }], outcome: { status: "waiting" } });
    const unrelated = await adapter.get("cancel-unrelated");
    const unrelatedTasks = (await client.query("SELECT * FROM workflow_task WHERE execution_id = $1 ORDER BY id", ["cancel-unrelated"])).rows;
    expect(unrelatedTasks).toHaveLength(2);
    await adapter.setPaused("cancel-parent", true);
    await adapter.setPaused("cancel-child", true);
    expect(await adapter.requestCancellation("cancel-parent")).toBe(true);
    expect(await adapter.get("cancel-parent")).toMatchObject({ status: "queued", cancellationRequested: true, revision: 4 });
    expect(await adapter.get("cancel-parent")).not.toHaveProperty("pausedAt");
    expect(await adapter.get("cancel-child")).toMatchObject({ status: "queued", cancellationRequested: true });
    expect(await adapter.get("cancel-child")).not.toHaveProperty("pausedAt");
    const tasks = (await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["cancel-parent"])).rows;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.kind).toBe("workflow");
    const history = await adapter.getHistory("cancel-parent");
    expect(history.at(-1)).toMatchObject({ type: "cancellation-requested", eventIndex: 3 });
    expect(await adapter.requestCancellation("cancel-parent")).toBe(false);
    expect(await adapter.getHistory("cancel-parent")).toEqual(history);
    expect(await adapter.get("cancel-unrelated")).toEqual(unrelated);
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1 ORDER BY id", ["cancel-unrelated"])).rows).toEqual(unrelatedTasks);
  });

  it("terminates descendants and outbox/local work while admitting the next keyed execution", async () => {
    const concurrency = { keyed: { key: "terminate-key", limit: 1, conflict: "enqueue" as const, scope: "execution" as const } };
    await outboxAdapter.start({ ...startRequest("terminate-parent"), concurrency });
    await outboxAdapter.start({ ...startRequest("terminate-peer"), concurrency });
    const [task] = await outboxAdapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await outboxAdapter.commitActivation({ ...toRef(task!), executionId: "terminate-parent", expectedRevision: 0,
      commands: [{ kind: "activity", sequence: 0, target: "activity.run", payload: null }, { kind: "timer", sequence: 1, target: "timer", payload: { durationMs: 60_000 } }, { kind: "child", sequence: 2, target: "child.run", payload: { version: 1, input: null, executionId: "terminate-child" } }], outcome: { status: "waiting" },
    });
    await adapter.start({ ...startRequest("terminate-unrelated"), workflowName: "other.run" });
    const unrelated = await adapter.get("terminate-unrelated");
    await adapter.setPaused("terminate-parent", true);
    expect((await client.query("SELECT * FROM workflow_dispatch_outbox WHERE execution_id = $1", ["terminate-parent"])).rows).toHaveLength(1);
    const lower = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    expect(await adapter.forceTerminate("terminate-parent", "operator stop")).toBe(true);
    const upper = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    const terminated = (await adapter.get("terminate-parent"))!;
    expect(terminated).toMatchObject({ status: "terminated", concurrencyAdmitted: false, error: { name: "WorkflowExecutionTerminatedError", message: "operator stop" } });
    expect(terminated).not.toHaveProperty("pausedAt");
    expect(terminated.completedAt!.getTime()).toBeGreaterThanOrEqual(lower.getTime());
    expect(terminated.completedAt!.getTime()).toBeLessThanOrEqual(upper.getTime());
    expect(await adapter.get("terminate-child")).toMatchObject({ status: "terminated", concurrencyAdmitted: false, error: { message: "operator stop" } });
    expect(await adapter.get("terminate-peer")).toMatchObject({ status: "queued", concurrencyAdmitted: true });
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id IN ($1,$2)", ["terminate-parent", "terminate-child"])).rows).toEqual([]);
    expect((await client.query("SELECT * FROM workflow_dispatch_outbox WHERE execution_id = $1", ["terminate-parent"])).rows).toEqual([]);
    expect(await adapter.get("terminate-unrelated")).toEqual(unrelated);
    expect(await adapter.forceTerminate("terminate-parent", "another reason")).toBe(false);
    expect(await adapter.get("terminate-parent")).toEqual(terminated);
  });

  it("notifies a waiting parent once when an operator terminates its child", async () => {
    await adapter.start(startRequest("waiting-parent"));
    const task = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(task), executionId: "waiting-parent", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "child.run", payload: { version: 1, input: null, executionId: "terminated-child" } }], outcome: { status: "waiting" },
    });
    expect(await adapter.forceTerminate("terminated-child", "child operator stop")).toBe(true);
    expect(await adapter.get("waiting-parent")).toMatchObject({ status: "queued", revision: 2 });
    const history = await adapter.getHistory("waiting-parent");
    expect(history.at(-1)).toMatchObject({ type: "command-completed", eventIndex: 1, sequence: 0, completionOrder: 0, error: { name: "WorkflowExecutionTerminatedError", details: { executionId: "terminated-child" } } });
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["waiting-parent"])).rows).toHaveLength(1);
    expect(await adapter.forceTerminate("terminated-child", "repeat" )).toBe(false);
    expect(await adapter.getHistory("waiting-parent")).toEqual(history);
  });

  it("rejects missing operational roots and preserves completed/failed terminal rows", async () => {
    await expect(adapter.setPaused("missing-root", true)).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await expect(adapter.requestCancellation("missing-root")).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await expect(adapter.forceTerminate("missing-root")).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    for (const status of ["completed", "failed"] as const) {
      const id = `closed-${status}`;
      await adapter.start(startRequest(id));
      const task = await reserveOne("workflow");
      await adapter.commitActivation({ ...toRef(task), executionId: id, expectedRevision: 0, commands: [], outcome: status === "failed" ? { status, error: { name: "Failure", message: "original" } } : { status, output: { done: true } } });
      const before = await adapter.get(id);
      expect(await adapter.setPaused(id, true)).toBe(false);
      expect(await adapter.requestCancellation(id)).toBe(false);
      expect(await adapter.forceTerminate(id, "new reason")).toBe(false);
      expect(await adapter.get(id)).toEqual(before);
    }
  });

  it("terminates open descendants even when their failed parent is already terminal", async () => {
    await adapter.start(startRequest("terminal-parent"));
    const task = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(task), executionId: "terminal-parent", expectedRevision: 0,
      commands: [{ kind: "child", sequence: 0, target: "child.run", payload: { version: 1, input: null, executionId: "open-child" } }],
      outcome: { status: "failed", error: { name: "ParentFailure", message: "Parent failed before child compensation." } },
    });
    const parentBefore = await adapter.get("terminal-parent");
    expect(await adapter.get("open-child")).toMatchObject({ status: "queued", cancellationRequested: true });
    // The boolean describes whether the selected root changed; descendants must still be closed.
    expect(await adapter.forceTerminate("terminal-parent", "operator escalation")).toBe(false);
    expect(await adapter.get("terminal-parent")).toEqual(parentBefore);
    expect(await adapter.get("open-child")).toMatchObject({ status: "terminated", error: { name: "WorkflowExecutionTerminatedError", message: "operator escalation" } });
    expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["open-child"])).rows).toEqual([]);
  });

  it("rejects missing or nonfailed retry sources, invalid IDs and unrelated reused targets without writes", async () => {
    const sourceId = "retry-validation-source";
    await adapter.start(startRequest(sourceId));
    const before = (await client.query("SELECT * FROM workflow_execution ORDER BY id")).rows;
    const retry = { sourceExecutionId: sourceId, executionId: "retry-validation-target", workflowVersion: 2 };
    await expect(adapter.retryExecution({ ...retry, sourceExecutionId: "missing-source" })).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await expect(adapter.retryExecution(retry)).rejects.toBeInstanceOf(TypeError);
    await expect(adapter.retryExecution({ ...retry, executionId: "" })).rejects.toBeInstanceOf(TypeError);
    expect((await client.query("SELECT * FROM workflow_execution ORDER BY id")).rows).toEqual(before);
    const task = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(task), executionId: sourceId, expectedRevision: 0, commands: [], outcome: { status: "failed", error: { name: "Failure", message: "Failed source." } } });
    // Validate against a retriable source so its status cannot mask an invalid target ID.
    await expect(adapter.retryExecution({ ...retry, executionId: "" })).rejects.toBeInstanceOf(TypeError);
    await adapter.start(startRequest("unrelated-retry-target"));
    const existing = (await client.query("SELECT * FROM workflow_execution ORDER BY id")).rows;
    await expect(adapter.retryExecution({ ...retry, executionId: "unrelated-retry-target" })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    expect((await client.query("SELECT * FROM workflow_execution ORDER BY id")).rows).toEqual(existing);
  });

  for (const input of [null, { legacy: true }]) {
    it(`retries a legacy absent input snapshot with ${JSON.stringify(input)} input`, async () => {
      const sourceId = "retry-legacy-source";
      await adapter.start({ ...startRequest(sourceId), input });
      const task = await reserveOne("workflow");
      await adapter.commitActivation({ ...toRef(task), executionId: sourceId, expectedRevision: 0, commands: [], outcome: { status: "failed", error: { name: "Failure", message: "Legacy source failed." } } });
      // Old rows predate the initial snapshot column; their persisted input remains authoritative.
      await client.query("UPDATE workflow_execution SET initial_input = NULL WHERE id = $1", [sourceId]);
      const result = await adapter.retryExecution({ sourceExecutionId: sourceId, executionId: "retry-legacy-target", workflowVersion: 2 });
      expect(result.execution.input).toEqual(input);
      const stored = (await client.query("SELECT initial_input FROM workflow_execution WHERE id = $1", ["retry-legacy-target"])).rows[0]!;
      expect(stored.initial_input).toEqual({ value: input });
    });
  }

  it("admits a keyed retry when capacity is free and persists its original input snapshot", async () => {
    const sourceId = "retry-free-capacity";
    const concurrency = { keyed: { key: "available-key", limit: 1, conflict: "return-existing" as const, scope: "execution" as const } };
    await adapter.start({ ...startRequest(sourceId), concurrency });
    const task = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(task), executionId: sourceId, expectedRevision: 0, commands: [], outcome: { status: "failed", error: { name: "Failure", message: "Source failed." } } });
    const retry = await adapter.retryExecution({ sourceExecutionId: sourceId, executionId: "retry-admitted", workflowVersion: 2 });
    expect(retry.execution).toMatchObject({ status: "queued", concurrencyAdmitted: true, input: startRequest(sourceId).input, concurrency });
    const stored = (await client.query("SELECT initial_input FROM workflow_execution WHERE id = $1", ["retry-admitted"])).rows[0]!;
    expect(stored.initial_input).toEqual({ value: startRequest(sourceId).input });
    const activation = await reserveOne("workflow");
    expect(activation.executionId).toBe("retry-admitted");
    expect(activation.kind).toBe("workflow");
  });

  describe("concurrent PostgreSQL retries", () => {
    afterEach(async () => {
      await client.query(`TRUNCATE ${qualifiedSchemaName}.task, ${qualifiedSchemaName}.execution`);
    });

    it("leaves a retry pending when an ordinary start claims the last permit", async () => {
      const sourceExecutionId = "keyed-race-failed-source";
      const startId = "keyed-race-start";
      const retryId = "keyed-race-retry";
      const key = "keyed-race";
      await seedFailedQualifiedExecution(sourceExecutionId, key);

      const race = await raceQualifiedTransactions(
        (owner) => owner.start({
          ...startRequest(startId),
          concurrency: { keyed: { key, limit: 1, conflict: "enqueue", scope: "execution" } },
        }),
        (contender) => contender.retryExecution({ sourceExecutionId, executionId: retryId, workflowVersion: 2 }),
      );

      expect(race.first).toMatchObject({
        created: true,
        execution: { executionId: startId, status: "queued", concurrencyAdmitted: true },
      });
      expect(race.second).toMatchObject({
        status: "fulfilled",
        value: {
          created: true,
          execution: {
            executionId: retryId,
            retryOfExecutionId: sourceExecutionId,
            status: "pending",
            concurrencyAdmitted: false,
          },
        },
      });
      expect(race.blockedBy).toBe("advisory");
      expect((await client.query(
        `SELECT execution_id FROM ${qualifiedSchemaName}.task ORDER BY execution_id`,
      )).rows).toEqual([{ execution_id: startId }]);
    });

    it("reports a conflicting ordinary start that claims the retry identity before commit", async () => {
      const sourceExecutionId = "keyed-identity-failed-source";
      const targetId = "keyed-identity-target";
      const key = "keyed-identity-race";
      await seedFailedQualifiedExecution(sourceExecutionId, key);

      const race = await raceQualifiedTransactions(
        (owner) => owner.start({
          ...startRequest(targetId),
          concurrency: { keyed: { key, limit: 1, conflict: "enqueue", scope: "execution" } },
        }),
        (contender) => contender.retryExecution({ sourceExecutionId, executionId: targetId, workflowVersion: 2 }),
      );

      expect(race.first).toMatchObject({ created: true, execution: { executionId: targetId } });
      expect(race.blockedBy).toBe("advisory");
      expect(race.second).toEqual({
        status: "rejected",
        reason: expect.any(WorkflowExecutionConflictError),
      });
      expect((await client.query(
        `SELECT id, retry_of_execution_id FROM ${qualifiedSchemaName}.execution WHERE id = $1`,
        [targetId],
      )).rows).toEqual([{ id: targetId, retry_of_execution_id: null }]);
      expect((await client.query(
        `SELECT execution_id FROM ${qualifiedSchemaName}.task`,
      )).rows).toEqual([{ execution_id: targetId }]);
    });

    it("classifies competing retries from different sources as an execution conflict", async () => {
      const firstSource = "identity-race-failed-first";
      const secondSource = "identity-race-failed-second";
      const targetId = "identity-race-target";
      await seedFailedQualifiedExecution(firstSource);
      await seedFailedQualifiedExecution(secondSource);

      const race = await raceQualifiedTransactions(
        (owner) => owner.retryExecution({ sourceExecutionId: firstSource, executionId: targetId, workflowVersion: 2 }),
        (contender) => contender.retryExecution({ sourceExecutionId: secondSource, executionId: targetId, workflowVersion: 3 }),
      );

      expect(race.first).toMatchObject({
        created: true,
        execution: { executionId: targetId, retryOfExecutionId: firstSource, workflowVersion: 2 },
      });
      expect(race.second).toEqual({
        status: "rejected",
        reason: expect.any(WorkflowExecutionConflictError),
      });
      expect(race.blockedBy).toBe("advisory");
      expect((await client.query(
        `SELECT execution_id FROM ${qualifiedSchemaName}.task`,
      )).rows).toEqual([{ execution_id: targetId }]);
    });

    it("allows an unrelated retry identity to complete while another retry remains uncommitted", async () => {
      const firstSource = "independent-race-failed-first";
      const secondSource = "independent-race-failed-second";
      const firstId = "independent-race-first-target";
      const secondId = "independent-race-second-target";
      await seedFailedQualifiedExecution(firstSource);
      await seedFailedQualifiedExecution(secondSource);

      const race = await raceQualifiedTransactions(
        (owner) => owner.retryExecution({ sourceExecutionId: firstSource, executionId: firstId, workflowVersion: 2 }),
        (contender) => contender.retryExecution({ sourceExecutionId: secondSource, executionId: secondId, workflowVersion: 2 }),
      );

      expect(race.first).toMatchObject({
        created: true,
        execution: { executionId: firstId, retryOfExecutionId: firstSource },
      });
      expect(race.second).toMatchObject({
        status: "fulfilled",
        value: {
          created: true,
          execution: { executionId: secondId, retryOfExecutionId: secondSource },
        },
      });
      expect(race.blockedBy).toBe("settled");
    });
  });

  it("releases only matching task generations in request order and preserves unrelated reservations", async () => {
    for (const executionId of ["release-first", "release-second", "release-unrelated"]) await adapter.start(startRequest(executionId));
    const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 3, leaseMs: 60_000 });
    const [first, second, unrelated] = tasks;
    const before = (await client.query("SELECT * FROM workflow_task ORDER BY id")).rows;
    const unrelatedExecution = await adapter.get(unrelated!.executionId);
    const lower = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    const changed = await adapter.releaseTasks([
      { taskId: "00000000-0000-4000-8000-000000000099", reservationToken: first!.reservationToken },
      { taskId: first!.id, reservationToken: second!.reservationToken },
      toRef(second!), toRef(first!), toRef(second!),
    ]);
    expect(changed).toEqual([toRef(second!), toRef(first!)]);
    const upper = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    const after = (await client.query("SELECT * FROM workflow_task ORDER BY id")).rows;
    for (const task of [first!, second!]) {
      const row = after.find((row) => row.id === task.id)!;
      expect(row).toEqual({ ...before.find((row) => row.id === task.id), available_at: expect.any(Date), reserved_at: null, reservation_token: null });
      expect(row.available_at.getTime()).toBeGreaterThanOrEqual(lower.getTime());
      expect(row.available_at.getTime()).toBeLessThanOrEqual(upper.getTime());
      const execution = (await adapter.get(task.executionId))!;
      expect(execution.status).toBe("queued");
      expect(execution.updatedAt.getTime()).toBeGreaterThanOrEqual(lower.getTime());
      expect(execution.updatedAt.getTime()).toBeLessThanOrEqual(upper.getTime());
    }
    expect(after.find((row) => row.id === unrelated!.id)).toEqual(before.find((row) => row.id === unrelated!.id));
    expect(await adapter.get(unrelated!.executionId)).toEqual(unrelatedExecution);
  });

  it("extends only matching generations using server time while retaining ownership and execution state", async () => {
    for (const executionId of ["extend-first", "extend-second", "extend-unrelated"]) await adapter.start(startRequest(executionId));
    const tasks = await adapter.reserveTasks({ kinds: ["workflow"], limit: 3, leaseMs: 60_000 });
    const [first, second, unrelated] = tasks;
    const before = (await client.query("SELECT * FROM workflow_task ORDER BY id")).rows;
    const executions = [];
    for (const { executionId } of tasks) executions.push(await adapter.get(executionId));
    const lower = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    expect(await adapter.extendTaskLeases([
      { taskId: first!.id, reservationToken: second!.reservationToken, leaseMs: 1_000 },
      { taskId: "00000000-0000-4000-8000-000000000099", reservationToken: first!.reservationToken, leaseMs: 1_000 },
      { ...toRef(second!), leaseMs: 3_000 }, { ...toRef(first!), leaseMs: 1 },
    ])).toEqual([toRef(second!), toRef(first!)]);
    const upper = (await client.query("SELECT statement_timestamp() AS now")).rows[0]!.now as Date;
    const after = (await client.query("SELECT * FROM workflow_task ORDER BY id")).rows;
    for (const [task, leaseMs] of [[first!, 1], [second!, 3_000]] as const) {
      const row = after.find((row) => row.id === task.id)!;
      expect(row).toEqual({ ...before.find((row) => row.id === task.id), available_at: expect.any(Date) });
      expect(row.available_at.getTime()).toBeGreaterThanOrEqual(lower.getTime() + leaseMs);
      expect(row.available_at.getTime()).toBeLessThanOrEqual(upper.getTime() + leaseMs);
    }
    expect(after.find((row) => row.id === unrelated!.id)).toEqual(before.find((row) => row.id === unrelated!.id));
    const afterExecutions = [];
    for (const { executionId } of tasks) afterExecutions.push(await adapter.get(executionId));
    expect(afterExecutions).toEqual(executions);
  });

  it("releases non-workflow tasks without changing the waiting execution", async () => {
    await adapter.start(startRequest("release-commands"));
    const activation = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(activation), executionId: "release-commands", expectedRevision: 0,
      commands: [{ kind: "activity", sequence: 0, target: "activity.run", payload: null }, { kind: "timer", sequence: 1, target: "timer", payload: { durationMs: 0 } }], outcome: { status: "waiting" },
    });
    const tasks = await adapter.reserveTasks({ kinds: ["activity", "timer"], limit: 2, leaseMs: 60_000 });
    expect(new Set(tasks.map(({ kind }) => kind))).toEqual(new Set(["activity", "timer"]));
    const before = await adapter.get("release-commands");
    expect(await adapter.releaseTasks(tasks.map(toRef))).toEqual(tasks.map(toRef));
    expect(await adapter.get("release-commands")).toEqual(before);
  });

  it("handles empty reservation batches without changing stored tasks", async () => {
    await adapter.start(startRequest("empty-mutations"));
    await reserveOne("workflow");
    const before = (await client.query("SELECT * FROM workflow_task ORDER BY id")).rows;
    expect(await adapter.releaseTasks([])).toEqual([]);
    expect(await adapter.extendTaskLeases([])).toEqual([]);
    expect((await client.query("SELECT * FROM workflow_task ORDER BY id")).rows).toEqual(before);
  });

  for (const leaseMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid owned task lease ${leaseMs} without changing its row`, async () => {
      await adapter.start(startRequest("invalid-extension"));
      const task = await reserveOne("workflow");
      const before = (await client.query("SELECT * FROM workflow_task ORDER BY id")).rows;
      await expect(adapter.extendTaskLeases([{ ...toRef(task), leaseMs }])).rejects.toThrow(TypeError);
      expect((await client.query("SELECT * FROM workflow_task ORDER BY id")).rows).toEqual(before);
    });
  }

  for (const conflict of ["enqueue", "reject", "return-existing"] as const) {
    for (const scope of ["execution", "active-work"] as const) {
      it(`creates a distinct operator retry under ${scope} ${conflict} keyed admission`, async () => {
        const sourceId = "retry-policy-source";
        const concurrency = { definitionLimit: 3, keyed: { key: "retry-policy-key", limit: 1, conflict, scope } };
        await adapter.start({ ...startRequest(sourceId), concurrency });
        const task = await reserveOne("workflow");
        await adapter.commitActivation({ ...toRef(task), executionId: sourceId, expectedRevision: 0, commands: [], outcome: { status: "failed", error: { name: "TransientError", message: "Retry the execution." } } });
        await adapter.start({ ...startRequest("retry-policy-active"), concurrency });
        const sourceBefore = await adapter.get(sourceId);
        const activeBefore = await adapter.get("retry-policy-active");
        const retried = await adapter.retryExecution({ sourceExecutionId: sourceId, executionId: "retry-policy-target", workflowVersion: 2 });
        expect(retried).toMatchObject({ created: true, execution: {
          executionId: "retry-policy-target", rootExecutionId: "retry-policy-target", retryOfExecutionId: sourceId,
          workflowVersion: 2, input: startRequest(sourceId).input, concurrency,
          status: scope === "execution" ? "pending" : "queued", concurrencyAdmitted: scope !== "execution",
        } });
        expect(await adapter.get("retry-policy-target")).toEqual(retried.execution);
        expect(await adapter.get(sourceId)).toEqual(sourceBefore);
        expect(await adapter.get("retry-policy-active")).toEqual(activeBefore);
        expect((await client.query("SELECT * FROM workflow_task WHERE execution_id = $1", ["retry-policy-target"])).rows).toHaveLength(scope === "execution" ? 0 : 1);
        expect(await adapter.retryExecution({ sourceExecutionId: sourceId, executionId: "retry-policy-target", workflowVersion: 3 }))
          .toEqual({ created: false, execution: retried.execution });
      });
    }
  }

  it("retries the original null input after a failed continued generation", async () => {
    const sourceId = "retry-original-null";
    await adapter.start({ ...startRequest(sourceId), input: null });
    const first = await reserveOne("workflow");
    // The initial input is present and null, rather than a legacy missing snapshot.
    await expect(adapter.continueAsNew({ ...toRef(first), executionId: sourceId, expectedRevision: 0, workflowVersion: 2, input: { nextGeneration: true } })).resolves.toBe(true);
    const continued = await reserveOne("workflow");
    await adapter.commitActivation({ ...toRef(continued), executionId: sourceId, expectedRevision: 0, commands: [], outcome: { status: "failed", error: { name: "Failure", message: "The continued generation failed." } } });
    const sourceBefore = await adapter.get(sourceId);
    const retried = await adapter.retryExecution({ sourceExecutionId: sourceId, executionId: "retry-original-null-target", workflowVersion: 3 });
    expect(retried.execution.input).toBeNull();
    expect(retried.execution.historyGeneration).toBe(1);
    expect(retried.execution.workflowVersion).toBe(3);
    expect(await adapter.get(sourceId)).toEqual(sourceBefore);
  });

  it("retries only the owned activity and preserves unrelated reservations", async () => {
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    const firstToken = "00000000-0000-4000-8000-000000000011";
    const secondToken = "00000000-0000-4000-8000-000000000012";
    const reservedAt = new Date("2026-01-01T00:00:00.000Z");
    const retryAt = new Date("2035-01-01T00:00:00.000Z");
    const error = { name: "TransientError", message: "Retry the activity." };
    // Persist two owned reservations so an omitted ID/token predicate cannot hide behind an empty table.
    await client.query(`
      INSERT INTO workflow_task (
        id, execution_id, kind, attempt, available_at, reserved_at, reservation_token
      ) VALUES
        ($1, 'retry-first', 'activity', 3, $3, $3, $4),
        ($2, 'retry-second', 'activity', 4, $3, $3, $5)
    `, [firstId, secondId, reservedAt, firstToken, secondToken]);
    const before = await client.query("SELECT * FROM workflow_task ORDER BY id");

    // A real token belonging to another task must not authorize this task's retry.
    await expect(adapter.retryTask({ taskId: firstId, reservationToken: secondToken, retryAt, error })).resolves.toBe(false);
    expect((await client.query("SELECT * FROM workflow_task ORDER BY id")).rows).toEqual(before.rows);
    await expect(adapter.retryTask({ taskId: firstId, reservationToken: firstToken, retryAt, error })).resolves.toBe(true);
    const after = await client.query("SELECT * FROM workflow_task ORDER BY id");
    expect(after.rows).toEqual([
      { ...before.rows[0], available_at: retryAt, reserved_at: null, reservation_token: null },
      before.rows[1],
    ]);
    // Once ownership is relinquished, the old reservation cannot move the task again.
    await expect(adapter.retryTask({ taskId: firstId, reservationToken: firstToken, retryAt: reservedAt, error })).resolves.toBe(false);
    expect((await client.query("SELECT * FROM workflow_task ORDER BY id")).rows).toEqual(after.rows);
    await expect(adapter.retryTask({ taskId: "00000000-0000-4000-8000-000000000099", reservationToken: secondToken, retryAt, error })).resolves.toBe(false);
  });

  it.each(["timer", "workflow"])("refuses retryTask for an owned %s reservation", async (kind) => {
    const taskId = "00000000-0000-4000-8000-000000000001";
    const reservationToken = "00000000-0000-4000-8000-000000000011";
    await client.query(`
      INSERT INTO workflow_task (id, execution_id, kind, reserved_at, reservation_token)
      VALUES ($1, 'retry-non-activity', $2, now(), $3)
    `, [taskId, kind, reservationToken]);
    const before = await client.query("SELECT * FROM workflow_task");
    await expect(adapter.retryTask({ taskId, reservationToken, retryAt: new Date("2035-01-01T00:00:00.000Z"), error: { name: "TransientError", message: "Retry the activity." } })).resolves.toBe(false);
    expect((await client.query("SELECT * FROM workflow_task")).rows).toEqual(before.rows);
  });

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

  it.each(["reject", "return-existing", "enqueue"] as const)("keeps unkeyed starts separate from a matching business key (%s)", async (conflict) => {
    const unkeyed = startRequest("matching-business-key");
    const keyed = {
      ...startRequest("keyed-execution"),
      concurrency: { keyed: { key: unkeyed.executionId, limit: 1, conflict, scope: "execution" } },
    } as const;
    await expect(adapter.startMany([unkeyed, keyed])).resolves.toMatchObject([
      { created: true, execution: { executionId: unkeyed.executionId, status: "queued", concurrencyAdmitted: true } },
      { created: true, execution: { executionId: keyed.executionId, status: "queued", concurrencyAdmitted: true } },
    ]);
    await expect(database.select().from(testTasks)).resolves.toHaveLength(2);
  });

  it("returns the same execution projection for start, idempotent start and direct lookup", async () => {
    const request = {
      ...startRequest("start-projection"),
      workflowVersion: 4,
      input: null,
      parentExecutionId: "parent",
      parentCommandSequence: 3,
      rootExecutionId: "root",
      concurrency: {
        definitionLimit: 7,
        keyed: { key: "projection", limit: 2, conflict: "enqueue", scope: "active-work" },
      },
    } as const;
    const first = await adapter.start(request);
    expect(first).toMatchObject({
      created: true,
      execution: {
        ...request, historyGeneration: 1, revision: 0, cancellationRequested: false,
        concurrencyAdmitted: true, status: "queued", createdAt: expect.any(Date), updatedAt: expect.any(Date),
      },
    });
    await expect(adapter.get(request.executionId)).resolves.toEqual(first.execution);
    await expect(adapter.start({ ...request, input: { different: true } })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    await expect(adapter.start({ ...request, workflowName: "other.run" })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    await adapter.setPaused(request.executionId, true);
    const paused = await adapter.get(request.executionId);
    expect(paused?.pausedAt).toBeInstanceOf(Date);
    await expect(adapter.start(request)).resolves.toEqual({ created: false, execution: paused });
    await adapter.forceTerminate(request.executionId, "Operator stopped it.");
    const terminal = await adapter.get(request.executionId);
    expect(terminal).toMatchObject({ status: "terminated", completedAt: expect.any(Date), error: { message: "Operator stopped it." } });
    await expect(adapter.start(request)).resolves.toEqual({ created: false, execution: terminal });
  });

  it("rejects incompatible admission metadata for one business key in a start batch", async () => {
    const keyed = { key: "same-key", limit: 1, conflict: "enqueue", scope: "execution" } as const;
    const first = { ...startRequest("compatible-group"), concurrency: { keyed } };
    for (const different of [{ limit: 2 }, { conflict: "reject" as const }, { scope: "active-work" as const }]) {
      const second = { ...startRequest("incompatible-group"), concurrency: { keyed: { ...keyed, ...different } } };
      await expect(adapter.startMany([first, second])).rejects.toThrow("inconsistent concurrency");
    }
    await expect(database.select().from(testExecutions)).resolves.toEqual([]);
    await expect(adapter.startMany([])).resolves.toEqual([]);
    expect(adapter.isRecoverablePollingError({ code: "08006" })).toBe(true);
    expect(adapter.isRecoverablePollingError({ code: "23505" })).toBe(false);
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
    await expect(adapter.sendSignal({ ...signal, executionId: "unknown" })).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await expect(adapter.sendSignal({ ...signal, workflowName: "other.run" })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    await expect(adapter.sendSignal({ ...signal, signalName: "other.signal" })).rejects.toBeInstanceOf(WorkflowSignalConflictError);
    await expect(adapter.sendSignal({ ...signal, payload: { approved: false } })).rejects.toBeInstanceOf(WorkflowSignalConflictError);
    await adapter.forceTerminate(request.executionId);
    await expect(adapter.sendSignal(signal)).resolves.toMatchObject({ accepted: false });
    await expect(adapter.sendSignal({ ...signal, idempotencyKey: "new" })).rejects.toBeInstanceOf(WorkflowExecutionClosedError);
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

  it("rejects continuation with pending work and archives settled history in order", async () => {
    const request = startRequest("continue-ordered-history");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(activation), executionId: request.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 0 } }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const signal = () => adapter.sendSignal({
      executionId: request.executionId, workflowName: request.workflowName,
      signalName: "wake", idempotencyKey: "generation-local", payload: { wake: true },
    });
    const firstSignal = await signal();
    const continuation = await reserveOne("workflow");
    const rotate = { ...toRef(continuation), executionId: request.executionId, expectedRevision: 2, workflowVersion: 2, input: null };
    const history = await adapter.getHistory(request.executionId);
    await expect(adapter.continueAsNew(rotate)).rejects.toThrow("pending command 0");
    await expect(adapter.continueAsNew({ ...rotate, expectedRevision: 1 })).rejects.toBeInstanceOf(WorkflowJournalConflictError);
    await expect(adapter.continueAsNew({ ...rotate, reservationToken: "00000000-0000-0000-0000-000000000000" })).resolves.toBe(false);
    await expect(adapter.continueAsNew({ ...rotate, executionId: "unrelated" })).resolves.toBe(false);
    await expect(adapter.getHistory(request.executionId)).resolves.toEqual(history);
    await expect(adapter.getHistoryArchives(request.executionId)).resolves.toEqual([]);

    const timer = await reserveOne("timer");
    await expect(adapter.completeActivities([{
      ...toRef(timer), executionId: request.executionId, sequence: 0, status: "completed", result: null,
    }])).resolves.toEqual([toRef(timer)]);
    const settled = await adapter.getHistory(request.executionId);
    await expect(adapter.continueAsNew({ ...rotate, expectedRevision: 3 })).resolves.toBe(true);
    await expect(adapter.getHistoryArchives(request.executionId)).resolves.toEqual([{
      executionId: request.executionId, historyGeneration: 1, workflowVersion: 1,
      input: request.input, history: settled, continuedAt: expect.any(Date),
    }]);
    await expect(adapter.getHistory(request.executionId)).resolves.toEqual([]);
    await expect(adapter.loadActivations([toRef(continuation)])).resolves.toEqual([]);
    const secondSignal = await signal();
    expect(secondSignal.accepted).toBe(true);
    expect(secondSignal.id).not.toBe(firstSignal.id);
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
    const recovery = {
      executionId: request.executionId,
      workflowName: request.workflowName,
      workflowVersion: 1,
    };
    for (const invalid of [{ ...recovery, executionId: "missing" }, { ...recovery, workflowName: "other" },
      { ...recovery, workflowVersion: 2 }]) {
      await expect(adapter.recoverVersionBlockedExecution(invalid)).resolves.toBe(false);
    }
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({ status: "blocked", revision: 0 });
    await expect(adapter.recoverVersionBlockedExecution(recovery)).resolves.toBe(true);
    await expect(adapter.recoverVersionBlockedExecution(recovery)).resolves.toBe(false);
    const recovered = await adapter.get(request.executionId);
    expect(recovered).toMatchObject({ status: "queued", revision: 0 });
    expect(recovered).not.toHaveProperty("error");
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

  it("persists a failed capture without a result and queues its replay", async () => {
    const request = startRequest("capture-failed");
    const captureError = { name: "CapturedError", message: "capture failed", stack: "durable stack" };
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);

    await expect(adapter.commitActivation({
      ...toRef(activation), executionId: request.executionId, expectedRevision: snapshot.revision,
      commands: [{ sequence: 0, kind: "capture", target: "captured", payload: null, captureError }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const next = await reserveOne("workflow");
    expect(next.executionId).toBe(request.executionId);
    const history = (await loadOne(next)).history;
    expect(history).toMatchObject([
      { type: "command-scheduled", sequence: 0, kind: "capture", target: "captured", payload: null },
      { type: "command-completed", sequence: 0, completionOrder: 0, error: captureError },
    ]);
    expect(history[1]).not.toHaveProperty("result");
  });

  it("rolls back history and outbox work when a later activation command is rejected", async () => {
    const request = startRequest("atomic-activation-parent");
    const occupied = startRequest("atomic-activation-child");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    await adapter.start(occupied);
    const commit = {
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: 0,
      outcome: { status: "waiting" },
    } as const;
    const activity = {
      sequence: 0, kind: "activity", target: "example.read", payload: null,
    } as const;

    await expect(outboxAdapter.commitActivation({
      ...commit,
      commands: [activity, { sequence: 2, kind: "capture", target: "value", payload: null }],
    })).rejects.toThrow("Expected workflow command sequence 1, received 2.");

    // Match the existing input and definition so parent ownership decides the conflict.
    await expect(outboxAdapter.commitActivation({
      ...commit,
      commands: [activity, {
        sequence: 1,
        kind: "child",
        target: occupied.workflowName,
        payload: { input: occupied.input, version: 1, executionId: occupied.executionId },
      }],
    })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);

    await expect(adapter.getHistory(request.executionId)).resolves.toEqual([]);
    await expect(database.select().from(testDispatchOutbox)).resolves.toEqual([]);
    await expect(adapter.get(occupied.executionId)).resolves.toMatchObject({
      rootExecutionId: occupied.executionId,
      revision: 0,
    });
    await expect(loadOne(activation)).resolves.toMatchObject({ revision: 0 });
    await expect(outboxAdapter.commitActivation({
      ...commit,
      commands: [activity, { sequence: 1, kind: "capture", target: "value", payload: null }],
    })).resolves.toBe(true);
    await expect(database.select().from(testDispatchOutbox)).resolves.toMatchObject([
      { commandSequence: 0, transport: "worker", payload: null },
    ]);
    expect((await database.select().from(testHistory)).map(({ payloadPresent }) => payloadPresent))
      .toEqual([true, true, true]);
  });

  it("rejects malformed command metadata without writing history or timers", async () => {
    const request = startRequest("invalid-command-metadata");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const invalid: [string, WorkflowPayload][] = [
      ["unknown", null], ["timer", null], ["timer", []], ["timer", "duration"],
      ["timer", { durationMs: -1 }], ["timer", { durationMs: 0.5 }], ["signal", { timeoutMs: "soon" }],
      ["child", { version: 1 }], ["child", { version: 1, input: null, executionId: "" }],
      ["child", { version: 1, input: null, executionId: 5 }],
      ["child", { version: 1, input: null, concurrency: [] }],
      ["child", { version: 1, input: null, concurrency: { definitionLimit: 0 } }],
      ["child", { version: 1, input: null, concurrency: { definitionLimit: 1.5 } }],
      ["child", { version: 1, input: null, concurrency: { keyed: true } }],
    ];
    const keyed = { key: "account", limit: 1, conflict: "enqueue", scope: "execution" } as const;
    // The PostgreSQL adapter normalizes every child conflict policy to enqueue.
    for (const patch of [{ key: "" }, { key: 1 }, { limit: 0 }, { limit: 1.5 }, { scope: "unknown" }]) {
      invalid.push(["child", { version: 1, input: null, concurrency: { keyed: { ...keyed, ...patch } } }]);
    }
    for (const [kind, payload] of invalid) {
      await expect(adapter.commitActivation({
        ...toRef(activation), executionId: request.executionId, expectedRevision: 0,
        commands: [{ kind, payload, sequence: 0, target: "invalid" }], outcome: { status: "waiting" },
      })).rejects.toBeInstanceOf(TypeError);
    }
    await expect(loadOne(activation)).resolves.toMatchObject({ history: [], revision: 0 });
    await expect(database.select().from(testTasks)).resolves.toMatchObject([{ id: activation.id, kind: "workflow" }]);
  });

  it("orders synchronous completions and preserves only unmatched timers", async () => {
    const request = startRequest("activation-synchronous-journal");
    await adapter.start(request);
    const otherSignal = await adapter.sendSignal({
      executionId: request.executionId,
      workflowName: request.workflowName,
      signalName: "other.signal",
      payload: "unmatched",
    });
    const approval = await adapter.sendSignal({
      executionId: request.executionId,
      workflowName: request.workflowName,
      signalName: "example.approval",
      payload: null,
    });
    const bonus = await adapter.sendSignal({
      executionId: request.executionId, workflowName: request.workflowName,
      signalName: "bonus.signal", payload: "second buffered result",
    });
    const activation = await reserveOne("workflow");
    const snapshot = await loadOne(activation);

    await expect(adapter.commitActivation({
      ...toRef(activation),
      executionId: request.executionId,
      expectedRevision: snapshot.revision,
      commands: [
        { sequence: 0, kind: "capture", target: "value", payload: { value: 7 } },
        { sequence: 1, kind: "signal", target: "example.approval", payload: { timeoutMs: 10_000 } },
        { sequence: 2, kind: "signal", target: "example.approval", payload: { timeoutMs: 20_000 } },
        { sequence: 3, kind: "signal", target: "other.name", payload: {} },
        { sequence: 4, kind: "timer", target: "sleep", payload: { durationMs: 30_000 } },
        { sequence: 5, kind: "activity", target: "example.read", payload: null },
        { sequence: 6, kind: "signal", target: "bonus.signal", payload: {} },
      ],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);

    const history = await adapter.getHistory(request.executionId);
    expect(history.map(({ eventIndex }) => eventIndex)).toEqual(Array.from({ length: 13 }, (_, index) => index));
    expect(history.filter(({ type }) => type === "command-completed")).toMatchObject([
      { sequence: 0, completionOrder: 0, result: { value: 7 } },
      { sequence: 1, completionOrder: 1, result: null, sourceId: approval.id },
      { sequence: 6, completionOrder: 2, result: "second buffered result", sourceId: bonus.id },
    ]);
    expect(history.find((event) => event.type === "command-scheduled" && event.sequence === 5))
      .toMatchObject({ type: "command-scheduled", sequence: 5, payload: null });
    await expect(database.select().from(testSignals)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: otherSignal.id, consumedAt: null }),
      expect.objectContaining({ id: approval.id, consumedAt: expect.any(Date) }),
      expect.objectContaining({ id: bonus.id, consumedAt: expect.any(Date) }),
    ]));
    const tasks = await database.select().from(testTasks);
    const timers = tasks.filter(({ kind }) => kind === "timer")
      .sort((left, right) => left.commandSequence! - right.commandSequence!);
    expect(timers).toMatchObject([
      { commandSequence: 2, target: "signal:example.approval" },
      { commandSequence: 4, target: "sleep" },
    ]);
    expect(timers.map(({ availableAt }) => availableAt.getTime() - history[3]!.occurredAt.getTime()))
      .toEqual([20_000, 30_000]);
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({ status: "queued", revision: 13 });

    // Replaying the queued activation must leave the still-unmatched commands waiting.
    const next = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(next),
      executionId: request.executionId,
      expectedRevision: 13,
      commands: [],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    await expect(adapter.getHistory(request.executionId)).resolves.toEqual(history);
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({ status: "waiting", revision: 13 });

    const secondApproval = await adapter.sendSignal({
      executionId: request.executionId, workflowName: request.workflowName,
      signalName: "example.approval", payload: { approval: 2 },
    });
    const waiting = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(waiting), executionId: request.executionId, expectedRevision: 14,
      commands: [], outcome: { status: "blocked", error: { name: "WorkflowNondeterminismError", message: "Replay diverged." } },
    })).resolves.toBe(true);
    expect((await adapter.getHistory(request.executionId)).at(-1)).toMatchObject({
      type: "command-completed", sequence: 2, completionOrder: 3, sourceId: secondApproval.id, result: { approval: 2 },
    });
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({ status: "blocked", revision: 15 });
    await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 60_000 })).resolves.toEqual([]);
  });

  it("holds the keyed child-admission lock and grants the retained permit in command order", async () => {
    const request = startRequest("keyed-child-activation");
    await adapter.start(request);
    const parent = await reserveOne("workflow");
    const peer = await pool.connect();
    try {
      await database.transaction(async (transaction) => {
        const owner = new PostgresWorkflowAdapter(
          transaction, {},
          testExecutions as unknown as typeof workflowExecutions,
          testHistory as unknown as typeof workflowHistoryEvents,
          testTasks as unknown as typeof workflowTasks,
          testSignals as unknown as typeof workflowSignals,
          testDispatchOutbox as unknown as typeof workflowDispatchOutbox,
          testHistoryArchives as unknown as typeof workflowHistoryArchives,
        );
        const workflowName = "example.keyed-child";
        const concurrency = { definitionLimit: 2, keyed: { key: "account", limit: 1, conflict: "return-existing", scope: "execution" } };
        await expect(owner.commitActivation({
          ...toRef(parent), executionId: request.executionId, expectedRevision: 0, outcome: { status: "waiting" },
          commands: [0, 1].map((sequence) => ({
            sequence, kind: "child", target: workflowName,
            payload: { version: 2, input: null, concurrency },
          })),
        })).resolves.toBe(true);

        // Observe contention while the real storage transaction still owns the lock.
        const tryLock = (key: string) => peer.query(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired", [key],
        );
        await expect(tryLock(`workflow-key:${workflowName}:account`)).resolves.toMatchObject({ rows: [{ acquired: false }] });
        await expect(tryLock(`workflow-key:${workflowName}:independent`)).resolves.toMatchObject({ rows: [{ acquired: true }] });
        await expect(owner.get(`${request.executionId}:0`)).resolves.toMatchObject({
          status: "queued", concurrencyAdmitted: true, workflowVersion: 2,
          concurrency: { definitionLimit: 2, keyed: { ...concurrency.keyed, conflict: "enqueue" } },
        });
        await expect(owner.get(`${request.executionId}:1`)).resolves.toMatchObject({ status: "pending", concurrencyAdmitted: false });
      });
    } finally {
      peer.release();
    }
    const child = await reserveOne("workflow");
    expect(child.executionId).toBe(`${request.executionId}:0`);
    await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 60_000 })).resolves.toEqual([]);
  });

  it("uses PostgreSQL time to journal commands and schedule delays during generic commits", async () => {
    const request = startRequest("activation-clock-skew");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const clock = () => client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const before = (await clock()).rows[0]!.now;

    // Simulate a host clock behind PostgreSQL. A multi-command activation uses the transaction path.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    try {
      await expect(adapter.commitActivation({
        ...toRef(activation),
        executionId: request.executionId,
        expectedRevision: 0,
        commands: [
          { sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 60_000 } },
          { sequence: 1, kind: "signal", target: "example.approval", payload: { timeoutMs: 120_000 } },
        ],
        outcome: { status: "waiting" },
      })).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const after = (await clock()).rows[0]!.now;
    const history = await adapter.getHistory(request.executionId);
    for (const { occurredAt } of history) {
      expect(occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(occurredAt.getTime()).toBeLessThanOrEqual(after.getTime());
    }
    await expect(adapter.reserveTasks({ kinds: ["timer"], limit: 2, leaseMs: 60_000 }))
      .resolves.toEqual([]);
  });

  it("preserves earlier compensation work when a later activation adds more", async () => {
    const request = startRequest("parallel-compensation");
    await adapter.start(request);
    const commit = async (commands: Parameters<typeof adapter.commitActivation>[0]["commands"]) => {
      const activation = await reserveOne("workflow");
      const snapshot = await loadOne(activation);
      return adapter.commitActivation({
        ...toRef(activation),
        executionId: request.executionId,
        expectedRevision: snapshot.revision,
        commands,
        outcome: { status: "waiting" },
      });
    };
    await expect(commit([{ sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 60_000 } }]))
      .resolves.toBe(true);
    await expect(adapter.requestCancellation(request.executionId)).resolves.toBe(true);
    await expect(commit([
      { sequence: 1, kind: "activity", target: "undo.first", payload: null },
      { sequence: 2, kind: "capture", target: "checkpoint", payload: 1 },
    ])).resolves.toBe(true);

    await expect(commit([{ sequence: 3, kind: "activity", target: "undo.second", payload: null }]))
      .resolves.toBe(true);
    const tasks = await database.select().from(testTasks);
    expect(tasks.sort((left, right) => left.commandSequence! - right.commandSequence!)).toMatchObject([
      { kind: "activity", commandSequence: 1, target: "undo.first" },
      { kind: "activity", commandSequence: 3, target: "undo.second" },
    ]);
  });

  it("keeps a compensation child runnable after a repeated cancellation request", async () => {
    const request = startRequest("cancel-compensation-parent");
    const childId = "cancel-compensation-child";
    await adapter.start(request);
    const initial = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(initial), executionId: request.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 60_000 } }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    await expect(adapter.requestCancellation(request.executionId)).resolves.toBe(true);

    const compensation = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(compensation), executionId: request.executionId, expectedRevision: 2,
      commands: [{ sequence: 1, kind: "child", target: "example.compensate", payload: { input: null, version: 1, executionId: childId } }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const parent = await adapter.get(request.executionId);

    await expect(adapter.requestCancellation(request.executionId)).resolves.toBe(false);
    await expect(adapter.get(request.executionId)).resolves.toEqual(parent);
    await expect(adapter.get(childId)).resolves.toMatchObject({ status: "queued", cancellationRequested: false, revision: 0 });
    await expect(adapter.getHistory(childId)).resolves.toEqual([]);
  });

  it("terminates a cyclic low-level tree once per execution", async () => {
    await adapter.startMany([
      { ...startRequest("cycle-root"), parentExecutionId: "cycle-child", parentCommandSequence: 0 },
      { ...startRequest("cycle-child"), parentExecutionId: "cycle-root", parentCommandSequence: 0 },
    ]);

    // Bound a traversal with its visited-set guard removed without leaving asynchronous work running.
    await expect(countClientQueries(() => adapter.forceTerminate("cycle-root", "close cycle"), 25))
      .resolves.toMatchObject({ result: true });
    for (const id of ["cycle-root", "cycle-child"]) {
      await expect(adapter.get(id)).resolves.toMatchObject({ status: "terminated", revision: 0 });
      await expect(adapter.getHistory(id)).resolves.toEqual([]);
    }
    await expect(database.select().from(testTasks)).resolves.toEqual([]);
  });

  it("terminates orphan, partial and closed-parent links without waking a parent", async () => {
    await adapter.startMany([
      startRequest("terminal-link-parent"),
      { ...startRequest("terminal-link-child"), parentExecutionId: "terminal-link-parent", parentCommandSequence: 0 },
      { ...startRequest("partial-link-child"), parentExecutionId: "terminal-link-parent" },
      { ...startRequest("orphan-link-child"), parentExecutionId: "missing-parent", parentCommandSequence: 0 },
    ]);
    await expect(adapter.forceTerminate("partial-link-child", "close partial link")).resolves.toBe(true);
    const parentTask = (await adapter.reserveTasks({ kinds: ["workflow"], limit: 10, leaseMs: 60_000 }))
      .find(({ executionId }) => executionId === "terminal-link-parent")!;
    await expect(adapter.commitActivation({
      ...toRef(parentTask), executionId: "terminal-link-parent", expectedRevision: 0,
      commands: [], outcome: { status: "failed", error: { name: "ParentFailure", message: "Closed." } },
    })).resolves.toBe(true);
    const closed = await adapter.get("terminal-link-parent");

    await expect(adapter.forceTerminate("terminal-link-child", "close linked child")).resolves.toBe(true);
    await expect(adapter.forceTerminate("orphan-link-child", "close orphan")).resolves.toBe(true);
    await expect(adapter.get("terminal-link-parent")).resolves.toEqual(closed);
    await expect(adapter.getHistory("terminal-link-parent")).resolves.toEqual([]);
  });

  it("dispatches Worker compensation while keeping pre-cancellation outbox work idle", async () => {
    const request = startRequest("outbox-compensation");
    await adapter.start(request);
    const initial = await reserveOne("workflow");
    await expect(outboxAdapter.commitActivation({
      ...toRef(initial), executionId: request.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "effect.original", payload: null }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    await expect(adapter.requestCancellation(request.executionId)).resolves.toBe(true);

    const dispatchOptions = { limit: 10, leaseMs: 1_000 };
    await expect(outboxAdapter.reserveActivityDispatches(dispatchOptions)).resolves.toEqual([]);
    const compensation = await reserveOne("workflow");
    await expect(outboxAdapter.commitActivation({
      ...toRef(compensation), executionId: request.executionId, expectedRevision: 2,
      commands: [{ sequence: 1, kind: "activity", target: "effect.undo", payload: null }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    await expect(outboxAdapter.reserveActivityDispatches(dispatchOptions)).resolves.toMatchObject([
      {
        sequence: 1, target: "effect.undo", historyGeneration: 1,
        availableAt: expect.any(Date), reservedAt: expect.any(Date), createdAt: expect.any(Date),
      },
    ]);
  });

  it.each(["versioned", "legacy"] as const)("fences old Worker results after continue-as-new (%s)", async (format) => {
    const request = startRequest("outbox-generations");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const commit = {
      executionId: request.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "example.read", payload: null }],
      outcome: { status: "waiting" },
    } as const;
    await expect(outboxAdapter.commitActivation({ ...toRef(activation), ...commit })).resolves.toBe(true);
    const [firstDispatch] = await outboxAdapter.reserveActivityDispatches({ limit: 2, leaseMs: 1_000 });
    const previous = { executionId: request.executionId, sequence: 0, sourceId: "old-job", dispatchId: firstDispatch!.id, status: "completed", result: "first" } as const;
    await expect(outboxAdapter.completeExternalActivity(previous)).resolves.toBe(true);

    const rotation = await reserveOne("workflow");
    await expect(adapter.continueAsNew({
      ...toRef(rotation), executionId: request.executionId,
      expectedRevision: 2, workflowVersion: 1, input: null,
    })).resolves.toBe(true);
    const successor = await reserveOne("workflow");
    await expect(outboxAdapter.commitActivation({ ...toRef(successor), ...commit })).resolves.toBe(true);
    const current = await adapter.getHistory(request.executionId);
    await expect(outboxAdapter.completeExternalActivity(previous)).resolves.toBe(true);
    await expect(outboxAdapter.completeExternalActivity({ ...previous, historyGeneration: 1 })).resolves.toBe(true);
    await expect(adapter.getHistory(request.executionId)).resolves.toEqual(current);
    await expect(outboxAdapter.completeExternalActivity({ ...previous, historyGeneration: 3 })).resolves.toBe(false);
    const [currentDispatch] = await outboxAdapter.reserveActivityDispatches({ limit: 2, leaseMs: 1_000 });
    expect(currentDispatch).toMatchObject({ historyGeneration: 2, sequence: 0 });
    await expect(outboxAdapter.completeExternalActivity({ ...previous, dispatchId: currentDispatch!.id, sequence: 99 }))
      .resolves.toBe(true);
    await expect(outboxAdapter.completeExternalActivity({ ...previous, dispatchId: "not-a-postgres-id" }))
      .resolves.toBe(true);
    await expect(adapter.getHistory(request.executionId)).resolves.toEqual(current);
    await expect(outboxAdapter.completeExternalActivity({
      ...previous, ...(format === "versioned" ? { historyGeneration: 2 } : { dispatchId: currentDispatch!.id }),
      sourceId: "new-job", result: "second",
    })).resolves.toBe(true);
    await expect(adapter.getHistory(request.executionId)).resolves.toMatchObject([
      { type: "command-scheduled", sequence: 0 },
      { type: "command-completed", sequence: 0, sourceId: "new-job", result: "second" },
    ]);
  });

  it("records ordered external completions and distinguishes missing work from duplicates", async () => {
    const request = startRequest("external-completion-order");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    await expect(outboxAdapter.commitActivation({
      ...toRef(activation), executionId: request.executionId, expectedRevision: 0,
      commands: [
        { sequence: 0, kind: "activity", target: "first", payload: null },
        { sequence: 1, kind: "activity", target: "second", payload: null },
        { sequence: 2, kind: "timer", target: "sleep", payload: { durationMs: 60_000 } },
      ],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const completion = { executionId: request.executionId, sequence: 0, sourceId: "first-job", status: "completed" } as const;
    await expect(outboxAdapter.completeExternalActivity({ ...completion, executionId: "missing" })).resolves.toBe(false);
    await expect(outboxAdapter.completeExternalActivity({ ...completion, sequence: 2 })).resolves.toBe(false);
    await expect(outboxAdapter.completeExternalActivity(completion)).resolves.toBe(true);
    const error = { name: "ActivityFailure", message: "Failed.", details: { executionId: request.executionId, sequence: 1 } };
    await expect(outboxAdapter.completeExternalActivity({
      executionId: request.executionId, sequence: 1, sourceId: "second-job", status: "failed", error,
    })).resolves.toBe(true);
    await expect(outboxAdapter.completeExternalActivity({ ...completion, result: "duplicate" })).resolves.toBe(true);

    const history = await adapter.getHistory(request.executionId);
    const completed = history.filter(({ type }) => type === "command-completed");
    expect(completed).toMatchObject([
      { sequence: 0, completionOrder: 0, sourceId: "first-job" },
      { sequence: 1, completionOrder: 1, sourceId: "second-job", error },
    ]);
    for (const event of completed) expect(event).not.toHaveProperty("result");
    await expect(adapter.forceTerminate(request.executionId)).resolves.toBe(true);
    await expect(outboxAdapter.completeExternalActivity({ ...completion, sequence: 2 })).resolves.toBe(true);
    await expect(adapter.getHistory(request.executionId)).resolves.toEqual(history);
  });

  it("does not query the database for empty completion and publication batches", async () => {
    const counted = await countClientQueries(async () => [
      await outboxAdapter.completeActivities([]),
      await outboxAdapter.markActivityDispatchesPublished([]),
      await outboxAdapter.retryActivityDispatches([]),
      await adapter.reserveTasks({ kinds: [], limit: 1, leaseMs: 100 }),
      await adapter.loadActivations([]),
    ]);
    expect(counted).toEqual({ count: 0, result: [[], [], [], [], []] });
  });

  it("validates lookup and reservation boundaries before changing persisted work", async () => {
    const missing = "missing-history";
    await expect(adapter.getHistory(missing)).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await expect(adapter.getHistoryArchives(missing)).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    for (const invalid of [0, -1, 0.5, Infinity]) {
      await expect(adapter.listExecutions({ limit: invalid })).rejects.toBeInstanceOf(TypeError);
      await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: invalid, leaseMs: 100 })).rejects.toBeInstanceOf(TypeError);
      await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: invalid })).rejects.toBeInstanceOf(TypeError);
      await expect(outboxAdapter.reserveActivityDispatches({ limit: invalid, leaseMs: 100 })).rejects.toBeInstanceOf(TypeError);
      await expect(outboxAdapter.reserveActivityDispatches({ limit: 1, leaseMs: invalid })).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("only retries and publishes outbox rows with the current lease", async () => {
    const request = startRequest("outbox-lease-generations");
    await adapter.start(request);
    const task = await reserveOne("workflow");
    await expect(outboxAdapter.commitActivation({
      ...toRef(task), executionId: request.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "example.work", payload: null }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const reserve = () => outboxAdapter.reserveActivityDispatches({ limit: 1, leaseMs: 60_000 });
    const [first] = await reserve();
    const firstRef = { dispatchId: first!.id, reservationToken: first!.reservationToken };
    await expect(reserve()).resolves.toEqual([]);

    // Let the store clock reclaim a reservation without an application-side sleep.
    const expire = () => client.query(
      "UPDATE workflow_dispatch_outbox SET available_at = statement_timestamp() - interval '1 second' WHERE id = $1",
      [first!.id],
    );
    await expire();
    const [second] = await reserve();
    expect(second).toMatchObject({ id: first!.id, attempt: 2, payload: null });
    expect(second!.reservationToken).not.toBe(first!.reservationToken);
    const secondRef = { dispatchId: second!.id, reservationToken: second!.reservationToken };
    const { rows: [clock] } = await client.query<{ retry_at: Date }>("SELECT statement_timestamp() + interval '1 hour' AS retry_at");
    const retryAt = clock!.retry_at;
    await expect(outboxAdapter.markActivityDispatchesPublished([firstRef])).resolves.toEqual([]);
    await expect(outboxAdapter.retryActivityDispatches([{ ...firstRef, retryAt }])).resolves.toEqual([]);
    await expect(outboxAdapter.retryActivityDispatches([{ ...secondRef, retryAt }])).resolves.toEqual([secondRef]);
    await expect(database.select().from(testDispatchOutbox)).resolves.toMatchObject([
      { id: first!.id, availableAt: retryAt, attempt: 2, reservationToken: null, reservedAt: null },
    ]);
    await expect(outboxAdapter.markActivityDispatchesPublished([secondRef])).resolves.toEqual([]);
    await expect(reserve()).resolves.toEqual([]);

    await expire();
    const [third] = await reserve();
    const thirdRef = { dispatchId: third!.id, reservationToken: third!.reservationToken };
    await expect(outboxAdapter.markActivityDispatchesPublished([thirdRef])).resolves.toEqual([thirdRef]);
    await expect(database.select().from(testDispatchOutbox)).resolves.toMatchObject([
      { id: first!.id, attempt: 3, reservationToken: null, reservedAt: null, publishedAt: expect.any(Date) },
    ]);
    await expire();
    await expect(reserve()).resolves.toEqual([]);
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
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({
      status: "completed", output: { ok: true }, concurrencyAdmitted: false, completedAt: expect.any(Date),
    });
  });

  it.each([
    { status: "completed" }, { status: "completed", output: null },
    { status: "failed", error: { name: "RootFailure", message: "Failed." } }, { status: "cancelled" },
  ] as const)("commits a simple terminal root in one statement (%#)", async (outcome) => {
    const request = startRequest("simple-terminal-root");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    const committed = await countClientQueries(() => adapter.commitActivation({
      ...toRef(activation), executionId: request.executionId, expectedRevision: 0, commands: [], outcome,
    }));
    expect(committed).toEqual({ count: 1, result: true });
    const execution = await adapter.get(request.executionId);
    expect(execution).toMatchObject({ ...outcome, completedAt: expect.any(Date), concurrencyAdmitted: false });
    if (!("output" in outcome)) expect(execution).not.toHaveProperty("output");
    if (!("error" in outcome)) expect(execution).not.toHaveProperty("error");
    await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 60_000 })).resolves.toEqual([]);
  });

  it("keeps a terminal outcome when its final activation also journals an activity", async () => {
    const request = startRequest("terminal-with-command");
    await adapter.start(request);
    const activation = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(activation), executionId: request.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "activity", target: "work", payload: null }],
      outcome: { status: "completed", output: null },
    })).resolves.toBe(true);
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({ status: "completed", output: null, revision: 1 });
    await expect(adapter.getHistory(request.executionId)).resolves.toMatchObject([{ type: "command-scheduled", sequence: 0 }]);
    await expect(database.select().from(testTasks)).resolves.toEqual([]);
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
      availableAt: expect.any(Date),
      reservedAt: expect.any(Date),
      createdAt: expect.any(Date),
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
    await expect(adapter.commitActivation({
      ...toRef(first), executionId: request.executionId, expectedRevision: 0,
      commands: [], outcome: { status: "completed" },
    })).resolves.toBe(false);
    await expect(loadOne(recovered)).resolves.toMatchObject({ executionId: request.executionId, revision: 0 });
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

  it("keeps completion order for two children of one parent", async () => {
    const request = startRequest("parallel-child-outcomes");
    await adapter.start(request);
    const parent = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(parent), executionId: request.executionId, expectedRevision: 0,
      commands: [0, 1].map((sequence) => ({ sequence, kind: "child", target: "example.child", payload: { input: null, version: 1 } })),
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const children = await adapter.reserveTasks({ kinds: ["workflow"], limit: 2, leaseMs: 60_000 });
    const reverseOrder = [`${request.executionId}:1`, `${request.executionId}:0`];
    for (const id of reverseOrder) {
      await expect(adapter.commitActivation({
        ...toRef(children.find((child) => child.executionId === id)!), executionId: id,
        expectedRevision: 0, commands: [], outcome: { status: "completed", output: id },
      })).resolves.toBe(true);
    }
    const history = await adapter.getHistory(request.executionId);
    expect(history.filter(({ type }) => type === "command-completed")).toMatchObject([
      { sequence: 1, completionOrder: 0, result: reverseOrder[0] },
      { sequence: 0, completionOrder: 1, result: reverseOrder[1] },
    ]);
  });

  it("creates a distinct default child after the parent continues as new", async () => {
    const { executionId, ...definition } = startRequest("repeating-child-parent");
    await adapter.start({ executionId, ...definition });
    const spawnChild = async () => {
      const parent = await reserveOne("workflow");
      await expect(adapter.commitActivation({
        ...toRef(parent), executionId, expectedRevision: 0,
        commands: [{ sequence: 0, kind: "child", target: "example.child", payload: { version: 1, input: null } }],
        outcome: { status: "waiting" },
      })).resolves.toBe(true);
      return reserveOne("workflow");
    };
    const first = await spawnChild();
    expect(first).toMatchObject({ executionId: `${executionId}:0`, parentExecutionId: executionId });
    await expect(adapter.commitActivation({
      ...toRef(first), executionId: first.executionId, expectedRevision: 0,
      commands: [], outcome: { status: "completed", output: null },
    })).resolves.toBe(true);
    const continuation = await reserveOne("workflow");
    await expect(adapter.continueAsNew({
      ...toRef(continuation), executionId, expectedRevision: 2, workflowVersion: 1, input: null,
    })).resolves.toBe(true);

    const second = await spawnChild();
    expect(second).toMatchObject({ executionId: `${executionId}:0:generation-2`, parentExecutionId: executionId });
    await expect(adapter.get(first.executionId)).resolves.toMatchObject({ status: "completed", output: null });
  });

  it.each([
    { outcome: { status: "completed" }, completion: {} },
    { outcome: { status: "completed", output: null }, completion: { result: null } },
    { outcome: { status: "failed", error: { name: "ChildFailure", message: "Child failed." } }, completion: { error: { name: "ChildFailure", message: "Child failed." } } },
    { outcome: { status: "cancelled" }, completion: { error: { name: "WorkflowCancellationError", details: { executionId: "terminal-child" } } } },
  ] as const)("records the exact terminal child outcome in its parent (%#)", async ({ outcome, completion }) => {
    const request = startRequest("terminal-outcome-parent");
    const childId = "terminal-child";
    await adapter.start(request);
    const parent = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(parent), executionId: request.executionId, expectedRevision: 0,
      commands: [{ sequence: 0, kind: "child", target: "example.child", payload: { input: null, version: 1, executionId: childId } }],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const child = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(child), executionId: childId, expectedRevision: 0, commands: [], outcome,
    })).resolves.toBe(true);
    const childState = await adapter.get(childId);
    expect(childState).toMatchObject({ ...outcome, concurrencyAdmitted: false, completedAt: expect.any(Date) });
    if (!("output" in outcome)) expect(childState).not.toHaveProperty("output");
    const parentHistory = await adapter.getHistory(request.executionId);
    expect(parentHistory).toHaveLength(2);
    expect(parentHistory[1]).toMatchObject({ type: "command-completed", sequence: 0, completionOrder: 0, ...completion });
    if (!("result" in completion)) expect(parentHistory[1]).not.toHaveProperty("result");
    if (!("error" in completion)) expect(parentHistory[1]).not.toHaveProperty("error");
    await expect(adapter.get(request.executionId)).resolves.toMatchObject({ status: "queued", revision: 2 });
    await expect(reserveOne("workflow")).resolves.toMatchObject({ executionId: request.executionId });
  });

  it.each(["missing", "terminal"] as const)("completes a low-level child without updating its %s parent", async (parentState) => {
    const parentId = "unavailable-parent";
    if (parentState === "terminal") {
      await adapter.start(startRequest(parentId));
      await adapter.forceTerminate(parentId, "Closed.");
    }
    const before = await adapter.get(parentId);
    const child = { ...startRequest("still-active-child"), parentExecutionId: parentId, parentCommandSequence: 0 };
    await adapter.start(child);
    const activation = await reserveOne("workflow");
    await expect(adapter.commitActivation({
      ...toRef(activation), executionId: child.executionId, expectedRevision: 0,
      commands: [], outcome: { status: "completed", output: null },
    })).resolves.toBe(true);
    await expect(adapter.get(child.executionId)).resolves.toMatchObject({ status: "completed", output: null });
    await expect(adapter.get(parentId)).resolves.toEqual(before);
    await expect(adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 60_000 })).resolves.toEqual([]);
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

  it("searches execution, definition and key text as literal substrings", async () => {
    await adapter.startMany([
      startRequest("literal-Mix_%"),
      { ...startRequest("definition-match"), workflowName: "definition.mix_%" },
      { ...startRequest("key-match"), concurrency: { keyed: { key: "key-MIX_%", limit: 1, conflict: "enqueue", scope: "execution" } } },
      startRequest("literal-Mix-ordinary"),
      startRequest("literal\\slash"),
    ]);
    const matches = await adapter.listExecutions({ search: "mIx_%", limit: 10 });
    expect(matches.items.map(({ executionId }) => executionId).sort())
      .toEqual(["definition-match", "key-match", "literal-Mix_%"]);
    const slash = await adapter.listExecutions({ search: "\\", limit: 10 });
    expect(slash.items.map(({ executionId }) => executionId)).toEqual(["literal\\slash"]);
  });

  it("polls a nonterminal execution until the first terminal snapshot", async () => {
    const request = startRequest("terminal-poll");
    await expect(adapter.waitForTerminal("unknown-terminal-poll")).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    const { execution } = await adapter.start(request);
    const terminal = { ...execution, status: "completed" as const, output: null };
    const get = vi.spyOn(adapter, "get")
      .mockResolvedValueOnce(execution)
      .mockResolvedValueOnce(terminal)
      .mockRejectedValue(new Error("Polling did not stop after a terminal result."));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let observed: unknown;
      void adapter.waitForTerminal(request.executionId).then(
        (result) => { observed = result; }, (error: unknown) => { observed = error; },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledExactlyOnceWith(request.executionId);
      expect(observed).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(get).toHaveBeenCalledTimes(2);
      expect(observed).toBe(terminal);
    } finally {
      vi.useRealTimers();
      get.mockRestore();
    }
  });

  it("combines identity, lineage, status and inclusive time filters", async () => {
    const base = {
      ...startRequest("match"), workflowName: "qualified.run", workflowVersion: 3,
      parentExecutionId: "parent", rootExecutionId: "root",
    };
    const boundary = new Date("2026-01-01T00:00:00.000Z");
    const variants = [base,
      { ...base, executionId: "wrong-definition", workflowName: "other.run" },
      { ...base, executionId: "wrong-version", workflowVersion: 4 },
      { ...base, executionId: "wrong-parent", parentExecutionId: "other-parent" },
      { ...base, executionId: "wrong-root", rootExecutionId: "other-root" },
      ...["wrong-retry", "wrong-status", "unpaused", "too-old", "too-new"].map((executionId) => ({ ...base, executionId })),
    ];
    await adapter.startMany(variants);
    await client.query(`
      UPDATE workflow_execution
      SET retry_of_execution_id = CASE WHEN id = 'wrong-retry' THEN 'other-source' ELSE 'source' END,
          status = CASE WHEN id = 'wrong-status' THEN 'waiting' ELSE 'queued' END,
          paused_at = CASE WHEN id = 'unpaused' THEN NULL ELSE $1::timestamptz END,
          created_at = CASE WHEN id = 'too-old' THEN $1::timestamptz - interval '1 second'
                            WHEN id = 'too-new' THEN $1::timestamptz + interval '1 second' ELSE $1::timestamptz END
    `, [boundary]);

    await expect(adapter.listExecutions({
      workflowNames: [base.workflowName], workflowVersions: [base.workflowVersion], statuses: ["queued"],
      parentExecutionId: "parent", rootExecutionId: "root", retryOfExecutionId: "source", paused: true,
      createdAfter: boundary, createdBefore: boundary, limit: 100,
    })).resolves.toEqual({ items: [await adapter.get(base.executionId)] });
    const unpaused = await adapter.listExecutions({ paused: false, limit: 1 });
    expect(unpaused.items.map(({ executionId }) => executionId)).toEqual(["unpaused"]);
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

function qualifiedWorkflowAdapter(connection: PostgresWorkflowDatabase): PostgresWorkflowAdapter {
  return new PostgresWorkflowAdapter(
    connection,
    {},
    qualifiedExecutions as unknown as typeof workflowExecutions,
    qualifiedHistory as unknown as typeof workflowHistoryEvents,
    qualifiedTasks as unknown as typeof workflowTasks,
    testSignals as unknown as typeof workflowSignals,
    testDispatchOutbox as unknown as typeof workflowDispatchOutbox,
    testHistoryArchives as unknown as typeof workflowHistoryArchives,
  );
}

async function seedFailedQualifiedExecution(id: string, key?: string): Promise<void> {
  // Seed only the terminal source. The two contending executions use the
  // adapter's normal entry points and write shared, schema-qualified rows.
  await client.query(`
    INSERT INTO ${qualifiedSchemaName}.execution (
      id, workflow_name, workflow_version, status, root_execution_id,
      concurrency_key, concurrency_key_limit, concurrency_conflict, concurrency_scope
    )
    VALUES (
      $1, $2, 1, 'failed', $1, $3, $4, $5, $6
    )
  `, [
    id, startRequest(id).workflowName, key ?? null,
    key === undefined ? null : 1,
    key === undefined ? null : "enqueue",
    key === undefined ? null : "execution",
  ]);
}

async function raceQualifiedTransactions<First, Second>(
  hold: (owner: PostgresWorkflowAdapter) => Promise<First>,
  contend: (contender: PostgresWorkflowAdapter) => Promise<Second>,
): Promise<{ first: First; second: PromiseSettledResult<Second>; blockedBy: string }> {
  const peer = await pool.connect();
  let pending: Promise<PromiseSettledResult<Second>> | undefined;
  try {
    // Bound unexpected SQL stalls independently of the test runner's timeout.
    await peer.query("SET statement_timeout = '2s'");
    const [ownerPid, peerPid] = await Promise.all(
      [client, peer].map(async (connection) => (await connection.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      )).rows[0]!.pid),
    );

    const observation = await database.transaction(async (transaction) => {
      // The adapter's nested transaction releases its savepoint, but the outer
      // transaction still owns the inserted rows and advisory locks.
      const first = await hold(qualifiedWorkflowAdapter(transaction));
      let settled = false;
      pending = Promise.allSettled([contend(qualifiedWorkflowAdapter(drizzle(peer)))])
        .then(([result]) => {
          settled = true;
          return result!;
        });
      const blockedBy = await observeCompetingTransaction(ownerPid!, peerPid!, () => settled);
      return { first, blockedBy };
    });

    return { ...observation, second: await pending! };
  } finally {
    try {
      // The outer transaction has committed or rolled back by this point.
      // Drain the peer before releasing its connection or truncating the tables.
      await pending;
    } finally {
      peer.release(true);
    }
  }
}

async function observeCompetingTransaction(
  ownerPid: number,
  peerPid: number,
  settled: () => boolean,
): Promise<string> {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    if (settled()) return "settled";
    // Observe the PostgreSQL wait for these exact sessions. Polling only
    // samples the server state, so no fixed delay establishes the race.
    const result = await pool.query<{ locktype: string }>(`
      SELECT locktype FROM pg_locks
      WHERE pid = $1 AND NOT granted AND $2 = ANY (pg_blocking_pids(pid))
    `, [peerPid, ownerPid]);
    if (result.rows[0] !== undefined) return result.rows[0].locktype;
    await pause(5);
  }
  throw new Error("The competing workflow transaction neither settled nor waited for the owner.");
}

/** Counts driver round trips and always restores the shared test client. */
async function countClientQueries<Result>(
  run: () => Promise<Result>,
  maximum = Infinity,
): Promise<{ count: number; result: Result }> {
  const originalQuery = client.query;
  let count = 0;
  client.query = ((...arguments_: unknown[]) => {
    count += 1;
    if (count === maximum + 1) throw new Error(`Workflow adapter exceeded ${maximum} queries.`);
    return Reflect.apply(originalQuery, client, arguments_);
  }) as typeof client.query;

  try {
    const result = await run();
    return { count, result };
  } finally {
    client.query = originalQuery;
  }
}
