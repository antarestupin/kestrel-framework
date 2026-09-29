import {
  boolean,
  doublePrecision,
  index,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { defineDatabaseTableDescriptions } from "../db/schema_contributions/descriptions.js";
import { utilsSchema } from "../db/utils_schema.js";

/** Exact continuously-refilled token buckets shared by all app processes. */
export const throttlingRateLimits = utilsSchema.table(
  "throttling_rate_limit",
  {
    key: text("key").primaryKey(),
    limit: doublePrecision("limit").notNull(),
    periodMs: doublePrecision("period_ms").notNull(),
    burst: doublePrecision("burst").notNull(),
    // Coordination is part of the persisted definition so replicas cannot
    // apply incompatible exact and leased guarantees to the same key.
    coordinationStrategy: text("coordination_strategy").notNull().default("exact"),
    maxLeaseUnits: doublePrecision("max_lease_units"),
    leaseMs: doublePrecision("lease_ms"),
    maxOutstandingUnits: doublePrecision("max_outstanding_units"),
    guardBandUnits: doublePrecision("guard_band_units"),
    // Reconciliation may make this negative to preserve underestimated usage.
    tokens: doublePrecision("tokens").notNull(),
    refilledAt: timestamp("refilled_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    // A full bucket has no history that can affect a future reservation.
    fullAt: timestamp("full_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    // Returning the decision makes one atomic UPDATE self-describing.
    lastAdmitted: boolean("last_admitted").notNull(),
  },
  (table) => [
    index("throttling_rate_limit_full_at_idx").on(table.fullAt),
  ],
);

defineDatabaseTableDescriptions(throttlingRateLimits, {
  description: "Continuously refilled token buckets shared by all application processes.",
  columns: {
    key: "Application-defined identifier of the rate limit.",
    limit: "Number of units replenished during each configured period.",
    periodMs: "Refill period duration in milliseconds.",
    burst: "Maximum number of units the bucket can hold.",
    coordinationStrategy: "Persisted coordination mode preventing replicas from applying incompatible admission guarantees.",
    maxLeaseUnits: "Maximum number of units that leased coordination may grant at once.",
    leaseMs: "Maximum lifetime in milliseconds of a leased capacity grant.",
    maxOutstandingUnits: "Maximum capacity that may be held outside authoritative storage across processes.",
    guardBandUnits: "Remaining-capacity threshold at which leased coordination switches to exact admission.",
    tokens: "Currently available units; reconciliation may temporarily make this value negative.",
    refilledAt: "Date and time at which the stored token count was last refilled.",
    fullAt: "Date and time from which the bucket has been continuously full and has no relevant refill history.",
    lastAdmitted: "Admission decision produced by the most recent atomic reservation update.",
  },
});

export type PostgresThrottlingRateLimit =
  typeof throttlingRateLimits.$inferSelect;

/** Expiring grants bound capacity held outside authoritative storage. */
export const throttlingRateLimitLeases = utilsSchema.table(
  "throttling_rate_limit_lease",
  {
    id: text("id").primaryKey(),
    rateLimitKey: text("rate_limit_key").notNull(),
    ownerId: text("owner_id").notNull(),
    units: doublePrecision("units").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    returnedAt: timestamp("returned_at", {
      mode: "date",
      withTimezone: true,
    }),
    returnedUnits: doublePrecision("returned_units").notNull().default(0),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index("throttling_rate_limit_lease_key_expires_at_idx").on(
      table.rateLimitKey,
      table.expiresAt,
    ),
    index("throttling_rate_limit_lease_expires_at_idx").on(table.expiresAt),
  ],
);

defineDatabaseTableDescriptions(throttlingRateLimitLeases, {
  description: "Expiring grants that bound rate-limit capacity held outside authoritative storage.",
  columns: {
    id: "Stable identifier of the leased capacity grant.",
    rateLimitKey: "Rate-limit bucket from which the capacity was granted.",
    ownerId: "Identifier of the process that owns the grant.",
    units: "Total number of units granted to the owner.",
    expiresAt: "Date and time when unused granted capacity can be reclaimed.",
    returnedAt: "Date and time when the owner returned capacity, or null until a return occurs.",
    returnedUnits: "Number of unused granted units returned to authoritative storage.",
    createdAt: "Date and time when the capacity grant was created.",
  },
});

export type PostgresThrottlingRateLimitLease =
  typeof throttlingRateLimitLeases.$inferSelect;
