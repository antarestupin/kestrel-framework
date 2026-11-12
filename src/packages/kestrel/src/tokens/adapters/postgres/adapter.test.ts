import { drizzle } from "drizzle-orm/node-postgres";
import {
  boolean,
  customType,
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
import type { CreateStoredToken } from "../../types.js";
import { PostgresTokenStorageAdapter } from "./adapter.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const testTokens = pgTable("token_test", {
  id: uuid("id").primaryKey(),
  definition: text("definition").notNull(),
  subject: text("subject"),
  subjectExclusive: boolean("subject_exclusive").default(false).notNull(),
  digest: bytea("digest").notNull(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
    .notNull(),
  consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
  revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull(),
});
const now = new Date("2026-01-01T00:00:00.000Z");

let pool: Pool;
let client: PoolClient;
let store: PostgresTokenStorageAdapter;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();
  await client.query(`
    CREATE TEMPORARY TABLE token_test (
      id uuid PRIMARY KEY,
      definition text NOT NULL,
      subject text,
      subject_exclusive boolean NOT NULL DEFAULT false,
      digest bytea NOT NULL UNIQUE,
      payload jsonb NOT NULL,
      expires_at timestamp with time zone NOT NULL,
      consumed_at timestamp with time zone,
      revoked_at timestamp with time zone,
      created_at timestamp with time zone NOT NULL
    ) ON COMMIT PRESERVE ROWS;
    CREATE UNIQUE INDEX token_test_active_subject_unique
      ON token_test (definition, subject)
      WHERE subject_exclusive AND consumed_at IS NULL AND revoked_at IS NULL
  `);
  const database = drizzle(client);
  store = new PostgresTokenStorageAdapter(
    new PostgresDrizzleManager({
      database: database as ConstructorParameters<typeof PostgresDrizzleManager>[0]["database"],
    }),
    testTokens,
  );
});

beforeEach(async () => {
  await client.query("TRUNCATE token_test");
});

afterAll(async () => {
  client.release();
  await pool.end();
});

