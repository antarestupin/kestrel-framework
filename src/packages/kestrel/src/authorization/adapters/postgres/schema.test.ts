import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it, vi } from "vitest";

it("exports the expected assignment table keys, columns and migration metadata", async () => {
  // Import declarations in the test so invalid schema mutants fail here.
  vi.resetModules();
  const { getFrameworkDatabaseTableKeys } = await import("../../../db/framework_table.js");
  const { getDatabaseSchemaContributions } = await import("../../../db/schema_contributions/index.js");
  const { authorizationSqlSchema, authorizationSubjectRoles, authorizationTables } = await import("./schema.js");
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
