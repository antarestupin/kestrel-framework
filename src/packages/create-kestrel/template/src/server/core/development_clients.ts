import { resolve } from "node:path";
import {
  ViteDevelopmentRuntime,
  type ViteDevelopmentRuntimeOptions,
} from "@kestreljs/framework/client";
import type { AppConfig } from "./app_config.js";

/** Owns the application's single lazy Vite runtime; installed Studio assets need no HMR server. */
export function createDevelopmentClients(
  config: Pick<AppConfig, "core" | "client">,
  createRuntime = (options: ViteDevelopmentRuntimeOptions) => new ViteDevelopmentRuntime(options),
) {
  const runtime = config.client.enabled && config.client.devMode
    ? createRuntime({
      root: config.core.runtimeRoot,
      configFile: resolve(config.core.runtimeRoot, "vite.development.config.ts"),
    })
    : undefined;

  return {
    application: runtime?.entry({ root: "src/client" }),
  };
}
