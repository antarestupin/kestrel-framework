import { configurationApi, environment } from "./config/environment.js";
import { createCoreConfig } from "./config/core.js";
import { createDatabaseConfig } from "./config/database.js";
import { createHttpConfig } from "./config/http.js";
import { createClientConfig } from "./config/client.js";
import { createLoggerConfig } from "./config/logger.js";

export { environment, type Environment, type AppConfigurationApi } from "./config/environment.js";

// Each feature owns its configuration contribution; no providers are loaded here.
const configDefinition = configurationApi.defineConfig({
  core: createCoreConfig(configurationApi),
  database: createDatabaseConfig(configurationApi),
  http: createHttpConfig(configurationApi),
  client: createClientConfig(configurationApi),
  logger: createLoggerConfig(configurationApi),
});

/** Fully resolved application settings, including supported APP_CONFIG overrides. */
export const appConfig = configurationApi.resolveConfig(configDefinition, { environment, env: process.env });
export type AppConfig = typeof appConfig;
