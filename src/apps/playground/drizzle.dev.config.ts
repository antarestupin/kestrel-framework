// Configures local Drizzle Studio access to application and development tables.
// Use drizzle.dev-push.config.ts when synchronizing disposable development tables.

import { defineConfig } from "drizzle-kit";
import { drizzleDatabaseCredentials, drizzleEnvironment } from "./drizzle.database.js";

if (drizzleEnvironment !== "local") throw new Error("Development database tooling requires the local environment.");

// Browse both schemas; only the separate push configuration may synchronize local objects.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/core/db/schema/dev_schema.ts",
  dbCredentials: drizzleDatabaseCredentials,
});
