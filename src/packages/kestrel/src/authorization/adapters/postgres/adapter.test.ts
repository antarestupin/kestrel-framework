import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { DatabaseManager } from "../../../db/index.js";
import { createPostgresTestPool } from "../../../testing/postgres.js";
import { PostgresAuthorizationAdapter } from "./adapter.js";
import type { PostgresAuthorizationTables } from "./tables.js";

const testRoles = pgTable("authorization_role_test", {
  id: uuid("id").default(sql`uuidv7()`).primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  state: text("state").default("active").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
});
const testRolePermissions = pgTable("authorization_role_permission_test", {
  roleId: uuid("role_id").notNull(),
  permissionId: text("permission_id").notNull(),
});
const testSubjectRoles = pgTable("authorization_subject_role_test", {
  subjectId: text("subject_id").notNull(),
  roleId: uuid("role_id").notNull(),
  grantedAt: timestamp("granted_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  grantedBySubjectId: text("granted_by_subject_id"),
});

let pool: Pool;
let client: PoolClient;
let adapter: PostgresAuthorizationAdapter;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();
  await client.query(`
    CREATE TEMPORARY TABLE authorization_role_test (
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      description text,
      state text NOT NULL DEFAULT 'active',
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    ) ON COMMIT PRESERVE ROWS;
    CREATE TEMPORARY TABLE authorization_role_permission_test (
      role_id uuid NOT NULL,
      permission_id text NOT NULL,
      PRIMARY KEY (role_id, permission_id)
    ) ON COMMIT PRESERVE ROWS;
    CREATE TEMPORARY TABLE authorization_subject_role_test (
      subject_id text NOT NULL,
      role_id uuid NOT NULL,
      granted_at timestamp with time zone NOT NULL DEFAULT now(),
      granted_by_subject_id text,
      PRIMARY KEY (subject_id, role_id)
    ) ON COMMIT PRESERVE ROWS
  `);
  const database = drizzle(client);
  adapter = new PostgresAuthorizationAdapter(
    new DatabaseManager({
      database: database as ConstructorParameters<typeof DatabaseManager>[0]["database"],
    }),
    {
      roles: testRoles,
      rolePermissions: testRolePermissions,
      subjectRoles: testSubjectRoles,
    } satisfies PostgresAuthorizationTables,
  );
});

beforeEach(async () => {
  await client.query(`
    TRUNCATE authorization_subject_role_test,
      authorization_role_permission_test,
      authorization_role_test
  `);
});

afterAll(async () => {
  client.release();
  await pool.end();
});

describe("PostgresAuthorizationAdapter", () => {
  it("resolves active role permissions and handles grants idempotently", async () => {
    const roleId = await insertRole("admin");
    await client.query(
      "INSERT INTO authorization_role_permission_test (role_id, permission_id) VALUES ($1, $2)",
      [roleId, "admin.access"],
    );

    await expect(adapter.grantRole("external|subject-1", roleId))
      .resolves.toBe(true);
    await expect(adapter.grantRole("external|subject-1", roleId))
      .resolves.toBe(false);
    await expect(adapter.resolvePermissions("external|subject-1"))
      .resolves.toEqual(new Set(["admin.access"]));
    await expect(adapter.findRoleByKey("admin")).resolves.toMatchObject({
      id: roleId,
      key: "admin",
      state: "active",
    });

    await client.query(
      "UPDATE authorization_role_test SET state = 'disabled' WHERE id = $1",
      [roleId],
    );
    await expect(adapter.resolvePermissions("external|subject-1"))
      .resolves.toEqual(new Set());
    await expect(adapter.revokeRole("external|subject-1", roleId))
      .resolves.toBe(true);
    await expect(adapter.revokeRole("external|subject-1", roleId))
      .resolves.toBe(false);
  });
});

async function insertRole(key: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO authorization_role_test (key, name) VALUES ($1, $2) RETURNING id",
    [key, "Administrator"],
  );
  return result.rows[0]!.id;
}
