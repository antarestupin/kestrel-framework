import { fileURLToPath } from "node:url";
import { App } from "@kestrel/framework/app";
import { DatabaseProvider } from "./providers/database_provider.js";
import { LoggerProvider } from "@kestrel/framework/log";
import { HttpClientGenerationProvider, HttpRuntimeProvider } from "@kestrel/framework/http";
import { ClientProvider, ViteClientAdapter, ViteDevelopmentRuntime } from "@kestrel/framework/client";
import { appCatalog, applicationHttpControllerCatalog } from "./appCatalog.js";
import { readAppConfig } from "./appConfig.js";
import { httpClientGeneration } from "./http_client_generation.js";

/** Compose a fresh owned application for each process or integration test. */
export function createApp({ web = true } = {}) {
  const config = readAppConfig();
  const app = new App(config, { catalog: appCatalog });
  app.register(new LoggerProvider(config.logger));
  app.register(new DatabaseProvider(config.database));
  app.register(new HttpRuntimeProvider({
    host: config.host, port: config.port, fastifyLogs: false, executionIdHeader: "x-execution-id",
    clientGeneration: httpClientGeneration,
  }));
  // Client generation is a separate provider from the listening HTTP runtime.
  app.register(new HttpClientGenerationProvider(httpClientGeneration, applicationHttpControllerCatalog));
  const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
  // Constructing the shared development adapter is lazy; CLI commands never start Vite.
  const development = web && config.devMode
    ? new ViteDevelopmentRuntime({ root: projectRoot, configFile: "vite.development.config.ts" })
      .entry({ root: "src/client", module: "main.tsx" })
    : undefined;
  if (web) app.register(new ClientProvider({ adapter: new ViteClientAdapter({
    devMode: config.devMode,
    // Both src/server/core and dist/server/core are three levels below the root.
    projectRoot, distDir: "dist/web",
    ...(development === undefined ? {} : { development }),
  }), excludedPaths: ["/api"] }));
  return app;
}
