import { resolve } from "node:path";
import { App } from "@kestrel/framework/app";
import { LoggerProvider } from "@kestrel/framework/log";
import { HttpClientGenerationProvider, HttpRuntimeProvider } from "@kestrel/framework/http";
import { ClientProvider, ViteClientAdapter, ViteDevelopmentRuntime } from "@kestrel/framework/client";
import { DatabaseProvider } from "./providers/database_provider.js";
import { appCatalog, applicationHttpControllerCatalog } from "./appCatalog.js";
import { appConfig, environment } from "./appConfig.js";

/** Complete application composition loaded directly by the generic CLI. */
const app = new App(appConfig, { catalog: appCatalog });
// Adapter construction is lazy: CLI commands do not start the Vite runtime.
const development = app.config.client.enabled && app.config.client.devMode
  ? new ViteDevelopmentRuntime({
    root: app.config.core.runtimeRoot,
    configFile: resolve(app.config.core.runtimeRoot, "vite.development.config.ts"),
  }).entry({ root: "src/client" })
  : undefined;

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

export default app;
