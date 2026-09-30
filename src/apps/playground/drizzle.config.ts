// Configures deployment migration generation from the application database schema.
// Keep development-only tables in the separate Drizzle development configurations.

import { defineConfig } from "drizzle-kit";
import { drizzleDatabaseCredentials } from "./drizzle.database.js";

// Keep the deployment history beside the application database schema and tooling.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/core/db/schema/app_schema.ts",
  out: "./src/server/core/db/migrations",
  dbCredentials: drizzleDatabaseCredentials,
});
