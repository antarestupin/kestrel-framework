import { readDatabaseConfig } from "./src/server/core/db/configuration.js";
import { readEnvironment } from "./src/server/core/environment.js";

// Drizzle tooling shares application credentials without loading application composition.
export const drizzleEnvironment = readEnvironment();
export const drizzleDatabaseCredentials = readDatabaseConfig();
