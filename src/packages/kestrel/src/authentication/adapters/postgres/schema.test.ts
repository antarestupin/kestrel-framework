import { getTableColumns, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type AnyPgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { getFrameworkDatabaseTableKeys } from "../../../db/framework_table.js";
import { getDatabaseSchemaContributions } from "../../../db/schema_contributions/definition.js";
import {
  authenticationAccounts,
  authenticationPasswordCredentials,
  authenticationSessions,
  authenticationSqlSchema,
  authenticationTables,
} from "./schema.js";

const productionSchema = {
  authenticationSqlSchema,
  authenticationAccounts,
  authenticationPasswordCredentials,
  authenticationSessions,
};

/** Lock the SQL surface used by migrations and application-owned maintenance queries. */
function columnContracts(table: AnyPgTable) {
  return Object.fromEntries(Object.entries(getTableColumns(table)).map(([name, column]) =>
    [name, [column.name, column.getSQLType(), column.notNull]],
  ));
}

const timestamp = (name: string, notNull = true) => [name, "timestamp with time zone", notNull];

describe("bundled PostgreSQL authentication schema", () => {
  it("preserves the published table and column mappings", () => {
    expect(authenticationTables).toEqual({
      accounts: authenticationAccounts,
      passwordCredentials: authenticationPasswordCredentials,
      sessions: authenticationSessions,
    });
    expect(authenticationSqlSchema.schemaName).toBe("authentication");
    expect(getTableConfig(authenticationAccounts)).toMatchObject({ name: "account", schema: "authentication" });
    expect(getTableConfig(authenticationPasswordCredentials))
      .toMatchObject({ name: "password_credentials", schema: "authentication" });
    expect(getTableConfig(authenticationSessions)).toMatchObject({ name: "session", schema: "authentication" });

    expect(columnContracts(authenticationAccounts)).toEqual({
      id: ["id", "uuid", true], subjectId: ["subject_id", "text", true],
      state: ["state", "text", true], securityVersion: ["security_version", "integer", true],
      createdAt: timestamp("created_at"), updatedAt: timestamp("updated_at"),
    });
    expect(columnContracts(authenticationPasswordCredentials)).toEqual({
      id: ["id", "uuid", true], accountId: ["account_id", "uuid", true],
      username: ["username", "text", true], normalizedUsername: ["normalized_username", "text", true],
      passwordHash: ["password_hash", "text", true], passwordChangedAt: timestamp("password_changed_at"),
      createdAt: timestamp("created_at"), updatedAt: timestamp("updated_at"),
    });
    expect(columnContracts(authenticationSessions)).toEqual({
      id: ["id", "uuid", true], accountId: ["account_id", "uuid", true],
      tokenDigest: ["token_digest", "bytea", true], claims: ["claims", "jsonb", true],
      accountSecurityVersion: ["account_security_version", "integer", true],
      authenticationMethod: ["authentication_method", "text", true],
      authenticationFactors: ["authentication_factors", "text[]", true],
      authenticatedAt: timestamp("authenticated_at"), createdAt: timestamp("created_at"),
      lastSeenAt: timestamp("last_seen_at"), idleExpiresAt: timestamp("idle_expires_at"),
      absoluteExpiresAt: timestamp("absolute_expires_at"), revokedAt: timestamp("revoked_at", false),
      revokeReason: ["revoke_reason", "text", false], ipAddress: ["ip_address", "text", false],
      userAgent: ["user_agent", "text", false],
    });
  });

  it("declares identity constraints, retention indexes and account-owned children", () => {
    const dialect = new PgDialect();
    const indexes = (table: AnyPgTable) => getTableConfig(table).indexes.map(({ config }) => [
      config.name, config.unique, config.columns.map((column) => "name" in column ? column.name : undefined),
      config.where === undefined ? undefined : dialect.sqlToQuery(config.where).sql,
    ]);
    const checks = (table: AnyPgTable) => getTableConfig(table).checks.map(({ name, value }) => [
      name, dialect.sqlToQuery(value).sql,
    ]);

    expect(indexes(authenticationAccounts)).toEqual([
      ["authentication_account_subject_id_unique", true, ["subject_id"], undefined],
    ]);
    expect(indexes(authenticationPasswordCredentials)).toEqual([
      ["authentication_password_credentials_account_id_unique", true, ["account_id"], undefined],
      ["authentication_password_credentials_username_unique", true, ["normalized_username"], undefined],
    ]);
    expect(indexes(authenticationSessions)).toEqual([
      ["authentication_session_token_digest_unique", true, ["token_digest"], undefined],
      ["authentication_session_account_created_idx", false, ["account_id", "created_at"], undefined],
      ["authentication_session_active_expiry_idx", false, ["idle_expires_at", "absolute_expires_at"],
        '"authentication"."session"."revoked_at" is null'],
    ]);
    expect(checks(authenticationAccounts)).toEqual([
      ["authentication_account_state_check", `"authentication"."account"."state" in ('active', 'disabled')`],
      ["authentication_account_security_version_check", '"authentication"."account"."security_version" > 0'],
    ]);
    expect(checks(authenticationSessions)).toEqual([
      ["authentication_session_security_version_check", '"authentication"."session"."account_security_version" > 0'],
    ]);
    for (const table of [authenticationPasswordCredentials, authenticationSessions]) {
      const foreignKeys = getTableConfig(table).foreignKeys;
      expect(foreignKeys).toHaveLength(1);
      expect(foreignKeys[0]!.onDelete).toBe("cascade");
      const reference = foreignKeys[0]!.reference();
      expect(reference.columns).toEqual([table.accountId]);
      expect(reference.foreignColumns).toEqual([authenticationAccounts.id]);
    }
  });

  it("declares database-generated identifiers, initial account state and record timestamps", () => {
    const dialect = new PgDialect();
    for (const table of [authenticationAccounts, authenticationPasswordCredentials, authenticationSessions]) {
      expect(table.id.primary).toBe(true);
    }
    for (const id of [authenticationAccounts.id, authenticationPasswordCredentials.id]) {
      expect(id.default).toBeInstanceOf(SQL);
      expect(dialect.sqlToQuery(id.default as SQL).sql).toBe("uuidv7()");
    }
    expect(authenticationSessions.id.hasDefault).toBe(false);
    expect(authenticationAccounts.state.default).toBe("active");
    expect(authenticationAccounts.securityVersion.default).toBe(1);
    for (const column of [
      authenticationAccounts.createdAt, authenticationAccounts.updatedAt,
      authenticationPasswordCredentials.passwordChangedAt,
      authenticationPasswordCredentials.createdAt, authenticationPasswordCredentials.updatedAt,
    ]) {
      expect(column.default).toBeInstanceOf(SQL);
      expect(dialect.sqlToQuery(column.default as SQL).sql).toBe("now()");
    }
  });

  it("marks framework-owned tables and supplies migration descriptions for their columns", () => {
    expect(getFrameworkDatabaseTableKeys(productionSchema)).toEqual(new Set([
      '["authentication","account"]', '["authentication","password_credentials"]',
      '["authentication","session"]',
    ]));
    const descriptions = new Map(getDatabaseSchemaContributions(productionSchema).map(({ id, installSql }) =>
      [id, installSql],
    ));
    expect(descriptions.get("postgres.schema:authentication:description"))
      .toMatch(/COMMENT ON SCHEMA "authentication" IS '[^']/);
    for (const table of [authenticationAccounts, authenticationPasswordCredentials, authenticationSessions]) {
      const { name, columns } = getTableConfig(table);
      const description = descriptions.get(`postgres.table:authentication.${name}:descriptions`);
      expect(description).toContain(`COMMENT ON TABLE "authentication"."${name}" IS '`);
      for (const column of columns) {
        expect(description).toContain(`COMMENT ON COLUMN "authentication"."${name}"."${column.name}" IS`);
      }
      // Descriptions should remain useful in migration and catalog output.
      expect(description).not.toContain("IS '';");
    }
  });
});
