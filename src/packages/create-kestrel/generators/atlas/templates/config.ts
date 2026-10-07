import { configure, defineConfigBase } from "@kestreljs/framework/configuration";
import { z } from "zod";
import type { AppConfigurationApi } from "../app_config.js";

// Application-owned exposure settings support the conventional APP_CONFIG overrides.
const backofficeConfigBase = defineConfigBase(z.object({ enabled: z.boolean() }));

/** Enable the empty starter locally; configure access checks before enabling deployments. */
export function createBackofficeConfig({
  fromEnv,
}: AppConfigurationApi) {
  return configure(backofficeConfigBase, {
    enabled: fromEnv({
      local: true,
      default: false,
    }),
  });
}
