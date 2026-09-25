import { getTableColumns } from "drizzle-orm";
import {
  getTableConfig,
  type AnyPgTable,
  type PgSchema,
} from "drizzle-orm/pg-core";

import { defineDatabaseSchemaContribution } from "./definition.js";

/** Descriptions attached to one PostgreSQL table and its columns. */
export interface DatabaseTableDescriptions<Table extends AnyPgTable> {
  readonly description?: string;
  readonly columns?: Readonly<Partial<Record<
    keyof Table["$inferSelect"] & string,
    string
  >>>;
}

/** Adds a versioned PostgreSQL comment to a Drizzle schema. */
export function defineDatabaseSchemaDescription<Schema extends PgSchema>(
  schema: Schema,
  description: string,
): Schema {
  assertDescription(description, `schema ${schema.schemaName}`);
  const identifier = quoteIdentifier(schema.schemaName);

  return defineDatabaseSchemaContribution(schema, {
    id: `postgres.schema:${schema.schemaName}:description`,
    installSql: createCommentSql("SCHEMA", identifier, description),
    updateSql: createCommentSql("SCHEMA", identifier, description),
    // Removal runs before Drizzle so schema drops and renames remain harmless.
    uninstallBeforeSql: createCommentRemovalSql("SCHEMA", identifier),
  });
}

/** Adds versioned PostgreSQL comments to a Drizzle table and its columns. */
export function defineDatabaseTableDescriptions<Table extends AnyPgTable>(
  table: Table,
  descriptions: DatabaseTableDescriptions<Table>,
): Table {
  const config = getTableConfig(table);
  const schemaName = config.schema ?? "public";
  const tableIdentifier = qualifiedIdentifier(schemaName, config.name);
  const statements: string[] = [];
  const removalStatements: string[] = [];

  if (descriptions.description !== undefined) {
    assertDescription(
      descriptions.description,
      `table ${schemaName}.${config.name}`,
    );
    statements.push(
      createCommentSql("TABLE", tableIdentifier, descriptions.description),
    );
    removalStatements.push(createCommentRemovalSql("TABLE", tableIdentifier));
  }

  const pendingColumns = new Map(
    Object.entries(descriptions.columns ?? {}),
  );

  // Drizzle's declaration order makes generated migrations deterministic even
  // when callers arrange the description object differently.
  for (const [property, column] of Object.entries(getTableColumns(table))) {
    const description = pendingColumns.get(property);
    if (description === undefined) {
      continue;
    }

    assertDescription(
      description,
      `column ${schemaName}.${config.name}.${column.name}`,
    );
    const columnIdentifier = `${tableIdentifier}.${quoteIdentifier(column.name)}`;
    statements.push(createCommentSql("COLUMN", columnIdentifier, description));
    removalStatements.push(createCommentRemovalSql("COLUMN", columnIdentifier));
    pendingColumns.delete(property);
  }

  const unknownColumn = pendingColumns.keys().next().value as string | undefined;
  if (unknownColumn !== undefined) {
    throw new TypeError(
      `Column description ${schemaName}.${config.name}.${unknownColumn} does not match a Drizzle column property.`,
    );
  }

  if (statements.length === 0) {
    throw new TypeError(
      `Database table descriptions for ${schemaName}.${config.name} require a table or column description.`,
    );
  }

  return defineDatabaseSchemaContribution(table, {
    id: `postgres.table:${schemaName}.${config.name}:descriptions`,
    installSql: statements.join("\n"),
    updateSql: statements.join("\n"),
    // Removal runs before Drizzle so table drops and renames remain harmless.
    uninstallBeforeSql: removalStatements.join("\n"),
  });
}

function createCommentSql(
  objectKind: "COLUMN" | "SCHEMA" | "TABLE",
  identifier: string,
  description: string,
): string {
  return `COMMENT ON ${objectKind} ${identifier} IS '${escapeLiteral(description)}';`;
}

function createCommentRemovalSql(
  objectKind: "COLUMN" | "SCHEMA" | "TABLE",
  identifier: string,
): string {
  return `COMMENT ON ${objectKind} ${identifier} IS NULL;`;
}

function qualifiedIdentifier(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function escapeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function assertDescription(description: string, target: string): void {
  if (description.trim() === "") {
    throw new TypeError(`Database description for ${target} cannot be empty.`);
  }
}
