import { fileURLToPath } from "node:url";
import { App } from "@kestrel/framework/app";
import { DatabaseProvider } from "@kestrel/framework/db";
import { LoggerProvider } from "@kestrel/framework/log";
import { HttpRuntimeProvider, httpRuntimeDependency } from "@kestrel/framework/http";
import { ClientProvider, ViteClientAdapter } from "@kestrel/framework/client";
import { appCatalog } from "./appCatalog.js";
import { readAppConfig } from "./appConfig.js";

/** Compose a fresh owned application for each process or integration test. */
export function createApp({ web = true } = {}) {
  const config = readAppConfig();
  const app = new App(config, { catalog: appCatalog });
  app.register(new LoggerProvider(config.logger));
  app.register(new DatabaseProvider(config.database));
  app.register(new HttpRuntimeProvider({
    host: "127.0.0.1", port: config.port, fastifyLogs: false, executionIdHeader: "x-execution-id",
    clientGeneration: {
      audiences: { audiences: ["public"], defaultAudiences: ["public"] },
      generators: [{ name: "public", audiences: ["public"], factoryName: "createPublicClient", outputFile: "src/client/api.ts", catalogImportPath: "../server/core/appCatalog.js", runtimeImportPath: "@kestrel/framework/http/client" }],
    },
  }));
  if (web) app.register(new ClientProvider({ adapter: new ViteClientAdapter({
    devMode: config.devMode,
    // Both src/server/core and dist/server/core are three levels below the root.
    projectRoot: fileURLToPath(new URL("../../../", import.meta.url)), distDir: "dist/web",
  }) }));
  return { app, runtime: app.container.resolve(httpRuntimeDependency) };
}
