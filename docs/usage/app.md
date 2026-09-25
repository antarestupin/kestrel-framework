# Application

[Usage index](./README.md) · [Implementation and lifecycle](../implementation/app.md)

Use `App` to compose configuration, providers and feature catalogs. Compose once, then let the selected HTTP, CLI or background runtime own execution and shutdown.

## Compose and export an application

Start here when assembling a new application or a small runnable example. The exported module gathers configuration, a feature catalog and the HTTP provider for the launcher.

```ts
import { z } from "zod";
import { defineAction } from "@kestrel/framework/actions";
import { App, defineCatalog, selectHttpControllerCatalog } from "@kestrel/framework/app";
import { configure, createConfigurationApi } from "@kestrel/framework/configuration";
import { defineActionHttpController, defineHttpAccessPolicy, get, httpConfigBase, HttpRuntimeProvider } from "@kestrel/framework/http";

const configuration = createConfigurationApi({
  environments: ["development", "production"],
  defaultEnvironment: "development",
});
// Resolve settings before constructing providers that consume them.
const config = configuration.resolveConfig({
  http: configure(httpConfigBase, {
    port: 3333, fastifyLogs: false,
    clientGeneration: {
      audiences: { audiences: ["public"], defaultAudiences: ["public"] },
      generators: [{
        name: "public", audiences: ["public"], factoryName: "createPublicClient",
        outputFile: "src/generated/publicClient.ts",
        catalogImportPath: "../example.js", runtimeImportPath: "@kestrel/framework/http/client",
      }],
    },
  }),
}, { environment: "development", env: {} });

const greet = defineAction({
  name: "greeting.greet",
  input: z.object({ name: z.string() }),
  output: z.string(),
  handler: ({ name }) => `Hello, ${name}!`,
});
const publicAccess = defineHttpAccessPolicy("example.public");
export const catalog = defineCatalog({
  greeting: {
    actions: { greet },
    controllers: {
      http: { greet: defineActionHttpController(greet, get("/greet"), publicAccess) },
    },
  },
});
// Client generation imports the HTTP-only view of the same feature catalog.
export const applicationHttpControllerCatalog = selectHttpControllerCatalog(catalog);

// Registration declares resources; importing this module does not start a server.
const app = new App(config, { catalog })
  .register(new HttpRuntimeProvider(config.http));
export default app;
```

Pass this module to the [CLI launcher](./cli.md#launch-the-application). Add providers in dependency order, for example database before providers using database storage. Feature catalogs may contain actions, HTTP/CLI controllers, workers, workflows and scheduled tasks; omit unused categories.

## Run an action without a transport

Use this pattern for a script or test that calls business behavior directly. Because no runtime owns the lifecycle here, the caller starts and disposes the application.

```ts
try {
  await app.start();
  // A direct call gets its own execution scope, just like a transport invocation.
  const message = await app.get(greet).run({ name: "Sam" });
  console.log(message);
} finally {
  // Dispose even if startup or the action fails.
  await app.dispose();
}
```

`app.get(action)` owns the execution scope for its call. Inside an existing controller, use its supplied action runner or execution scope so dependencies and diagnostics remain attached to that execution. Business services declare [dependencies](./di.md) instead of retaining `App`.

## Add features and inspect their definitions

Use catalogs to group a growing set of features and let tools inspect the registered operations. Keep the typed declaration for code navigation and use the application indexes for runtime discovery.

Keep the catalog declaration for typed navigation (`catalog.greeting.actions.greet`). Use `app.catalog.actions.definitions` or the other category indexes for runtime inspection. Registration closes at bootstrap; do not add providers or definitions after starting the application.

See [configuration](./configuration.md), [HTTP](./http.md), and [background workloads](./background.md) for the next composition steps. Custom providers and lifecycle integrations are described in the [implementation guide](../implementation/app.md#providers).

## Use cases still to document

- Compose an application-owned provider with startup and resource cleanup.
- Subscribe to application lifecycle events.
- Own an execution scope explicitly, including context and deferred work.
