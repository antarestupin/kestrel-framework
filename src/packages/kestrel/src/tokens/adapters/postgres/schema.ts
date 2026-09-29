import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  jsonb,
  pgSchema,
  type PgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  defineDatabaseSchemaDescription,
  defineDatabaseTableDescriptions,
} from "../../../db/schema_contributions/descriptions.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export interface PostgresTokenTableOptions {
  readonly tableName?: string;
  /** Keeps constraint names unique when several token tables share a schema. */
  readonly indexPrefix?: string;
}

/** Isolates the default shared token table from application-owned schemas. */
export const tokensSqlSchema = defineDatabaseSchemaDescription(
  pgSchema("tokens"),
  "Opaque, expiring, consumable, and revocable application tokens.",
);

/** Creates a compatible shared or definition-dedicated token table. */
export function createPostgresTokenTable(
  schema: PgSchema,
  options: PostgresTokenTableOptions = {},
) {
  const tableName = options.tableName ?? "token";
  const indexPrefix = options.indexPrefix
    ?? `${schema.schemaName}_${tableName}`;

  const table = schema.table(
    tableName,
    {
      id: uuid("id").primaryKey(),
      definition: text("definition").notNull(),
      subject: text("subject"),
      subjectExclusive: boolean("subject_exclusive").default(false).notNull(),
      digest: bytea("digest").notNull(),
      payload: jsonb("payload").$type<unknown>().notNull(),
      expiresAt: timestamp("expires_at", {
        mode: "date",
        withTimezone: true,
      }).notNull(),
      consumedAt: timestamp("consumed_at", {
        mode: "date",
        withTimezone: true,
      }),
      revokedAt: timestamp("revoked_at", {
        mode: "date",
        withTimezone: true,
      }),
      createdAt: timestamp("created_at", {
        mode: "date",
        withTimezone: true,
      }).notNull(),
    },
    (table) => [
      uniqueIndex(`${indexPrefix}_digest_unique`).on(table.digest),
      index(`${indexPrefix}_definition_subject_idx`)
        .on(table.definition, table.subject),
      uniqueIndex(`${indexPrefix}_active_subject_unique`)
        .on(table.definition, table.subject)
        .where(sql`${table.subjectExclusive} and ${table.consumedAt} is null and ${table.revokedAt} is null`),
      index(`${indexPrefix}_expiry_idx`).on(table.expiresAt),
      index(`${indexPrefix}_consumed_idx`).on(table.consumedAt),
      index(`${indexPrefix}_revoked_idx`).on(table.revokedAt),
      check(
        `${indexPrefix}_exclusive_subject_check`,
        sql`not ${table.subjectExclusive} or ${table.subject} is not null`,
      ),
    ],
  );

  return defineDatabaseTableDescriptions(table, {
    description: "Opaque application tokens stored by digest with expiry, consumption, and revocation state.",
    columns: {
      id: "Stable identifier of the token record.",
      definition: "Application-defined token kind that determines issuance and validation policy.",
      subject: "Optional application-defined subject associated with the token.",
      subjectExclusive: "Whether this token must be the only active token for its definition and subject.",
      digest: "Digest used to verify the token without storing its raw secret.",
      payload: "Application-defined JSON payload carried by the token.",
      expiresAt: "Date and time after which the token cannot be used.",
      consumedAt: "Date and time when the token was consumed, or null while unused.",
      revokedAt: "Date and time when the token was revoked, or null while not revoked.",
      createdAt: "Date and time when the token was issued.",
    },
  });
}

/** Default table shared by every stateful token definition. */
export const tokenRecords = createPostgresTokenTable(tokensSqlSchema);
export type PostgresTokenRecord = typeof tokenRecords.$inferSelect;
