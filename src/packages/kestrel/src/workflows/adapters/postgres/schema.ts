import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  defineDatabaseSchemaDescription,
  defineDatabaseTableDescriptions,
} from "../../../db/schema_contributions/descriptions.js";
import type { WorkflowExecutionError } from "../../errors.js";
import type { WorkflowPayload } from "../../serialization.js";

export const workflowsSchema = defineDatabaseSchemaDescription(
  pgSchema("workflows"),
  "Durable workflow executions, replay history, work queues, signals, and dispatch state.",
);

/** Durable workflow identity, pinned version, result, and replay revision. */
export const workflowExecutions = workflowsSchema.table(
  "execution",
  {
    id: text("id").primaryKey(),
    workflowName: text("workflow_name").notNull(),
    workflowVersion: integer("workflow_version").notNull(),
    historyGeneration: integer("history_generation").default(1).notNull(),
    // Nullable SQL storage represents the valid durable JSON value `null`.
    input: jsonb("input").$type<WorkflowPayload>(),
    /** Original request payload retained when current input continues as new. */
    initialInput: jsonb("initial_input").$type<{
      value: WorkflowPayload;
    }>(),
    status: text("status").$type<
      | "blocked"
      | "cancelled"
      | "cancelling"
      | "completed"
      | "failed"
      | "pending"
      | "queued"
      | "running"
      | "terminated"
      | "waiting"
    >().notNull(),
    output: jsonb("output").$type<WorkflowPayload>(),
    outputPresent: boolean("output_present").default(false).notNull(),
    error: jsonb("error").$type<WorkflowExecutionError>(),
    cancellationRequested: boolean("cancellation_requested")
      .default(false).notNull(),
    pausedAt: timestamp("paused_at", {
      mode: "date",
      withTimezone: true,
    }),
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
    concurrencyAdmitted: boolean("concurrency_admitted")
      .default(true).notNull(),
    revision: integer("revision").default(0).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    index("execution_status_updated_idx").on(table.status, table.updatedAt),
    index("execution_definition_version_idx").on(
      table.workflowName,
      table.workflowVersion,
      table.status,
    ),
    index("execution_parent_idx").on(table.parentExecutionId, table.createdAt),
    index("execution_root_idx").on(table.rootExecutionId, table.createdAt),
    index("execution_retry_idx").on(table.retryOfExecutionId),
  ],
);

defineDatabaseTableDescriptions(workflowExecutions, {
  description: "Durable workflow identity, pinned definition, lifecycle state, result, and replay revision.",
  columns: {
    id: "Stable application-defined identifier of the workflow execution.",
    workflowName: "Registered workflow definition name pinned by the execution.",
    workflowVersion: "Registered workflow definition version pinned for deterministic replay.",
    historyGeneration: "Current replay-history generation, incremented when the workflow continues as new.",
    input: "JSON input for the current history generation; SQL null represents the valid JSON value null.",
    initialInput: "Original request input retained after the current execution continues as new.",
    status: "Current durable lifecycle state of the workflow execution.",
    output: "JSON result produced by a completed workflow.",
    outputPresent: "Whether the output column contains an explicit result, including the valid JSON value null.",
    error: "Structured terminal error produced by a failed, cancelled, or terminated execution.",
    cancellationRequested: "Whether cancellation has been durably requested for the execution.",
    pausedAt: "Date and time when the execution was paused, or null while it is not paused.",
    parentExecutionId: "Parent workflow execution that scheduled this child execution.",
    parentCommandSequence: "Sequence of the parent command that scheduled this child execution.",
    rootExecutionId: "Identifier of the root execution in this workflow tree.",
    retryOfExecutionId: "Previous execution for which this execution is a retry.",
    definitionConcurrencyLimit: "Concurrency limit persisted from the workflow definition at creation time.",
    concurrencyKey: "Optional application-defined key used to partition concurrency admission.",
    concurrencyKeyLimit: "Concurrency limit persisted for the selected concurrency key.",
    concurrencyConflict: "Persisted policy applied when the execution cannot be admitted immediately.",
    concurrencyScope: "Persisted scope that determines how long the concurrency permit is held.",
    concurrencyAdmitted: "Whether the execution currently holds its required concurrency permit.",
    revision: "Optimistic revision incremented with each atomic workflow journal update.",
    createdAt: "Date and time when the workflow execution was created.",
    updatedAt: "Date and time when the workflow execution was last updated.",
    completedAt: "Date and time when the workflow reached a terminal state.",
  },
});

