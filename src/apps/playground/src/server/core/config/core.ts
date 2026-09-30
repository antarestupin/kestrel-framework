import { fileURLToPath } from "node:url";
import type { AppConfigurationApi } from "../appConfig.js";

/** Resolve filesystem paths independently of the launcher's working directory. */
export function createCoreConfig({ defineConfig, envVar, fromEnv, envs }: AppConfigurationApi) {
  const runtimeRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  return defineConfig({
    debug: fromEnv({ ...envs(["local", "test"], true), default: false }),
    runtimeRoot,
    projectRoot: envVar("PROJECT_ROOT", { fallback: runtimeRoot }),
  });
}
