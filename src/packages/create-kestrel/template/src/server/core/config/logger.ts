// Configures console logging defaults by environment and the LOG_LEVEL override.
// Adjust logging settings here; tests default to silent output.

import { configure } from "@kestrel/framework/configuration";
import { loggerConfigBase } from "@kestrel/framework/log";
import type { AppConfigurationApi } from "../appConfig.js";

/** Keep the existing console logger, with quiet tests and an explicit level override. */
export function createLoggerConfig({
  envVar,
  fromEnv,
}: AppConfigurationApi) {
  return configure(loggerConfigBase, {
    level: fromEnv({
      test: envVar("LOG_LEVEL", {
        fallback: "silent",
      }),
      default: envVar("LOG_LEVEL", {
        fallback: "info",
      }),
    }),
  });
}
