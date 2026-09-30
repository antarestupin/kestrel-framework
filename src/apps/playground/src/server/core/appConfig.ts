// Combines feature configuration factories and resolves settings for the selected environment.
// Register new configuration sections here and define their defaults and overrides in config/.

import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createConfigurationApi } from "@kestrel/framework/configuration";
import { createCoreConfig } from "./config/core.js";
import { createDatabaseConfig } from "./config/database.js";
import { createHttpConfig } from "./config/http.js";
import { createClientConfig } from "./config/client.js";
import { createLoggerConfig } from "./config/logger.js";
import { createStudioConfig } from "./config/studio.js";

/** Application-specialized configuration primitives shared with config factories. */
const configurationApi = createConfigurationApi({
  environments: ["local", "test", "stage", "prod"],
  defaultEnvironment: "local",
  environmentOverrides: {
    prefix: "APP_CONFIG",
  },
});
export type AppConfigurationApi = typeof configurationApi;
export type Environment = (typeof configurationApi.environments)[number];

// Environment selection and local dotenv loading belong to this configuration boundary.
export const environment = configurationApi.resolveEnvironment(
  process.env.ENVIRONMENT
    ?? (process.env.NODE_ENV === "production" ? "prod" : process.env.NODE_ENV === "test" ? "test" : undefined),
);
if (environment === "local") {
  try {
    loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// Each feature owns its configuration contribution; no providers are loaded here.
const configDefinition = configurationApi.defineConfig({
  core: createCoreConfig(configurationApi),
  database: createDatabaseConfig(configurationApi),
  http: createHttpConfig(configurationApi),
  client: createClientConfig(configurationApi),
  logger: createLoggerConfig(configurationApi),
  studio: createStudioConfig(configurationApi),
});

/** Fully resolved application settings, including supported APP_CONFIG overrides. */
export const appConfig = configurationApi.resolveConfig(configDefinition, {
  environment,
  env: process.env,
});
export type AppConfig = typeof appConfig;
