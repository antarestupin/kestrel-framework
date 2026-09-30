import type { AppConfigurationApi } from "../appConfig.js";

/** Tests exercise HTTP contracts without mounting Vite or requiring a browser build. */
export function createClientConfig({ fromEnv }: AppConfigurationApi) {
  return {
    enabled: fromEnv({ test: false, default: true }),
    devMode: fromEnv({ local: true, default: false }),
  };
}