describe("PostgresTokenStorageAdapter", () => {
  it("persists lifecycle-only marker payloads for hybrid tokens", async () => {
    await store.createMany([createToken(
      "00000000-0000-4000-8000-000000000001",
      1,
      {
        payload: { tokenRepresentation: "hybrid-jwt" },
        replaceExistingForSubject: false,
      },
    )]);

    await expect(store.findValid({
      definition: "test.token",
      digest: new Uint8Array([1]),
      now,
    })).resolves.toMatchObject({
      payload: { tokenRepresentation: "hybrid-jwt" },
    });
  });

  it("replaces active tokens and consumes the replacement atomically", async () => {
    await store.createMany([createToken("00000000-0000-4000-8000-000000000001", 1)]);
    await store.createMany([createToken("00000000-0000-4000-8000-000000000002", 2)]);

    await expect(store.consume({
      definition: "test.token",
      digest: new Uint8Array([1]),
      now,
    })).resolves.toBeUndefined();
    await expect(store.consume({
      definition: "test.token",
      digest: new Uint8Array([2]),
      now,
    })).resolves.toMatchObject({
      id: "00000000-0000-4000-8000-000000000002",
      payload: { accountId: "account-1" },
      consumedAt: now,
    });
    await expect(store.consume({
      definition: "test.token",
      digest: new Uint8Array([2]),
      now,
    })).resolves.toBeUndefined();
  });

  it("preserves a subjectless token and enforces its definition and expiry on lookup", async () => {
    const { subject: _subject, ...token } = createToken("00000000-0000-4000-8000-000000000001", 1, {
      replaceExistingForSubject: false,
    });
    await store.createMany([token]);
    await store.createMany([]);

    const lookup = { definition: token.definition, digest: token.digest, now };
    // A nullable database column becomes an absent subject in the public result.
    const found = await store.findValid(lookup);
    expect(found).toMatchObject({ id: token.id, payload: token.payload });
    expect(found).not.toHaveProperty("subject");
    await expect(store.findValid({ ...lookup, definition: "other.token" }))
      .resolves.toBeUndefined();
    await expect(store.findValid({ ...lookup, now: token.expiresAt }))
      .resolves.toBeUndefined();
  });

  it("keeps the current token valid when a replacement batch is rejected", async () => {
    const original = createToken("00000000-0000-4000-8000-000000000001", 1);
    const replacement = createToken("00000000-0000-4000-8000-000000000002", 2);
    const { subject: _subject, ...subjectless } = createToken("00000000-0000-4000-8000-000000000003", 3);
    const lookup = { definition: original.definition, digest: original.digest, now };
    await store.createMany([original]);

    await expect(store.createMany([replacement, subjectless]))
      .rejects.toThrow("Replacement tokens require a subject");
    await expect(store.createMany([replacement, createToken(
      "00000000-0000-4000-8000-000000000003", 3,
    )])).rejects.toThrow("cannot replace the same definition and subject");
    // A conflicting insert must roll back the preceding subject revocation.
    await expect(store.createMany([replacement, createToken(
      "00000000-0000-4000-8000-000000000003", 1,
      { replaceExistingForSubject: false },
    )])).rejects.toThrow();

    await expect(store.findValid(lookup)).resolves.toMatchObject({ id: original.id });
    await expect(store.findValid({ ...lookup, digest: replacement.digest }))
      .resolves.toBeUndefined();
  });

  it("revokes only the active bearer value for the requested definition", async () => {
    const previouslyInactive = new Date(now.getTime() - 1_000);
    const revokedAt = new Date(now.getTime() + 1_000);
    const active = createLifecycleToken(1);
    const other = createLifecycleToken(2);
    const expired = createLifecycleToken(3, { expiresAt: now });
    const consumed = createLifecycleToken(4, { consumedAt: previouslyInactive });
    const revoked = createLifecycleToken(5, { revokedAt: previouslyInactive });
    const lookup = { definition: active.definition, digest: active.digest, now };
    await store.createMany([active, other, expired, consumed, revoked]);

    // The digest is insufficient without a matching definition and an active row.
    await expect(store.revoke({ ...lookup, definition: "other.token", revokedAt }))
      .resolves.toBe(false);
    for (const token of [expired, consumed, revoked]) {
      await expect(store.revoke({ ...lookup, digest: token.digest, revokedAt }))
        .resolves.toBe(false);
    }
    await expect(store.revoke({ ...lookup, revokedAt })).resolves.toBe(true);
    await expect(store.revoke({ ...lookup, revokedAt: now })).resolves.toBe(false);
    await expect(store.findValid(lookup)).resolves.toBeUndefined();
    await expect(store.findValid({ ...lookup, digest: other.digest }))
      .resolves.toMatchObject({ id: other.id });

    // Repeated attempts preserve the first revocation timestamp.
    const { rows } = await client.query("SELECT id, revoked_at FROM token_test ORDER BY id");
    expect(rows).toEqual([
      { id: active.id, revoked_at: revokedAt },
      { id: other.id, revoked_at: null },
      { id: expired.id, revoked_at: null },
      { id: consumed.id, revoked_at: null },
      { id: revoked.id, revoked_at: previouslyInactive },
    ]);
  });

  it("revokes active tokens and deletes every lifecycle state within one definition and subject", async () => {
    const previouslyInactive = new Date(now.getTime() - 1_000);
    const first = createLifecycleToken(1);
    const second = createLifecycleToken(2);
    const expired = createLifecycleToken(3, { expiresAt: now });
    const consumed = createLifecycleToken(4, { consumedAt: previouslyInactive });
    const revoked = createLifecycleToken(5, { revokedAt: previouslyInactive });
    const otherSubject = createLifecycleToken(6, { subject: "account-2" });
    const otherDefinition = createLifecycleToken(7, { definition: "other.token" });
    const scopedTokens = [first, second, expired, consumed, revoked];
    const input = { definition: "test.token", subject: "account-1", now };
    await store.createMany([...scopedTokens, otherSubject, otherDefinition]);

    await expect(store.revokeForSubject(input)).resolves.toBe(2);
    await expect(store.revokeForSubject(input)).resolves.toBe(0);
    const { rows } = await client.query("SELECT id, revoked_at FROM token_test ORDER BY id");
    expect(rows).toEqual([
      { id: first.id, revoked_at: now },
      { id: second.id, revoked_at: now },
      { id: expired.id, revoked_at: null },
      { id: consumed.id, revoked_at: null },
      { id: revoked.id, revoked_at: previouslyInactive },
      { id: otherSubject.id, revoked_at: null },
      { id: otherDefinition.id, revoked_at: null },
    ]);

    // Subject deletion physically removes inactive rows as well as active rows.
    const active = createLifecycleToken(8);
    await store.createMany([active]);
    await expect(store.deleteForSubject(input)).resolves.toBe(scopedTokens.length + 1);
    await expect(store.deleteForSubject(input)).resolves.toBe(0);
    const remaining = await client.query("SELECT id FROM token_test ORDER BY id");
    expect(remaining.rows).toEqual([{ id: otherSubject.id }, { id: otherDefinition.id }]);
    for (const token of [otherSubject, otherDefinition]) {
      await expect(store.findValid({ definition: token.definition, digest: token.digest, now }))
        .resolves.toMatchObject({ id: token.id });
    }
  });

  it("prunes expired, consumed, and revoked tokens in bounded batches", async () => {
    await store.createMany([
      createToken("00000000-0000-4000-8000-000000000001", 1, {
        expiresAt: new Date(now.getTime() - 1),
        replaceExistingForSubject: false,
      }),
      createToken("00000000-0000-4000-8000-000000000002", 2, {
        subject: "account-2",
        consumedAt: new Date(now.getTime() - 1),
        replaceExistingForSubject: false,
      }),
      createToken("00000000-0000-4000-8000-000000000003", 3, {
        subject: "account-3",
        revokedAt: new Date(now.getTime() - 1),
        replaceExistingForSubject: false,
      }),
      createToken("00000000-0000-4000-8000-000000000004", 4, {
        subject: "account-4",
        replaceExistingForSubject: false,
      }),
    ]);

    await expect(store.prune({
      expiredBefore: now,
      inactiveBefore: now,
      limit: 2,
    })).resolves.toBe(2);
    await expect(store.prune({
      expiredBefore: now,
      inactiveBefore: now,
      limit: 2,
    })).resolves.toBe(1);
    await expect(store.prune({
      expiredBefore: now,
      inactiveBefore: now,
      limit: 2,
    })).resolves.toBe(0);
    const result = await client.query("SELECT id FROM token_test");
    expect(result.rows).toEqual([
      { id: "00000000-0000-4000-8000-000000000004" },
    ]);
  });
});

function createToken(
  id: string,
  digest: number,
  overrides: Partial<CreateStoredToken> = {},
): CreateStoredToken {
  return {
    id,
    definition: "test.token",
    subject: "account-1",
    digest: new Uint8Array([digest]),
    payload: { accountId: "account-1" },
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    replaceExistingForSubject: true,
    ...overrides,
  };
}

function createLifecycleToken(
  digest: number,
  overrides: Partial<CreateStoredToken> = {},
): CreateStoredToken {
  const suffix = String(digest).padStart(12, "0");
  return createToken(`00000000-0000-4000-8000-${suffix}`, digest, {
    replaceExistingForSubject: false,
    ...overrides,
  });
}
