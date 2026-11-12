import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it, vi } from "vitest";

import { App } from "../../../app/index.js";
import { PostgresDrizzleManager } from "../../../db/index.js";
import { getFrameworkDatabaseTableKeys } from "../../../db/framework_table.js";
import { getDatabaseSchemaContributions } from "../../../db/schema_contributions/index.js";
import { dep, registerScopedAdapter } from "../../../di/index.js";
import { subjectRoleStoreDependency } from "../../dependencies.js";
import { postgresSubjectRoles } from "./definition.js";
import { authorizationSqlSchema, authorizationSubjectRoles, authorizationTables } from "./schema.js";

it("exports the expected assignment table keys, columns and migration metadata", () => {
  const table = getTableConfig(authorizationSubjectRoles);

  // The runtime table and the exported migration inputs must describe the same contract.
  expect(authorizationTables.subjectRoles).toBe(authorizationSubjectRoles);
  expect(table).toMatchObject({ schema: "authorization", name: "subject_role", foreignKeys: [] });
  expect(table.columns.map((column) => ({
    name: column.name, dataType: column.dataType, sqlType: column.getSQLType(),
    notNull: column.notNull, hasDefault: column.hasDefault,
  }))).toEqual([
    { name: "subject_id", dataType: "string", sqlType: "text", notNull: true, hasDefault: false },
    { name: "role_key", dataType: "string", sqlType: "text", notNull: true, hasDefault: false },
    { name: "granted_at", dataType: "date", sqlType: "timestamp with time zone", notNull: true, hasDefault: true },
    { name: "granted_by_subject_id", dataType: "string", sqlType: "text", notNull: false, hasDefault: false },
  ]);
  expect(table.primaryKeys.map(({ columns }) => columns.map((column) => column.name)))
    .toEqual([["subject_id", "role_key"]]);
  expect(table.indexes.map(({ config }) => ({
    name: config.name,
    columns: config.columns.map((column) => "name" in column ? column.name : undefined),
  }))).toEqual([{ name: "authorization_subject_role_role_idx", columns: ["role_key"] }]);
  expect(getFrameworkDatabaseTableKeys({ authorizationSubjectRoles }))
    .toEqual(new Set([JSON.stringify(["authorization", "subject_role"])]));
  const contributions = getDatabaseSchemaContributions({ authorizationSqlSchema, authorizationSubjectRoles });
  expect(contributions.map(({ id }) => id)).toEqual([
    "postgres.schema:authorization:description",
    "postgres.table:authorization.subject_role:descriptions",
  ]);
  // Keep the documented columns visible in generated migrations without freezing their prose.
  const tableDescriptions = contributions.find(({ id }) => id === "postgres.table:authorization.subject_role:descriptions");
  for (const column of ["subject_id", "role_key", "granted_at", "granted_by_subject_id"]) {
    expect(tableDescriptions?.installSql).toContain(`COMMENT ON COLUMN "authorization"."subject_role"."${column}" IS `);
  }
});

it("uses the default table and resolves a distinct borrowed manager in each execution", async () => {
  // Keep real Drizzle SQL compilation and substitute only its driver transport.
  const query = vi.fn().mockResolvedValueOnce({ rows: [["editor"]] })
    .mockResolvedValueOnce({ rows: [["reviewer"]] });
  const database = drizzle({ client: { query } as never });
  const createManager = vi.fn(() => new PostgresDrizzleManager({ database }));
  const manager = dep<PostgresDrizzleManager>("authorizationDatabaseManager");
  const app = new App({});
  app.container.registerFactory(manager.id, createManager, { lifetime: "scoped" });
  registerScopedAdapter(app.container, subjectRoleStoreDependency.id, postgresSubjectRoles(manager), undefined);

  try {
    await app.start();
    expect(createManager).not.toHaveBeenCalled();
    for (const [subject, role] of [["subject-1", "editor"], ["subject-2", "reviewer"]] as const) {
      const execution = await app.createExecutionScope();
      try {
        const store = execution.container.resolve(subjectRoleStoreDependency);
        expect(execution.container.resolve(subjectRoleStoreDependency)).toBe(store);
        await expect(store.listRoleKeys(subject)).resolves.toEqual(new Set([role]));
      } finally {
        await execution.dispose();
      }
    }
    expect(createManager).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([statement, parameters]) => [statement.text, parameters])).toEqual([
      [expect.stringContaining('from "authorization"."subject_role"'), ["subject-1"]],
      [expect.stringContaining('from "authorization"."subject_role"'), ["subject-2"]],
    ]);
  } finally {
    await app.dispose();
  }
});
