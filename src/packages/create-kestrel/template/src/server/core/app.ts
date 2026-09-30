// Composes the application catalog, configuration, and runtime providers for the Kestrel CLI.
// Register application services here; configure their settings through appConfig.ts and config/.

import { resolve } from "node:path";
import { App } from "@kestrel/framework/app";
import { LoggerProvider } from "@kestrel/framework/log";
import { HttpClientGenerationProvider, HttpRuntimeProvider } from "@kestrel/framework/http";
import { ClientProvider, ViteClientAdapter } from "@kestrel/framework/client";
import { DatabaseProvider } from "./providers/database_provider.js";
import { StudioProvider } from "./providers/studio_provider.js";
import { createDevelopmentClients } from "./development_clients.js";
import { appCatalog, applicationHttpControllerCatalog } from "./appCatalog.js";
import { appConfig, environment } from "./appConfig.js";

/** Complete application composition loaded directly by the generic CLI. */
const app = new App(appConfig, { catalog: appCatalog });
const { application: development } = createDevelopmentClients(app.config);

app
  .register(new LoggerProvider(app.config.logger))
  .register(new DatabaseProvider(app.config.database, environment))
  .register(new HttpRuntimeProvider(app.config.http))
  .register(new HttpClientGenerationProvider(app.config.http.clientGeneration, applicationHttpControllerCatalog));

if (app.config.client.enabled) {
  app.register(new ClientProvider({
    adapter: new ViteClientAdapter({
      devMode: app.config.client.devMode,
      projectRoot: resolve(app.config.core.runtimeRoot, "src/client"),
      distDir: "dist/client",
      ...(development === undefined ? {} : { development }),
    }),
    excludedPaths: ["/api"],
  }));
}

// Register Studio after every provider contributing definitions to its explorers.
app.register(new StudioProvider(app.config.studio, app.config.core));

export default app;
