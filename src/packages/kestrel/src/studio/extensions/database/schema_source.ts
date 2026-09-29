import type {
  Pool,
  QueryResultRow,
} from "pg";

import type {
  StudioDatabaseColumn,
  StudioDatabaseLayout,
  StudioDatabaseSchema,
  StudioDatabaseTable,
} from "./contract.js";

interface DatabaseSchemaRow extends QueryResultRow {
  schema_name: string;
  schema_description: string | null;
  table_name: string;
  table_description: string | null;
  relation_kind: "p" | "r";
  column_position: number | null;
  column_name: string | null;
  column_description: string | null;
  column_type: string | null;
  nullable: boolean;
  primary_key: boolean;
}

interface MutableDatabaseSchema extends Omit<StudioDatabaseSchema, "tables"> {
  tables: MutableDatabaseTable[];
}

interface MutableDatabaseTable extends Omit<StudioDatabaseTable, "columns"> {
  columns: StudioDatabaseColumn[];
}

export interface DatabaseSchemaSource {
  getLayout(): Promise<StudioDatabaseLayout>;
}

/**
 * Reads the database catalog through the same PostgreSQL pool as the app.
 * Keeping the raw catalog rows private prevents PostgreSQL details from
 * leaking into the Studio transport contract.
 */
export class PostgresDatabaseSchemaSource implements DatabaseSchemaSource {
  public constructor(private readonly pool: Pick<Pool, "query">) {}

  public async getLayout(): Promise<StudioDatabaseLayout> {
    const result = await this.pool.query<DatabaseSchemaRow>(`
      SELECT
        namespace.nspname AS schema_name,
        pg_catalog.obj_description(
          namespace.oid,
          'pg_namespace'
        ) AS schema_description,
        relation.relname AS table_name,
        pg_catalog.obj_description(
          relation.oid,
          'pg_class'
        ) AS table_description,
        relation.relkind AS relation_kind,
        attribute.attnum AS column_position,
        attribute.attname AS column_name,
        pg_catalog.col_description(
          relation.oid,
          attribute.attnum
        ) AS column_description,
        pg_catalog.format_type(
          attribute.atttypid,
          attribute.atttypmod
        ) AS column_type,
        NOT attribute.attnotnull AS nullable,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_index AS relation_index
          WHERE relation_index.indrelid = relation.oid
            AND relation_index.indisprimary
            AND attribute.attnum = ANY(relation_index.indkey)
        ) AS primary_key
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      WHERE relation.relkind IN ('r', 'p')
        AND namespace.nspname <> 'information_schema'
        AND namespace.nspname !~ '^pg_'
      ORDER BY
        namespace.nspname,
        relation.relname,
        attribute.attnum
    `);

    return groupDatabaseSchemaRows(result.rows);
  }
}

/** Groups the ordered catalog result into the compact client contract. */
function groupDatabaseSchemaRows(
  rows: readonly DatabaseSchemaRow[],
): StudioDatabaseLayout {
  const schemas = new Map<string, {
    schema: MutableDatabaseSchema;
    tables: Map<string, MutableDatabaseTable>;
  }>();

  for (const row of rows) {
    let schemaEntry = schemas.get(row.schema_name);

    if (schemaEntry === undefined) {
      schemaEntry = {
        schema: {
          name: row.schema_name,
          ...descriptionProperty(row.schema_description),
          tables: [],
        },
        tables: new Map(),
      };
      schemas.set(row.schema_name, schemaEntry);
    }

    let table = schemaEntry.tables.get(row.table_name);

    if (table === undefined) {
      table = {
        name: row.table_name,
        ...descriptionProperty(row.table_description),
        kind: row.relation_kind === "p" ? "partitioned-table" : "table",
        columns: [],
      };
      schemaEntry.tables.set(row.table_name, table);
      schemaEntry.schema.tables.push(table);
    }

    // PostgreSQL permits zero-column tables, which the LEFT JOIN preserves.
    if (row.column_name === null || row.column_type === null) {
      continue;
    }

    const column: StudioDatabaseColumn = {
      name: row.column_name,
      ...descriptionProperty(row.column_description),
      type: row.column_type,
      nullable: row.nullable,
      primaryKey: row.primary_key,
    };
    table.columns.push(column);
  }

  return {
    schemas: [...schemas.values()].map(({ schema }) => schema),
  };
}

/** Omits absent comments from the compact Studio response. */
function descriptionProperty(
  description: string | null,
): { description?: string } {
  return description === null ? {} : { description };
}
