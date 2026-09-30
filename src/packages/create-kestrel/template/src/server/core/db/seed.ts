// Defines migration location, local database reset boundaries, and deterministic seed data.
// Customize seed records and reset schemas here; reset deletes data inside those schemas.

import { fileURLToPath } from "node:url";
import { defineDatabaseMaintenance, defineDatabaseSeed } from "@kestreljs/framework/database/seeder";
import { developmentSchemaFilter, developmentTablesFilter } from "./development_schema.js";
import * as localSchema from "./schema/push_schema.js";
import { note } from "./schema/app_schema.js";

/** Application-owned reset boundaries and deterministic example data. */
export const applicationDatabaseMaintenance = defineDatabaseMaintenance({
  migration: { migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)) },
  reset: {
    schemas: ["public", "dev", "drizzle"],
    push: { schema: localSchema, schemaFilter: developmentSchemaFilter, tablesFilter: developmentTablesFilter },
  },
  seed: defineDatabaseSeed({
    steps: [{ type: "records", key: "note", table: note, records: () => [{
      key: "welcome",
      values: { id: "00000000-0000-4000-8000-000000000001", content: "Welcome to Kestrel." },
    }] }],
  }),
});
