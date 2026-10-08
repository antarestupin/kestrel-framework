// Composes the application catalog, configuration, and runtime providers for the Kestrel CLI.
// Register application services here; configure their settings through app_config.ts and config/.

import { resolve } from "node:path";
import { App } from "@kestreljs/framework/app";
import { LoggerProvider, pinoLogger } from "@kestreljs/framework/log";
import { HttpClientGenerationProvider, HttpRuntimeProvider } from "@kestreljs/framework/http";
import { ClientProvider, viteClient } from "@kestreljs/framework/client";
import { PostgresDrizzleProvider } from "./providers/database_provider.js";
import { StudioProvider } from "./providers/studio_provider.js";
import { createDevelopmentClients } from "./development_clients.js";
import { appCatalog, applicationHttpControllerCatalog } from "./app_catalog.js";
import { appConfig, environment } from "./app_config.js";

/** Complete application composition loaded directly by the generic CLI. */
const app = new App(appConfig, { catalog: appCatalog });
const { application: development } = createDevelopmentClients(app.config);

app
  .register(new LoggerProvider(app.config.logger, pinoLogger()))
  .register(new PostgresDrizzleProvider(app.config.database, environment))
  .register(new HttpRuntimeProvider(app.config.http))
  .register(
    new HttpClientGenerationProvider(
      app.config.http.clientGeneration,
      applicationHttpControllerCatalog,
    ),
  );

if (app.config.client.enabled) {
  app.register(
    new ClientProvider(
      viteClient(development, {
        devMode: app.config.client.devMode,
        // Production discovers the cached Vite build without requiring application sources.
        projectRoot: app.config.client.devMode
          ? resolve(app.config.core.runtimeRoot, "src/client")
          : app.config.core.runtimeRoot,
        distDir: "dist/client",
      }),
      {
        excludedPaths: ["/api"],
      },
    ),
  );
}

// Register Studio after every provider contributing definitions to its explorers.
app.register(new StudioProvider(app.config.studio, app.config.core));

export default app;
