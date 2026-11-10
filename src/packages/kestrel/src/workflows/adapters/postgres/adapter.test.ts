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
  WorkflowExecutionConflictError,
  WorkflowExecutionNotFoundError,
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
