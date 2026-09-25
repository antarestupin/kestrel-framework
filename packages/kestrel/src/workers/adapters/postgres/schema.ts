import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  defineDatabaseSchemaDescription,
  defineDatabaseTableDescriptions,
} from "../../../db/schema_contributions/descriptions.js";
import type {
  WorkerJobCorrelation,
  WorkerJobError,
} from "../../types.js";

export const workersSchema = defineDatabaseSchemaDescription(
  pgSchema("workers"),
  "Durable background jobs, queue controls, leases, and dead-letter records.",
);

/** Durable operator overrides for queue consumption. */
export const workerQueueControls = workersSchema.table(
  "queue_control",
  {
    queue: text("queue").primaryKey(),
    enabled: boolean("enabled").default(true).notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  },
);

defineDatabaseTableDescriptions(workerQueueControls, {
  description: "Durable operator controls that enable or pause consumption for individual queues.",
  columns: {
    queue: "Stable name of the controlled worker queue.",
    enabled: "Whether workers may reserve jobs from the queue.",
    updatedAt: "Date and time when the queue control was last changed.",
  },
});

/** Durable jobs whose availability timestamp also represents their lease. */
export const workerJobs = workersSchema.table(
  "job",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    identity: text("identity"),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    correlation: jsonb("correlation").$type<WorkerJobCorrelation>(),
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
    state: text("state")
      .$type<"pending" | "reserved">()
      .default("pending")
      .notNull(),
    lastError: jsonb("last_error").$type<WorkerJobError>(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("job_identity_unique_idx")
      .on(table.identity)
      .where(sql`${table.identity} IS NOT NULL`),
    index("job_reservation_idx").on(
      table.queue,
      table.availableAt,
      table.id,
    ),
    index("job_reserved_hint_idx")
      .on(table.queue, table.availableAt)
      .where(sql`${table.state} = 'reserved'`),
  ],
);

defineDatabaseTableDescriptions(workerJobs, {
  description: "Active durable background jobs whose availability timestamp also represents reservation expiry.",
  columns: {
    id: "Stable identifier of the job.",
    identity: "Optional unique application-defined identity used to deduplicate job creation.",
    queue: "Queue from which workers may reserve the job.",
    payload: "Application-defined input delivered to the job handler.",
    correlation: "Optional metadata used to correlate completion with an external workflow or caller.",
    groupId: "Optional application-defined scheduling group reserved for grouped queue policies.",
    executionId: "Optional identifier correlating the first execution attempt with observability data.",
    attempt: "Number of handler execution attempts started for the job.",
    availableAt: "Date and time when the job becomes eligible for reservation, or when its current lease expires.",
    reservedAt: "Date and time when the current reservation was acquired.",
    reservationToken: "Current ownership token used to reject stale worker updates.",
    state: "Current active-job state: pending or reserved.",
    lastError: "Structured error produced by the most recent retryable failure.",
    createdAt: "Date and time when the job was created.",
  },
});

/** Terminal failed jobs kept separately from the active reservation table. */
export const workerDeadLetterJobs = workersSchema.table(
  "dead_letter_queue",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    originalJobId: uuid("original_job_id").notNull(),
    identity: text("identity"),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    correlation: jsonb("correlation").$type<WorkerJobCorrelation>(),
    groupId: text("group_id"),
    executionId: uuid("execution_id"),
    attempt: integer("attempt").notNull(),
    error: jsonb("error").$type<WorkerJobError>().notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    failedAt: timestamp("failed_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    index("dead_letter_queue_queue_failed_idx").on(
      table.queue,
      table.failedAt,
    ),
    index("dead_letter_queue_original_job_idx").on(table.originalJobId),
  ],
);

defineDatabaseTableDescriptions(workerDeadLetterJobs, {
  description: "Terminally failed jobs retained separately from the active reservation table.",
  columns: {
    id: "Stable identifier of the dead-letter record.",
    originalJobId: "Identifier used by the job while it was in the active queue.",
    identity: "Optional application-defined deduplication identity copied from the original job.",
    queue: "Queue in which the original job was processed.",
    payload: "Application-defined input copied from the original job.",
    correlation: "Optional completion-correlation metadata copied from the original job.",
    groupId: "Optional scheduling group copied from the original job.",
    executionId: "Optional observability execution identifier copied from the original job.",
    attempt: "Number of handler attempts made before the job became terminal.",
    error: "Structured terminal error that caused the job to be dead-lettered.",
    createdAt: "Date and time when the original job was created.",
    failedAt: "Date and time when the job moved to the dead-letter queue.",
  },
});

export type PostgresWorkerJob = typeof workerJobs.$inferSelect;
export type PostgresDeadLetterJob = typeof workerDeadLetterJobs.$inferSelect;
export type PostgresWorkerQueueControl = typeof workerQueueControls.$inferSelect;
