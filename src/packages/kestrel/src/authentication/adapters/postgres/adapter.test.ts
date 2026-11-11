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
import type { CreateStoredSession } from "../../stores.js";
import type { AuthenticationAccount } from "../../types.js";
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

const subjectId = "00000000-0000-4000-8000-000000000001";
const otherSubjectId = "00000000-0000-4000-8000-000000000002";

/** Use fixed deadlines to test PostgreSQL comparisons at the exact expiration instant. */
function sessionInput(
  account: AuthenticationAccount,
  seed: number,
  overrides: Partial<CreateStoredSession<{ role: string }>> = {},
): CreateStoredSession<{ role: string }> {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");

  return {
    id: `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
    accountId: account.id,
    tokenDigest: Buffer.alloc(32, seed),
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
    ...overrides,
  };
}

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
  client?.release();
  await pool?.end();
});

describe("PostgresAuthenticationAdapter", () => {
  it("creates accounts and conditionally replaces password hashes", async () => {
    const account = await adapter.createAccount({
      subjectId,
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

  it("returns no account for missing identifiers and rejects an invalid persisted state", async () => {
    const account = await adapter.createAccount({ subjectId });
    await expect(adapter.findById(account.id)).resolves.toEqual(account);
    await expect(adapter.findById(otherSubjectId)).resolves.toBeUndefined();
    await expect(adapter.findBySubjectId(otherSubjectId)).resolves.toBeUndefined();

    // The adapter accepts application-owned tables whose state column may lack a check constraint.
    await client.query("UPDATE authentication_account SET state = $1 WHERE id = $2", [
      "unsupported",
      account.id,
    ]);
    await expect(adapter.findById(account.id))
      .rejects.toThrow("Unsupported authentication account state: unsupported");
  });

  it("returns no session for an unknown digest or a missing account in a combined lookup", async () => {
    const account = await adapter.createAccount({ subjectId });
    const stored = await adapter.createSession(sessionInput(account, 1));
    const unknownDigest = new Uint8Array(32).fill(2);
    await expect(adapter.findByTokenDigest(unknownDigest)).resolves.toBeUndefined();
    await expect(adapter.findSessionAndAccountByTokenDigest(unknownDigest))
      .resolves.toBeUndefined();

    // A dangling session in an application-owned table cannot resolve to an account.
    await client.query("DELETE FROM authentication_account WHERE id = $1", [account.id]);
    await expect(adapter.findByTokenDigest(stored.tokenDigest)).resolves.toEqual(stored);
    await expect(adapter.findSessionAndAccountByTokenDigest(stored.tokenDigest))
      .resolves.toBeUndefined();
  });

  it("preserves session metadata and revocation when reloading from storage", async () => {
    const account = await adapter.createAccount({ subjectId });
    const input = sessionInput(account, 1, {
      ipAddress: "192.0.2.1",
      userAgent: "Kestrel test client",
    });
    const session = await adapter.createSession(input);

    expect(session).toEqual(input);
    await expect(adapter.findByTokenDigest(session.tokenDigest))
      .resolves.toEqual(session);
    await expect(adapter.findSessionAndAccountByTokenDigest(session.tokenDigest))
      .resolves.toEqual({ session, account });
    const lastSeenAt = new Date("2026-01-01T00:01:00.000Z");
    const idleExpiresAt = new Date("2026-01-01T01:01:00.000Z");
    const touch = {
      id: session.id, now: lastSeenAt, lastSeenAt, idleExpiresAt,
    };
    const touched = { ...session, lastSeenAt, idleExpiresAt };
    await expect(adapter.touch(touch)).resolves.toEqual(touched);
    const revokedAt = new Date("2026-01-01T00:02:00.000Z");
    const revocation = {
      id: session.id,
      revokedAt,
      reason: "logout",
    };
    await expect(adapter.revoke(revocation)).resolves.toBe(true);
    await expect(adapter.revoke({
      ...revocation,
      revokedAt: new Date("2026-01-01T00:03:00.000Z"),
      reason: "replacement",
    })).resolves.toBe(false);
    await expect(adapter.touch({ ...touch, now: revokedAt, lastSeenAt: revokedAt }))
      .resolves.toBeUndefined();
    const revoked = { ...touched, revokedAt, revokeReason: "logout" };
    await expect(adapter.findByTokenDigest(session.tokenDigest)).resolves.toEqual(revoked);
    await expect(adapter.listForAccount(account.id)).resolves.toEqual([revoked]);
  });

  it.each(["idleExpiresAt", "absoluteExpiresAt"] as const)(
    "does not renew a session at its %s deadline",
    async (deadline) => {
      const account = await adapter.createAccount({ subjectId });
      const now = new Date("2026-01-01T01:00:00.000Z");
      const stored = await adapter.createSession(sessionInput(account, 1, {
        // Keep the other deadline in the future to exercise each SQL predicate independently.
        idleExpiresAt: new Date("2026-01-01T02:00:00.000Z"),
        [deadline]: now,
      }));
      await expect(adapter.touch({
        id: stored.id,
        now,
        lastSeenAt: now,
        idleExpiresAt: new Date("2026-01-01T03:00:00.000Z"),
      })).resolves.toBeUndefined();
      await expect(adapter.findByTokenDigest(stored.tokenDigest)).resolves.toEqual(stored);
    },
  );

  it("revokes only the selected account's active sessions and preserves prior revocations", async () => {
    const account = await adapter.createAccount({ subjectId });
    const other = await adapter.createAccount({ subjectId: otherSubjectId });
    const first = await adapter.createSession(sessionInput(account, 1));
    const second = await adapter.createSession(sessionInput(account, 2, {
      createdAt: new Date("2026-01-01T00:01:00.000Z"),
    }));
    const unrelated = await adapter.createSession(sessionInput(other, 3));
    const priorRevocation = new Date("2026-01-01T00:02:00.000Z");
    await adapter.revoke({ id: first.id, revokedAt: priorRevocation, reason: "logout" });

    const revokedAt = new Date("2026-01-01T00:03:00.000Z");
    const revokeAll = { accountId: account.id, revokedAt, reason: "security" };
    await expect(adapter.revokeAllForAccount(revokeAll)).resolves.toBe(1);
    await expect(adapter.revokeAllForAccount(revokeAll)).resolves.toBe(0);
    await expect(adapter.listForAccount(account.id)).resolves.toEqual([
      { ...second, revokedAt, revokeReason: "security" },
      { ...first, revokedAt: priorRevocation, revokeReason: "logout" },
    ]);
    await expect(adapter.findByTokenDigest(unrelated.tokenDigest)).resolves.toEqual(unrelated);
  });

  it("increments and persists the security version only for the selected account", async () => {
    const account = await adapter.createAccount({ subjectId });
    const other = await adapter.createAccount({ subjectId: otherSubjectId });
    await expect(adapter.setState({ accountId: otherSubjectId, state: "disabled" }))
      .resolves.toBeUndefined();
    await expect(adapter.incrementSecurityVersion(otherSubjectId)).resolves.toBeUndefined();

    const disabled = await adapter.setState({
      accountId: account.id,
      state: "disabled",
    });

    expect(disabled).toMatchObject({
      state: "disabled",
      securityVersion: account.securityVersion + 1,
    });
    const securityVersion = account.securityVersion + 2;
    await expect(adapter.incrementSecurityVersion(account.id)).resolves.toBe(securityVersion);
    await expect(adapter.findById(account.id))
      .resolves.toEqual(expect.objectContaining({ state: "disabled", securityVersion }));
    await expect(adapter.findById(other.id)).resolves.toEqual(other);
  });
});
