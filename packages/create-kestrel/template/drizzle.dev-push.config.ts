import { defineConfig } from "drizzle-kit";
import { drizzleDatabaseCredentials, drizzleEnvironment } from "./drizzle.database.js";
import { developmentSchemaFilter, developmentTablesFilter } from "./src/server/core/db/development_schema.js";

if (drizzleEnvironment !== "local") throw new Error("Development schema push requires the local environment.");

// Restrict the diff to disposable tables; the application note table remains migration-owned.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/core/db/schema/push_schema.ts",
  schemaFilter: developmentSchemaFilter,
  tablesFilter: developmentTablesFilter,
  dbCredentials: drizzleDatabaseCredentials,
});
