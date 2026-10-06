import { configure } from "@kestreljs/framework/configuration";
// Keep Drizzle's configuration loader independent of browser runtime adapters.
import { studioConfigBase } from "@kestreljs/framework/studio/configuration";
import type { AppConfigurationApi } from "../app_config.js";

/** Mounts developer tooling locally and uses the installed package's prebuilt browser. */
export function createStudioConfig({
  envVar,
  fromEnv,
}: AppConfigurationApi) {
  return configure(studioConfigBase, {
    enabled: fromEnv({
      local: true,
      default: false,
    }),
    devMode: false,
    // This address is opened by the browser, outside the Compose network.
    drizzleStudioUrl: envVar("DRIZZLE_STUDIO_URL", {
      fallback: "https://local.drizzle.studio",
    }),
  });
}
