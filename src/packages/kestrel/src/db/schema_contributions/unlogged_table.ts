import {
  getTableConfig,
  type AnyPgTable,
} from "drizzle-orm/pg-core";

import { quoteSqlBody } from "../sql_dollar_quote.js";
import { defineDatabaseSchemaContribution } from "./definition.js";

/** Marks a disposable PostgreSQL table as UNLOGGED in generated migrations. */
export function defineUnloggedTable<Table extends AnyPgTable>(table: Table): Table {
  const config = getTableConfig(table);
  const schema = config.schema ?? "public";
  const identifier = qualifiedIdentifier(config.schema, config.name);
  const registrationName = `${schema}.${config.name}`;
  const cleanup = `BEGIN
  IF to_regclass('${escapeLiteral(identifier)}') IS NOT NULL THEN
    ALTER TABLE ${identifier} SET LOGGED;
  END IF;
END`;

  return defineDatabaseSchemaContribution(table, {
    id: `postgres.table:${registrationName}:unlogged`,
    installSql: `ALTER TABLE ${identifier} SET UNLOGGED;`,
    updateSql: `ALTER TABLE ${identifier} SET UNLOGGED;`,
    // Cleanup happens after Drizzle so table drops and renames are harmless.
    uninstallAfterSql: `DO ${quoteSqlBody(cleanup, "database_schema")};`,
  });
}

function qualifiedIdentifier(schema: string | undefined, name: string): string {
  return schema === undefined
    ? quoteIdentifier(name)
    : `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function escapeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
