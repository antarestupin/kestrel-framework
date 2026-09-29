import {
  bigint,
  index,
  integer,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { defineDatabaseTableDescriptions } from "../../db/schema_contributions/descriptions.js";
import { devSchema } from "../../db/dev_schema.js";

// This development-only table remains excluded from deployed migrations and
// application schema aggregation.
export const logs = devSchema.table(
  "log",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    loggedAt: timestamp("logged_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    level: integer("level").notNull(),
    message: text("message"),
    requestId: text("request_id"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("log_logged_at_idx").on(table.loggedAt),
    index("log_level_logged_at_idx").on(
      table.level,
      table.loggedAt,
    ),
  ],
);

defineDatabaseTableDescriptions(logs, {
  description: "Disposable structured log records captured for local development and Studio inspection.",
  columns: {
    id: "Monotonically increasing storage identifier of the log record.",
    loggedAt: "Date and time reported by the logging event.",
    level: "Numeric severity level assigned by the logger.",
    message: "Optional human-readable log message.",
    requestId: "Optional request identifier used to correlate related log records.",
    payload: "Structured JSON fields attached to the log record.",
    createdAt: "Date and time when the log record was persisted.",
  },
});

export type DevLog = typeof logs.$inferSelect;
export type NewDevLog = typeof logs.$inferInsert;