/** Immutable snapshots rotated out by continue-as-new. */
export const workflowHistoryArchives = workflowsSchema.table(
  "history_archive",
  {
    executionId: text("execution_id").notNull(),
    historyGeneration: integer("history_generation").notNull(),
    workflowVersion: integer("workflow_version").notNull(),
    input: jsonb("input").$type<WorkflowPayload>(),
    history: jsonb("history").$type<unknown>().notNull(),
    continuedAt: timestamp("continued_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.executionId, table.historyGeneration] }),
  ],
);

defineDatabaseTableDescriptions(workflowHistoryArchives, {
  description: "Immutable replay-history snapshots rotated out when an execution continues as new.",
  columns: {
    executionId: "Workflow execution to which the archived generation belongs.",
    historyGeneration: "Archived history generation number.",
    workflowVersion: "Workflow definition version used to replay the archived generation.",
    input: "JSON input supplied to the archived history generation.",
    history: "Immutable serialized event history for the archived generation.",
    continuedAt: "Date and time when the generation was archived by continue-as-new.",
  },
});

/** Immutable ordered event history used as replay truth. */
export const workflowHistoryEvents = workflowsSchema.table(
  "history_event",
  {
    executionId: text("execution_id").notNull(),
    eventIndex: integer("event_index").notNull(),
    type: text("type").$type<
      | "cancellation-requested"
      | "command-completed"
      | "command-scheduled"
      | "signal-received"
    >().notNull(),
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
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.executionId, table.eventIndex] }),
    uniqueIndex("history_command_schedule_idx")
      .on(table.executionId, table.commandSequence)
      .where(sql`${table.type} = 'command-scheduled'`),
    uniqueIndex("history_command_completion_idx")
      .on(table.executionId, table.commandSequence)
      .where(sql`${table.type} = 'command-completed'`),
  ],
);

defineDatabaseTableDescriptions(workflowHistoryEvents, {
  description: "Immutable ordered workflow events that form the source of truth for deterministic replay.",
  columns: {
    executionId: "Workflow execution to which the event belongs.",
    eventIndex: "Zero-based position of the event in the execution's current history generation.",
    type: "Durable workflow event category.",
    commandSequence: "Deterministic sequence of the workflow command associated with the event.",
    completionOrder: "Durable order in which concurrently outstanding commands completed.",
    commandKind: "Kind of workflow command scheduled or completed by the event.",
    target: "Registered activity, timer, or child-workflow target associated with the event.",
    signalId: "Identifier of the external signal represented by the event.",
    signalName: "Registered signal name represented by the event.",
    payload: "JSON input, result, or signal payload carried by the event.",
    payloadPresent: "Whether the payload column contains an explicit value, including the valid JSON value null.",
    error: "Structured command error carried by a completion event.",
    sourceId: "Stable source identifier used to trace or deduplicate the event's origin.",
    occurredAt: "Date and time when the event was durably recorded.",
  },
});

/** Runnable workflow activations and embedded activity work. */
export const workflowTasks = workflowsSchema.table(
  "task",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    executionId: text("execution_id").notNull(),
    kind: text("kind").$type<"activity" | "timer" | "workflow">().notNull(),
    commandSequence: integer("command_sequence"),
    target: text("target"),
    payload: jsonb("payload").$type<WorkflowPayload>(),
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
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    index("task_reservation_idx").on(table.kind, table.availableAt, table.id),
    index("task_execution_idx").on(table.executionId, table.kind),
    uniqueIndex("task_workflow_wakeup_idx")
      .on(table.executionId)
      .where(sql`${table.kind} = 'workflow'`),
  ],
);

