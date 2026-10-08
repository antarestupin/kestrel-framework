import { AtlasProvider, viteAtlasClient } from "@kestreljs/framework/atlas";
import { applicationBackoffice } from "../../../admin/index.js";
import type { AppConfig } from "../app_config.js";

/** Owns administration delivery and the access policy to configure before exposing business data. */
export class ApplicationAtlasProvider extends AtlasProvider<AppConfig> {
  public constructor(config: AppConfig["backoffice"]) {
    super(viteAtlasClient({}), {
      enabled: config.enabled,
      atlas: applicationBackoffice,
      // The selected adapter serves the framework's packaged Atlas browser assets.
      // Add application authentication and access middleware here before deployment.
    });
  }
}
