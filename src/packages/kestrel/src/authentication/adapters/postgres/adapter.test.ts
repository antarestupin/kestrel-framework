import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { PostgresDrizzleManager } from "../../../db/index.js";
import { createPostgresTestPool } from "../../../testing/postgres.js";
import { PostgresAuthenticationAdapter } from "./adapter.js";
import type { PostgresAuthenticationTables } from "./tables.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const testAccounts = pgTable("authentication_account", {
  id: uuid("id").default(sql`uuidv7()`).primaryKey(),
  subjectId: uuid("subject_id").notNull().unique(),
  state: text("state").default("active").notNull(),
  securityVersion: integer("security_version").default(1).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
});

const testPasswordCredentials = pgTable("authentication_password_credentials", {
  id: uuid("id").default(sql`uuidv7()`).primaryKey(),
  accountId: uuid("account_id").notNull(),
  username: text("username").notNull(),
  normalizedUsername: text("normalized_username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: timestamp("password_changed_at", {
    mode: "date",
    withTimezone: true,
  }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
});

const testSessions = pgTable("authentication_session", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  tokenDigest: bytea("token_digest").notNull().unique(),
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
});

let pool: Pool;
let client: PoolClient;
let adapter: PostgresAuthenticationAdapter<{ role: string }>;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();
  await client.query(`
    CREATE TEMPORARY TABLE authentication_account (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      subject_id uuid NOT NULL UNIQUE,
      state text NOT NULL DEFAULT 'active',
      security_version integer NOT NULL DEFAULT 1,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    ) ON COMMIT PRESERVE ROWS;
    CREATE TEMPORARY TABLE authentication_password_credentials (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      account_id uuid NOT NULL,
      username text NOT NULL,
      normalized_username text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      password_changed_at timestamp with time zone NOT NULL DEFAULT now(),
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    ) ON COMMIT PRESERVE ROWS;
    CREATE TEMPORARY TABLE authentication_session (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      token_digest bytea NOT NULL UNIQUE,
      claims jsonb NOT NULL,
      account_security_version integer NOT NULL,
      authentication_method text NOT NULL,
      authentication_factors text[] NOT NULL,
      authenticated_at timestamp with time zone NOT NULL,
      created_at timestamp with time zone NOT NULL,
      last_seen_at timestamp with time zone NOT NULL,
      idle_expires_at timestamp with time zone NOT NULL,
      absolute_expires_at timestamp with time zone NOT NULL,
      revoked_at timestamp with time zone,
      revoke_reason text,
      ip_address text,
      user_agent text
    ) ON COMMIT PRESERVE ROWS
  `);
  const database = drizzle(client);
  const databaseManager = new PostgresDrizzleManager({
    database: database as ConstructorParameters<typeof PostgresDrizzleManager>[0]["database"],
  });
  adapter = new PostgresAuthenticationAdapter(
    databaseManager,
    {
      accounts: testAccounts,
      passwordCredentials: testPasswordCredentials,
      sessions: testSessions,
    } satisfies PostgresAuthenticationTables,
  );
});

beforeEach(async () => {
  await client.query(`
    TRUNCATE authentication_session,
      authentication_password_credentials,
      authentication_account
  `);
});

afterAll(async () => {
  client.release();
  await pool.end();
});

describe("PostgresAuthenticationAdapter", () => {
  it("creates accounts and conditionally replaces password hashes", async () => {
    const account = await adapter.createAccount({
      subjectId: "00000000-0000-4000-8000-000000000001",
      state: "disabled",
    });
    const credential = await adapter.createPasswordCredential({
      accountId: account.id,
      username: "TestUser",
      normalizedUsername: "testuser",
      passwordHash: "old-hash",
    });

    await expect(adapter.findBySubjectId(account.subjectId))
      .resolves.toEqual(account);
    expect(account.state).toBe("disabled");
    await expect(adapter.replaceHash({
      id: credential.id,
      previousHash: "other-hash",
      passwordHash: "new-hash",
      changedAt: new Date("2026-01-01T00:00:00.000Z"),
    })).resolves.toBe(false);
    await expect(adapter.replaceHash({
      id: credential.id,
      previousHash: "old-hash",
      passwordHash: "new-hash",
      changedAt: new Date("2026-01-01T00:00:00.000Z"),
    })).resolves.toBe(true);
    expect(
      (await adapter.findByNormalizedUsername("testuser"))?.passwordHash,
    ).toBe("new-hash");
  });

  it("stores, touches, lists, and revokes sessions", async () => {
    const account = await adapter.createAccount({
      subjectId: "00000000-0000-4000-8000-000000000001",
    });
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const session = await adapter.createSession({
      id: "00000000-0000-4000-8000-000000000002",
      accountId: account.id,
      tokenDigest: Uint8Array.from({ length: 32 }, (_, index) => index),
      claims: { role: "member" },
      accountSecurityVersion: account.securityVersion,
      evidence: {
        method: "password",
        factors: ["knowledge"],
        authenticatedAt: createdAt,
      },
      createdAt,
      lastSeenAt: createdAt,
      idleExpiresAt: new Date("2026-01-01T01:00:00.000Z"),
      absoluteExpiresAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    await expect(adapter.findByTokenDigest(session.tokenDigest))
      .resolves.toEqual(session);
    await expect(adapter.findSessionAndAccountByTokenDigest(session.tokenDigest))
      .resolves.toEqual({ session, account });
    const touched = await adapter.touch({
      id: session.id,
      now: new Date("2026-01-01T00:01:00.000Z"),
      lastSeenAt: new Date("2026-01-01T00:01:00.000Z"),
      idleExpiresAt: new Date("2026-01-01T01:01:00.000Z"),
    });
    expect(touched?.lastSeenAt).toEqual(
      new Date("2026-01-01T00:01:00.000Z"),
    );
    await expect(adapter.listForAccount(account.id)).resolves.toHaveLength(1);
    await expect(adapter.revoke({
      id: session.id,
      revokedAt: new Date("2026-01-01T00:02:00.000Z"),
      reason: "logout",
    })).resolves.toBe(true);
    await expect(adapter.revoke({
      id: session.id,
      revokedAt: new Date("2026-01-01T00:03:00.000Z"),
      reason: "logout",
    })).resolves.toBe(false);
  });

  it("increments the account security version when its state changes", async () => {
    const account = await adapter.createAccount({
      subjectId: "00000000-0000-4000-8000-000000000001",
    });
    const disabled = await adapter.setState({
      accountId: account.id,
      state: "disabled",
    });

    expect(disabled).toMatchObject({
      state: "disabled",
      securityVersion: account.securityVersion + 1,
    });
  });
});
