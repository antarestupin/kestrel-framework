import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
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
import { applyDatabaseSchemaContributions } from "../../../db/schema_contributions/apply.js";
import { createDependencyContainer, dep, registerScopedAdapter } from "../../../di/index.js";
import { createPostgresTestPool } from "../../../testing/postgres.js";
import type { CreateStoredToken, TokenStorageAdapter } from "../../types.js";
import { PostgresTokenStorageAdapter } from "./adapter.js";
import { postgresTokens } from "./definition.js";
import { createPostgresTokenTable } from "./schema.js";

const namespace = pgSchema(`token_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
const testTokens = createPostgresTokenTable(namespace, { tableName: "token_test" });
const now = new Date("2026-01-01T00:00:00.000Z");

let pool: Pool;
let client: PoolClient;
let store: PostgresTokenStorageAdapter;
let manager: PostgresDrizzleManager;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();
  // Deploy the exported Drizzle declaration and its comments in this suite's owned namespace.
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const schema = { namespace, testTokens };
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  await client.query("BEGIN");
  try {
    for (const statement of statements) await client.query(statement);
    await applyDatabaseSchemaContributions(schema, (statement) => client.query(statement));
    await client.query(`SET search_path TO "${namespace.schemaName}", public`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const database = drizzle(client);
  manager = new PostgresDrizzleManager({
    database: database as ConstructorParameters<typeof PostgresDrizzleManager>[0]["database"],
  });
  store = new PostgresTokenStorageAdapter(manager, testTokens);
});

beforeEach(async () => {
  await client.query("TRUNCATE token_test");
});

afterAll(async () => {
  try {
    await client?.query(`DROP SCHEMA IF EXISTS "${namespace.schemaName}" CASCADE`);
  } finally {
    client?.release(true);
    await pool?.end();
  }
});

describe("PostgresTokenStorageAdapter", () => {
  it("uses the selected deployable table and borrows the scoped manager's transaction", async () => {
    const container = createDependencyContainer({});
    const scope = container.createScope();
    const database = dep<PostgresDrizzleManager>("scopedTokenDatabase");
    const adapter = dep<TokenStorageAdapter>("tokens");
    scope.registerValue(database.id, manager);
    registerScopedAdapter(container, adapter.id, postgresTokens(database, testTokens), undefined);
    const token = createLifecycleToken(1);
    const aborted = new Error("abort the caller's transaction");

    try {
      const scopedStore = scope.resolve(adapter);
      // Nested issuance joins the manager's transaction, so no token escapes rollback.
      await expect(manager.transaction(async () => {
        await scopedStore.createMany([token]);
        await expect(scopedStore.findValid({ definition: token.definition, digest: token.digest, now }))
          .resolves.toMatchObject({ id: token.id });
        throw aborted;
      })).rejects.toBe(aborted);
      await expect(scopedStore.findValid({ definition: token.definition, digest: token.digest, now }))
        .resolves.toBeUndefined();
    } finally {
      await scope.dispose();
      await container.dispose();
    }
    await expect(client.query("SELECT 1")).resolves.toMatchObject({ rowCount: 1 });
  });
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
      subject: "account-1",
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
    expect(found).not.toHaveProperty("consumedAt");
    expect(found).not.toHaveProperty("revokedAt");
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

  it("revokes each subject at its own replacement's creation time", async () => {
    const originalA = createLifecycleToken(1, { subject: "account-1" });
    const originalB = createLifecycleToken(2, { subject: "account-2" });
    const firstTime = new Date(now.getTime() + 1_000);
    const secondTime = new Date(now.getTime() + 2_000);
    const first = createLifecycleToken(3, { subject: "account-1", createdAt: firstTime, replaceExistingForSubject: true });
    const second = createLifecycleToken(4, { subject: "account-2", createdAt: secondTime, replaceExistingForSubject: true });
    const nonReplacement = createLifecycleToken(5, { subject: "account-3" });
    const retained = createLifecycleToken(6, { subject: "account-3" });
    const originalC = createLifecycleToken(7, { subject: "account-4" });
    const sharedTime = createLifecycleToken(8, { subject: "account-4", createdAt: firstTime, replaceExistingForSubject: true });

    // Different subjects can share an issuance time within the same batch.
    await store.createMany([originalA, originalB, retained, originalC]);
    await store.createMany([first, second, nonReplacement, sharedTime]);
    const { rows } = await client.query("SELECT id, revoked_at FROM token_test WHERE revoked_at IS NOT NULL ORDER BY id");
    expect(rows).toEqual([
      { id: originalA.id, revoked_at: firstTime },
      { id: originalB.id, revoked_at: secondTime },
      { id: originalC.id, revoked_at: firstTime },
    ]);
  });

  it.each([false, true])("applies replacements before inserting a mixed batch (replacement first: %s)", async (replacementFirst) => {
    const original = createLifecycleToken(1);
    const ordinary = createLifecycleToken(2);
    const replacement = createLifecycleToken(3, { replaceExistingForSubject: true });
    const lookup = (token: CreateStoredToken) => ({ definition: token.definition, digest: token.digest, now });
    await store.createMany([original]);

    await store.createMany(replacementFirst ? [replacement, ordinary] : [ordinary, replacement]);

    // A replacement invalidates existing state, independently of the order of new records.
    await expect(store.findValid(lookup(original))).resolves.toBeUndefined();
    await expect(store.findValid(lookup(ordinary))).resolves.toMatchObject({ id: ordinary.id });
    await expect(store.findValid(lookup(replacement))).resolves.toMatchObject({ id: replacement.id });
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

  it("rejects invalid prune limits without deleting eligible rows", async () => {
    await store.createMany([1, 2].map((digest) => createLifecycleToken(digest, { expiresAt: now })));
    const options = { expiredBefore: now, inactiveBefore: now };
    await expect(store.prune({ ...options, limit: Number.NaN })).rejects.toThrow("positive");
    await expect(store.prune({ ...options, limit: -1 })).rejects.toThrow("positive");
    await expect(store.prune({ ...options, limit: 2 })).resolves.toBe(2);
  });

  it("avoids a write when pruning finds no candidates", async () => {
    await store.createMany([createLifecycleToken(1)]);

    await manager.transaction(async () => {
      await client.query("SET TRANSACTION READ ONLY");
      // An empty candidate set must not issue even an empty DELETE statement.
      await expect(store.prune({ expiredBefore: now, inactiveBefore: now, limit: 1 })).resolves.toBe(0);
    });
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
