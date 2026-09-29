import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { defineDatabaseTableDescriptions } from "../../db/schema_contributions/descriptions.js";
import { devSchema } from "../../db/dev_schema.js";
import type { ObservationData } from "../definitions.js";
import type { ObservationOutcome } from "../observer.js";

// Observations are disposable development data and never enter app migrations.
export const observations = devSchema.table(
  "observation",
  {
    sequence: bigint("sequence", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    id: uuid("id").notNull(),
    executionId: text("execution_id").notNull(),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    outcome: text("outcome").$type<ObservationOutcome>(),
    durationMs: doublePrecision("duration_ms"),
    data: jsonb("data").$type<ObservationData>().notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("observation_id_idx").on(table.id),
    index("observation_execution_timeline_idx").on(
      table.executionId,
      table.occurredAt,
      table.sequence,
    ),
    index("observation_occurred_at_idx").on(table.occurredAt),
    index("observation_category_occurred_at_idx").on(
      table.category,
      table.occurredAt,
    ),
    index("observation_name_occurred_at_idx").on(
      table.name,
      table.occurredAt,
    ),
  ],
);

defineDatabaseTableDescriptions(observations, {
  description: "Disposable structured observations captured for local development and execution tracing.",
  columns: {
    sequence: "Monotonically increasing storage order of the observation.",
    id: "Globally unique public identifier of the observation.",
    executionId: "Identifier that correlates observations belonging to one logical execution.",
    occurredAt: "Date and time when the observed event occurred.",
    name: "Stable definition name of the observed event.",
    category: "High-level category used to group observations.",
    schemaVersion: "Version of the observation data contract used by this record.",
    outcome: "Optional success or failure outcome of the observed operation.",
    durationMs: "Optional duration of the observed operation in milliseconds.",
    data: "Definition-specific structured JSON data attached to the observation.",
    createdAt: "Date and time when the observation was persisted.",
  },
});

export type StoredObservation = typeof observations.$inferSelect;
export type NewStoredObservation = typeof observations.$inferInsert;
