import {
  bigserial,
  index,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { defineDatabaseTableDescriptions } from "../db/schema_contributions/descriptions.js";
import { utilsSchema } from "../db/utils_schema.js";

/** Shared leases persisted by the PostgreSQL lock adapter. */
export const lockLeases = utilsSchema.table(
  "lock_lease",
  {
    key: text("key").primaryKey(),
    ownerId: text("owner_id").notNull(),
    // The backing sequence keeps tokens monotone even after rows are deleted.
    fencingToken: bigserial("fencing_token", {
      mode: "bigint",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index("lock_lease_expires_at_idx").on(table.expiresAt),
  ],
);

defineDatabaseTableDescriptions(lockLeases, {
  description: "Expiring distributed-lock leases protected by monotonically increasing fencing tokens.",
  columns: {
    key: "Application-defined identifier of the protected resource.",
    ownerId: "Identifier of the process or operation that currently owns the lease.",
    fencingToken: "Monotonically increasing token used by protected resources to reject stale owners.",
    expiresAt: "Date and time when the lease may be acquired by another owner.",
  },
});

export type PostgresLockLease = typeof lockLeases.$inferSelect;
