// Configures the HTTP listener, request logging, and generated client audiences and output paths.
// Use HOST and PORT for listener overrides and adjust client-generation settings here.

import { fileURLToPath } from "node:url";
import { configure } from "@kestrel/framework/configuration";
import { httpConfigBase } from "@kestrel/framework/http";
import type { AppConfigurationApi } from "../appConfig.js";

/** HTTP runtime and client generation share the application's resolved configuration. */
export function createHttpConfig({
  envVar,
  fromEnv,
  envs,
}: AppConfigurationApi) {
  return configure(httpConfigBase, {
    host: envVar("HOST", {
      fallback: "127.0.0.1",
    }),
    port: envVar("PORT"),
    fastifyLogs: fromEnv({
      ...envs(["local", "test"], false),
      default: true,
    }),
    clientGeneration: {
      audiences: {
        audiences: ["public"],
        defaultAudiences: ["public"],
      },
      generators: [{
        name: "public",
        audiences: ["public"],
        factoryName: "createPublicClient",
        // Keep the public contract and its server links in their existing generated directory.
        outputFile: fileURLToPath(new URL("../../../generated/publicClient/publicClient.ts", import.meta.url)),
        catalogImportPath: "../../server/core/appCatalog.js",
        runtimeImportPath: "@kestrel/framework/http/client",
      }],
    },
  });
}
