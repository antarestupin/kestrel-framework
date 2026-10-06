// Shares resolved application database credentials and environment with Drizzle tooling.
// Configure connection values in src/server/core/config/database.ts and environment variables.

import { appConfig, environment } from "./src/server/core/app_config.js";

// Share the resolved configuration, including overrides, without loading application composition.
export const drizzleEnvironment = environment;
export const drizzleDatabaseCredentials = appConfig.database;
