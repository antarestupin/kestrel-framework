// Declares supported environments, selects ENVIRONMENT or NODE_ENV, and loads .env locally.
// Configure the APP_CONFIG override prefix and shared configuration API here.

import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createConfigurationApi } from "@kestrel/framework/configuration";

/** Typed environments and conventional overrides shared by all configuration factories. */
export const configurationApi = createConfigurationApi({
  environments: ["local", "test", "stage", "prod"],
  defaultEnvironment: "local",
  environmentOverrides: { prefix: "APP_CONFIG" },
});
export type AppConfigurationApi = typeof configurationApi;
export type Environment = (typeof configurationApi.environments)[number];

// Preserve NODE_ENV compatibility while giving the explicit application environment priority.
export const environment = configurationApi.resolveEnvironment(process.env.ENVIRONMENT
  ?? (process.env.NODE_ENV === "production" ? "prod" : process.env.NODE_ENV === "test" ? "test" : undefined));
if (environment === "local") {
  try {
    loadEnvFile(fileURLToPath(new URL("../../../../.env", import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
