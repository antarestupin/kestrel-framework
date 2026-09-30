import { appConfig, environment } from "./src/server/core/appConfig.js";

// Share the resolved configuration, including overrides, without loading application composition.
export const drizzleEnvironment = environment;
export const drizzleDatabaseCredentials = appConfig.database;