defineDatabaseTableDescriptions(workflowTasks, {
  description: "Runnable workflow activations, timers, and embedded activity work protected by expiring reservations.",
  columns: {
    id: "Stable identifier of the workflow task.",
    executionId: "Workflow execution that owns the task.",
    kind: "Kind of runnable work represented by the task.",
    commandSequence: "Deterministic command sequence associated with activity or timer work.",
    target: "Registered activity or workflow target associated with the task.",
    payload: "JSON input delivered to the runnable work.",
    attempt: "Number of execution attempts started for the task.",
    availableAt: "Date and time when the task becomes eligible for reservation, or when its current lease expires.",
    reservedAt: "Date and time when the current reservation was acquired.",
    reservationToken: "Current ownership token used to reject stale task updates.",
    createdAt: "Date and time when the task was created.",
  },
});

/** Validated external messages retained independently from consumption. */
export const workflowSignals = workflowsSchema.table(
  "signal",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    executionId: text("execution_id").notNull(),
    name: text("name").notNull(),
    // Nullable SQL storage represents the valid durable JSON value `null`.
    payload: jsonb("payload").$type<WorkflowPayload>(),
    idempotencyKey: text("idempotency_key"),
    receivedAt: timestamp("received_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
    consumedAt: timestamp("consumed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex("signal_execution_idempotency_idx")
      .on(table.executionId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("signal_consumption_idx").on(
      table.executionId,
      table.name,
      table.receivedAt,
    ),
  ],
);

defineDatabaseTableDescriptions(workflowSignals, {
  description: "Validated external workflow messages retained independently from their consumption history.",
  columns: {
    id: "Stable identifier of the signal.",
    executionId: "Workflow execution that receives the signal.",
    name: "Registered signal name used by workflow code to await the message.",
    payload: "Validated JSON payload supplied with the signal.",
    idempotencyKey: "Optional caller-provided key used to deduplicate signals within an execution.",
    receivedAt: "Date and time when the signal was accepted and stored.",
    consumedAt: "Date and time when the signal was incorporated into workflow history.",
  },
});

/** Transactional publication seam for non-embedded activity transports. */
export const workflowDispatchOutbox = workflowsSchema.table(
  "dispatch_outbox",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    executionId: text("execution_id").notNull(),
    commandSequence: integer("command_sequence").notNull(),
    target: text("target").notNull(),
    transport: text("transport").notNull(),
    payload: jsonb("payload").$type<WorkflowPayload>(),
    availableAt: timestamp("available_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", {
      mode: "date",
      withTimezone: true,
    }),
    reservedAt: timestamp("reserved_at", {
      mode: "date",
      withTimezone: true,
    }),
    reservationToken: uuid("reservation_token"),
    attempt: integer("attempt").default(0).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("dispatch_outbox_command_idx").on(
      table.executionId,
      table.commandSequence,
      table.transport,
    ),
    index("dispatch_outbox_available_idx").on(
      table.publishedAt,
      table.availableAt,
    ),
  ],
);

defineDatabaseTableDescriptions(workflowDispatchOutbox, {
  description: "Transactional publication outbox for activities dispatched through non-embedded transports.",
  columns: {
    id: "Stable identifier of the dispatch record.",
    executionId: "Workflow execution that scheduled the activity command.",
    commandSequence: "Deterministic sequence of the activity command within the workflow execution.",
    target: "Registered activity target to invoke.",
    transport: "Configured transport responsible for publishing the activity.",
    payload: "JSON input to publish with the activity command.",
    availableAt: "Date and time when the record becomes eligible for publication or retry.",
    publishedAt: "Date and time when publication completed successfully.",
    reservedAt: "Date and time when the current publication reservation was acquired.",
    reservationToken: "Current ownership token used to reject stale publisher updates.",
    attempt: "Number of publication attempts started for the dispatch record.",
    createdAt: "Date and time when the dispatch record was created.",
  },
});

export type PostgresWorkflowExecution = typeof workflowExecutions.$inferSelect;
export type PostgresWorkflowHistoryArchive =
  typeof workflowHistoryArchives.$inferSelect;
export type PostgresWorkflowHistoryEvent = typeof workflowHistoryEvents.$inferSelect;
export type PostgresWorkflowTask = typeof workflowTasks.$inferSelect;
export type PostgresWorkflowSignal = typeof workflowSignals.$inferSelect;
export type PostgresWorkflowDispatchOutbox =
  typeof workflowDispatchOutbox.$inferSelect;
