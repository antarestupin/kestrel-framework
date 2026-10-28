import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";

const frameworkTable = Symbol.for("kestrel.database.frameworkTable");

/** Internal provenance marker: no SQL, global table registry or application annotation. */
export function markFrameworkDatabaseTable<Table extends AnyPgTable>(table: Table): Table {
  if (!Object.hasOwn(table, frameworkTable)) {
    Object.defineProperty(table, frameworkTable, { value: true, enumerable: false });
  }
  return table;
}

/** Discover only marked definitions exported by this application's combined schema. */
export function getFrameworkDatabaseTableKeys(schema: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const value of Object.values(schema)) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, frameworkTable)) continue;
    const config = getTableConfig(value as AnyPgTable);
    keys.add(JSON.stringify([config.schema ?? "public", config.name]));
  }
  return keys;
}
