import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
import { PostgresSubjectRoleStore } from "./store.js";
import { definePermission, defineRole } from "../../definition.js";
import { RolePermissionResolver } from "../../resolvers/roles/index.js";
import type { PostgresAuthorizationTables } from "./tables.js";

const testSubjectRoles = pgTable("authorization_subject_role_test", {
  subjectId: text("subject_id").notNull(),
  roleKey: text("role_key").notNull(),
  grantedAt: timestamp("granted_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  grantedBySubjectId: text("granted_by_subject_id"),
});

let pool: Pool;
let client: PoolClient;
let adapter: PostgresSubjectRoleStore;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();
  await client.query(`
    CREATE TEMPORARY TABLE authorization_subject_role_test (
      subject_id text NOT NULL,
      role_key text NOT NULL,
      granted_at timestamp with time zone NOT NULL DEFAULT now(),
      granted_by_subject_id text,
      PRIMARY KEY (subject_id, role_key)
    ) ON COMMIT PRESERVE ROWS
  `);
  const database = drizzle(client);
  adapter = new PostgresSubjectRoleStore(
    new DatabaseManager({
      database: database as ConstructorParameters<typeof DatabaseManager>[0]["database"],
    }),
    {
      subjectRoles: testSubjectRoles,
    } satisfies PostgresAuthorizationTables,
  );
});

beforeEach(async () => {
  await client.query("TRUNCATE authorization_subject_role_test");
});

afterAll(async () => {
  client?.release();
  await pool?.end();
});

describe("PostgresSubjectRoleStore", () => {
  it("persists concurrent idempotent grants, metadata, and isolated revocations", async () => {
    const outcomes = await Promise.all([
      adapter.grantRole("external|subject-1", "admin", "operator-1"),
      adapter.grantRole("external|subject-1", "admin", "operator-2"),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    await adapter.grantRole("external|subject-1", "editor");
    await adapter.grantRole("subject-2", "admin");
    const metadata = await client.query(
      "SELECT granted_at, granted_by_subject_id FROM authorization_subject_role_test WHERE subject_id = $1 AND role_key = $2",
      ["external|subject-1", "admin"],
    );
    expect(metadata.rows[0]).toMatchObject({
      granted_at: expect.any(Date), granted_by_subject_id: "operator-1",
    });
    await expect(adapter.listRoleKeys("external|subject-1"))
      .resolves.toEqual(new Set(["admin", "editor"]));
    await expect(adapter.listRoleKeys("missing")).resolves.toEqual(new Set());
    await expect(adapter.revokeRole("external|subject-1", "admin")).resolves.toBe(true);
    await expect(adapter.revokeRole("external|subject-1", "admin")).resolves.toBe(false);
    await expect(adapter.listRoleKeys("external|subject-1")).resolves.toEqual(new Set(["editor"]));
    await expect(adapter.listRoleKeys("subject-2")).resolves.toEqual(new Set(["admin"]));
  });

  it("uses only the deployed catalog to interpret persisted role keys", async () => {
    const access = definePermission({ id: "admin.access" });
    const admin = defineRole({ key: "admin", name: "Administrator", permissions: [access] });
    const resolver = new RolePermissionResolver({ roles: [admin], subjectRoleStore: adapter });
    await adapter.grantRole("subject-1", admin.key);
    await adapter.grantRole("subject-1", "unknown");
    await expect(resolver.resolvePermissions("subject-1")).resolves.toEqual(new Set([access.id]));
    // Removing a definition needs no database policy update; retained grants are inert.
    const nextVersion = new RolePermissionResolver({ roles: [], subjectRoleStore: adapter });
    await expect(nextVersion.resolvePermissions("subject-1")).resolves.toEqual(new Set());
    await adapter.revokeRole("subject-1", admin.key);
    await expect(resolver.resolvePermissions("subject-1")).resolves.toEqual(new Set());
  });
});
