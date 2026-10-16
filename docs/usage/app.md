# Application

[Usage index](./README.md) · [Implementation and lifecycle](../implementation/app.md)

Use `App` to compose configuration, providers and feature catalogs. Compose once, then let the selected HTTP, CLI or background runtime own execution and shutdown.

## Compose and export an application

Start here when assembling a new application or a small runnable example. The exported module gathers configuration, a feature catalog and the HTTP provider for the launcher.

```ts
import { z } from "zod";
import { defineAction } from "@kestreljs/framework/actions";
import { App, defineCatalog, selectHttpControllerCatalog } from "@kestreljs/framework/app";
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { defineActionHttpController, get, httpConfigBase, HttpRuntimeProvider } from "@kestreljs/framework/http";

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
        outputFile: "src/generated/public_client.ts",
        catalogImportPath: "../example.js", runtimeImportPath: "@kestreljs/framework/http/client",
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
export const catalog = defineCatalog({
  greeting: {
    actions: { greet },
    controllers: {
      http: { greet: defineActionHttpController(greet, get("/greet")) },
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

## Bound application shutdown

Pass `shutdown: { timeoutMs: 30_000, drainMs: 20_000 }` to `new App(config, options)` to allocate one shutdown budget. Both values are milliseconds; `timeoutMs` must be positive and `drainMs` must be between zero and the total. These are also the defaults. The first application or transport stop starts the deadline; later `stop()` and `dispose()` calls do not renew it. Always call `dispose()` after runtime completion, including errors.

Stopping rejects new application executions and requests registered transport drains. Existing scopes retain their borrowed dependencies until they finish. At `drainMs`, `execution.signal` and the injectable `executionSignalDependency` abort. Forward that signal to outbound HTTP and other cooperative operations; arbitrary JavaScript and already-started storage work cannot be forcibly cancelled by a Promise deadline. Workers and scheduled tasks combine it with their existing handler signal; workflow activity transports receive it too. Existing workload stop policies may request cancellation earlier.

Transport drain, lifecycle listeners, active scopes, observation flushing and container disposal share the remaining total budget. Expiration rejects with `ApplicationShutdownTimeoutError`, possibly inside an `AggregateError`, and leaves `app.state` as `shutdownTimedOut`. The timeout exposes its active phase and total budget. The library stops awaiting non-cooperative work and does not report successful disposal. It does not start releasing shared dependencies while executions or transport drains remain unfinished; resources already undergoing disposal may finish later. An embedded owner must contain or terminate work that survives the deadline.

The executable CLI installs its terminal policy before running commands: on expiration it attempts a minimal stderr diagnostic and exits with code 1, even when application handlers or sinks remain pending. Embedded `runCli()` and runtime APIs never force process exit. Configure the deployment supervisor's termination grace above the application budget; a blocked JavaScript event loop still requires external process supervision. See [shutdown implementation](../implementation/app.md#shared-shutdown-deadline).
