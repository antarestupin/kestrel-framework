import type { StudioDatabaseLayout } from "./contract.js";

/** Shared HTML/SVG filter: mixed schemas and tables without provenance stay visible. */
export function filterDatabaseLayout(layout: StudioDatabaseLayout, hideFramework: boolean): StudioDatabaseLayout {
  if (!hideFramework) return layout;
  return {
    schemas: layout.schemas.flatMap((schema) => {
      // Drizzle owns this migration schema outside the exported table definitions.
      if (schema.name === "drizzle") return [];
      const tables = schema.tables.filter((table) => table.origin !== "framework");
      return tables.length === 0 ? [] : [{ ...schema, tables }];
    }),
  };
}
