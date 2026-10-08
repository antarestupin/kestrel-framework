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
