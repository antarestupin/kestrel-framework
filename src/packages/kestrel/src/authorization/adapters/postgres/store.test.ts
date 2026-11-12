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

import { PostgresDrizzleManager } from "../../../db/index.js";
import type { AdapterDependencyResolver } from "../../../di/adapter.js";
import { dep } from "../../../di/index.js";
import { createPostgresTestPool } from "../../../testing/postgres.js";
import { postgresSubjectRoles } from "./definition.js";
import { definePermission, defineRole } from "../../definition.js";
import { RolePermissionResolver } from "../../resolvers/roles/index.js";
import type { PostgresAuthorizationTables } from "./tables.js";
import type { SubjectRoleStorageAdapter } from "../../types.js";

const testSubjectRoles = pgTable("authorization_subject_role_test", {
  subjectId: text("subject_id").notNull(),
  roleKey: text("role_key").notNull(),
  grantedAt: timestamp("granted_at", { mode: "date", withTimezone: true })
    .defaultNow().notNull(),
  grantedBySubjectId: text("granted_by_subject_id"),
});

let pool: Pool;
let client: PoolClient;
let adapter: SubjectRoleStorageAdapter;

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
  const manager = new PostgresDrizzleManager({
    database: database as ConstructorParameters<typeof PostgresDrizzleManager>[0]["database"],
  });
  const dependency = dep<PostgresDrizzleManager>("databaseManager");
  const definition = postgresSubjectRoles(dependency, {
    subjectRoles: testSubjectRoles,
  } satisfies PostgresAuthorizationTables);
  // The scoped container normally resolves this execution's borrowed manager.
  const resolve = (descriptor: unknown) => {
    expect(descriptor).toBe(dependency);
    return manager;
  };
  adapter = definition.create(resolve as AdapterDependencyResolver, undefined);
});

beforeEach(async () => {
  await client.query("TRUNCATE authorization_subject_role_test");
});

afterAll(async () => {
  client?.release();
  await pool?.end();
});

describe("PostgresSubjectRoleStorageAdapter", () => {
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

  it("reports first and duplicate grants separately and scopes stale revocation to the exact pair", async () => {
    // Assert each outcome in order. A sorted pair would also accept inverted booleans.
    await expect(adapter.grantRole("subject-1", "editor")).resolves.toBe(true);
    await expect(adapter.grantRole("subject-1", "editor", "operator")).resolves.toBe(false);
    await expect(adapter.grantRole("subject-2", "admin", "operator")).resolves.toBe(true);

    // A matching role on another subject and a different role on this subject are both irrelevant.
    await expect(adapter.revokeRole("subject-1", "admin")).resolves.toBe(false);
    await expect(adapter.listRoleKeys("subject-1")).resolves.toEqual(new Set(["editor"]));
    await expect(adapter.listRoleKeys("subject-2")).resolves.toEqual(new Set(["admin"]));
    const metadata = await client.query<{ granted_by_subject_id: string | null }>(
      "SELECT granted_by_subject_id FROM authorization_subject_role_test WHERE subject_id = $1 AND role_key = $2",
      ["subject-1", "editor"],
    );
    expect(metadata.rows).toEqual([{ granted_by_subject_id: null }]);
  });
});
