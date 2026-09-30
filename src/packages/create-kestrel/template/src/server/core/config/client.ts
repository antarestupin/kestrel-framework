// Controls browser delivery and Vite development mode for each application environment.
// Adjust these defaults when deciding which environments should serve the frontend.

import type { AppConfigurationApi } from "../appConfig.js";

/** Tests exercise HTTP contracts without mounting Vite or requiring a browser build. */
export function createClientConfig({ fromEnv }: AppConfigurationApi) {
  return {
    enabled: fromEnv({ test: false, default: true }),
    devMode: fromEnv({ local: true, default: false }),
  };
}
