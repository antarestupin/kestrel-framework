export const DATABASE_SCHEMA_PAGE_KIND = "database-schema";

/** Serializable database layout shared by the Studio API and client. */
export interface StudioDatabaseLayout {
  schemas: readonly StudioDatabaseSchema[];
}

/** One PostgreSQL schema and the tables visible to the application role. */
export interface StudioDatabaseSchema {
  name: string;
  description?: string;
  tables: readonly StudioDatabaseTable[];
}

/** Table metadata rendered as one card in the database layout. */
export interface StudioDatabaseTable {
  name: string;
  description?: string;
  kind: "table" | "partitioned-table";
  columns: readonly StudioDatabaseColumn[];
}

/** Column metadata kept deliberately small for the initial read-only view. */
export interface StudioDatabaseColumn {
  name: string;
  description?: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}
