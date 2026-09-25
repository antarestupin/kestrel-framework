import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { utilsSchema } from "../db/utils_schema.js";
import {
  defineDatabaseTableDescriptions,
  defineUnloggedTable,
} from "../db/schema_contributions/index.js";

/**
 * Shared cache entries persisted by the PostgreSQL adapter.
 *
 * Its custom schema contribution keeps the disposable table UNLOGGED.
 */
export const cacheEntries = defineUnloggedTable(
  utilsSchema.table(
    "cache_entry",
    {
      key: text("key").primaryKey(),
      value: jsonb("value").$type<unknown>().notNull(),
      tags: text("tags")
        .array()
        .default(sql`ARRAY[]::text[]`)
        .notNull(),
      expiresAt: timestamp("expires_at", {
        mode: "date",
        withTimezone: true,
      }).notNull(),
      createdAt: timestamp("created_at", {
        mode: "date",
        withTimezone: true,
      }).notNull(),
      sizeBytes: integer("size_bytes").notNull(),
    },
    (table) => [
      index("cache_entry_expires_at_idx").on(table.expiresAt),
      index("cache_entry_tags_idx").using("gin", table.tags),
    ],
  ),
);

defineDatabaseTableDescriptions(cacheEntries, {
  description: "Disposable unlogged cache entries with expiration and tag-based invalidation.",
  columns: {
    key: "Unique application-defined cache key.",
    value: "JSON value stored for the cache key.",
    tags: "Application-defined tags used to invalidate related entries together.",
    expiresAt: "Date and time after which the entry must be treated as expired.",
    createdAt: "Date and time when the cache entry was created.",
    sizeBytes: "Estimated serialized size used to enforce cache storage budgets.",
  },
});

export type PostgresCacheEntry = typeof cacheEntries.$inferSelect;
