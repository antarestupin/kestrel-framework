import { sql } from "drizzle-orm";
import {
  check,
  customType,
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

/** Isolates authentication persistence from application-owned profile data. */
export const authenticationSqlSchema = defineDatabaseSchemaDescription(
  pgSchema("authentication"),
  "Authentication accounts, credentials, and revocable sessions independent from application profile data.",
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** Stores authentication state against an opaque application subject ID. */
export const authenticationAccounts = authenticationSqlSchema.table(
  "account",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    // Text preserves the core contract: applications choose their ID format.
    subjectId: text("subject_id").notNull(),
    state: text("state").default("active").notNull(),
    securityVersion: integer("security_version").default(1).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("authentication_account_subject_id_unique")
      .on(table.subjectId),
    check(
      "authentication_account_state_check",
      sql`${table.state} in ('active', 'disabled')`,
    ),
    check(
      "authentication_account_security_version_check",
      sql`${table.securityVersion} > 0`,
    ),
  ],
);

defineDatabaseTableDescriptions(authenticationAccounts, {
  description: "Authentication state mapped to an opaque subject owned by the integrating application.",
  columns: {
    id: "Stable identifier of the authentication account.",
    subjectId: "Opaque application-owned subject identifier associated with this account.",
    state: "Account state controlling whether authentication is allowed.",
    securityVersion: "Monotonically increasing version used to invalidate every session issued under an older account state.",
    createdAt: "Date and time when the authentication account was created.",
    updatedAt: "Date and time when the authentication account was last updated.",
  },
});

/** Stores only data owned by the password authentication mechanism. */
export const authenticationPasswordCredentials = authenticationSqlSchema.table(
  "password_credentials",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => authenticationAccounts.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    normalizedUsername: text("normalized_username").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordChangedAt: timestamp("password_changed_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("authentication_password_credentials_account_id_unique")
      .on(table.accountId),
    uniqueIndex("authentication_password_credentials_username_unique")
      .on(table.normalizedUsername),
  ],
);

defineDatabaseTableDescriptions(authenticationPasswordCredentials, {
  description: "Password credentials and normalized login identity owned by an authentication account.",
  columns: {
    id: "Stable identifier of the password credential record.",
    accountId: "Authentication account that owns these password credentials.",
    username: "Login identifier in the form supplied for display and auditing.",
    normalizedUsername: "Canonical login identifier used for lookup and uniqueness.",
    passwordHash: "One-way password hash; the original password is never stored.",
    passwordChangedAt: "Date and time when the password was most recently replaced.",
    createdAt: "Date and time when the password credentials were created.",
    updatedAt: "Date and time when the password credentials were last updated.",
  },
});

/** Persists revocable sessions without ever storing raw bearer tokens. */
export const authenticationSessions = authenticationSqlSchema.table(
  "session",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => authenticationAccounts.id, { onDelete: "cascade" }),
    tokenDigest: bytea("token_digest").notNull(),
    claims: jsonb("claims").$type<unknown>().notNull(),
    accountSecurityVersion: integer("account_security_version").notNull(),
    authenticationMethod: text("authentication_method").notNull(),
    authenticationFactors: text("authentication_factors").array().notNull(),
    authenticatedAt: timestamp("authenticated_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true })
      .notNull(),
    idleExpiresAt: timestamp("idle_expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    revokeReason: text("revoke_reason"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("authentication_session_token_digest_unique")
      .on(table.tokenDigest),
    index("authentication_session_account_created_idx")
      .on(table.accountId, table.createdAt),
    index("authentication_session_active_expiry_idx")
      .on(table.idleExpiresAt, table.absoluteExpiresAt)
      .where(sql`${table.revokedAt} is null`),
    check(
      "authentication_session_security_version_check",
      sql`${table.accountSecurityVersion} > 0`,
    ),
  ],
);

defineDatabaseTableDescriptions(authenticationSessions, {
  description: "Revocable bearer-token sessions stored by digest and bounded by idle and absolute expiry.",
  columns: {
    id: "Stable identifier of the authentication session.",
    accountId: "Authentication account that owns the session.",
    tokenDigest: "Digest used to look up the session without storing the raw bearer token.",
    claims: "Application-defined claims snapshot attached to the session.",
    accountSecurityVersion: "Account security version captured at issuance; a mismatch invalidates the session.",
    authenticationMethod: "Authentication method that established the session.",
    authenticationFactors: "Authentication factors satisfied when the session was established.",
    authenticatedAt: "Date and time of the authentication event that established the session.",
    createdAt: "Date and time when the session was created.",
    lastSeenAt: "Date and time of the most recent accepted session activity.",
    idleExpiresAt: "Date and time when the session expires without further activity.",
    absoluteExpiresAt: "Hard expiry date and time that activity cannot extend.",
    revokedAt: "Date and time when the session was revoked, or null while it remains active.",
    revokeReason: "Optional reason recorded when the session is revoked.",
    ipAddress: "Optional client IP address captured for the session.",
    userAgent: "Optional client user-agent value captured for the session.",
  },
});

/** Default bundled mapping used unless an application supplies custom tables. */
export const authenticationTables = {
  accounts: authenticationAccounts,
  passwordCredentials: authenticationPasswordCredentials,
  sessions: authenticationSessions,
};
