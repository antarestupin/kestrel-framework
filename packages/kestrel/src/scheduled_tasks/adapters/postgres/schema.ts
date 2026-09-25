import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import {
  defineDatabaseSchemaDescription,
  defineDatabaseTableDescriptions,
} from "../../../db/schema_contributions/descriptions.js";
import type { ScheduledTaskError } from "../../types.js";

export const scheduledTasksSchema = defineDatabaseSchemaDescription(
  pgSchema("scheduled_tasks"),
  "Durable schedules, operator controls, and active scheduled-task reservations.",
);

/** Durable schedule, operator controls and latest execution summary. */
export const scheduledTaskStates = scheduledTasksSchema.table(
  "state",
  {
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
    lastError: jsonb("last_error").$type<ScheduledTaskError>(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    index("state_due_idx").on(table.paused, table.nextScheduledAt),
  ],
);

defineDatabaseTableDescriptions(scheduledTaskStates, {
  description: "Durable schedule, operator controls, and latest execution summary for each registered task.",
  columns: {
    taskId: "Stable identifier of the registered scheduled-task definition.",
    paused: "Whether automatic scheduling is paused by an operator.",
    nextScheduledAt: "Date and time of the next automatic occurrence, or null when none is scheduled.",
    manualRunRequestedAt: "Date and time of the outstanding coalesced manual-run request, if any.",
    lastStartedAt: "Date and time when the task most recently started.",
    lastCompletedAt: "Date and time when the task most recently completed.",
    lastOutcome: "Outcome of the most recently completed task run.",
    lastError: "Structured error produced by the most recent failed task run.",
    updatedAt: "Date and time when this scheduling state was last updated.",
  },
});

/** Active occurrence reservations retained until completion or lease expiry. */
export const scheduledTaskRuns = scheduledTasksSchema.table(
  "run",
  {
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
  },
  (table) => [
    index("run_task_expires_idx").on(table.taskId, table.expiresAt),
  ],
);

defineDatabaseTableDescriptions(scheduledTaskRuns, {
  description: "Active scheduled-task occurrence reservations retained until completion or lease expiry.",
  columns: {
    reservationToken: "Unique ownership token required to complete the reserved occurrence.",
    taskId: "Scheduled-task definition associated with the occurrence.",
    scheduledAt: "Logical date and time assigned to the occurrence.",
    reservedAt: "Date and time when the current execution lease was acquired.",
    expiresAt: "Date and time when the execution lease becomes available for recovery.",
    trigger: "Whether the occurrence came from the schedule or a manual request.",
    attempt: "Number of times this occurrence has been reserved for execution.",
  },
});

export type PostgresScheduledTaskState = typeof scheduledTaskStates.$inferSelect;
export type PostgresScheduledTaskRun = typeof scheduledTaskRuns.$inferSelect;
