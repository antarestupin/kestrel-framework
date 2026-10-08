# Browser client delivery

[Usage index](./README.md) · [Implementation and delivery adapters](../implementation/client.md)

Mount a browser application through the existing HTTP runtime. Kestrel owns delivery; the application chooses its component framework, router and server-state library.

## Mount a Vite application

Serve a browser application alongside your API when both should share the HTTP runtime. The adapter handles Vite development delivery or serves the built client according to the supplied mode.

The shared `ViteDevelopmentRuntime` loads configuration natively so it can run under Node's `--watch` without restarting on Vite's temporary configuration files. Run TypeScript development configuration with the supported Node.js runtime and the application's `tsx` import hook, as provided by the generated `do` launcher.

```ts
import type { App } from "@kestreljs/framework/app";
import { ClientProvider, viteClient } from "@kestreljs/framework/client";

function mountClient<Config>(app: App<Config>, projectRoot: string, devMode: boolean) {
  return app.register(new ClientProvider(
    viteClient({ projectRoot, devMode, distDir: "dist/client" }),
    { basePath: "/", assetBasePath: "/_client_assets/", excludedPaths: ["/api"] },
  ));
}
```

Pass an absolute runtime-visible project root and build the client into the configured directory for production. Match the Vite asset base to `assetBasePath`. Register the HTTP runtime in the same application. Unknown `/api` and asset paths return errors instead of the SPA document.

## Generate a typed HTTP client

Generate a client when browser code needs typed calls that follow the server controller catalog. This example selects a public audience and writes a client factory into the application source tree.

```ts
import { z } from "zod";
import { defineCatalog, selectHttpControllerCatalog } from "@kestreljs/framework/app";
import { defineHttpAccessPolicy, defineHttpController, get, HttpClientGenerationProvider } from "@kestreljs/framework/http";

const health = defineHttpController({
  route: get("/api/health"), access: defineHttpAccessPolicy("example.public"),
  output: z.object({ status: z.literal("ok") }),
  handler: () => ({ status: "ok" as const }),
});
export const catalog = defineCatalog({ system: { controllers: { http: { health } } } });
// Export the same HTTP-only tree that the generated client will reference.
export const applicationHttpControllerCatalog = selectHttpControllerCatalog(catalog);
const generation = {
  audiences: { audiences: ["public"], defaultAudiences: ["public"] },
  generators: [{
    name: "public", audiences: ["public"], factoryName: "createPublicClient",
    outputFile: "src/generated/public_client.ts",
    // Generated imports are relative to src/generated/public_client.ts.
    catalogImportPath: "../example.js", catalogExportName: "applicationHttpControllerCatalog",
    runtimeImportPath: "@kestreljs/framework/http/client",
  }],
};
function registerGeneration<Config>(app: App<Config>) {
  return app.register(new HttpClientGenerationProvider(generation, applicationHttpControllerCatalog));
}
```

This assumes the exported HTTP catalog is in `src/example.ts`. The imported export must be the same HTTP-only tree passed to the generator. Generated import paths are relative to the output file. Register the provider and invoke:

```sh
./do generate http-clients
```

The generated factory accepts `{ baseUrl, fetch?, headers? }`. Its hierarchy mirrors the selected HTTP catalog, and response types reflect JSON serialization. Non-success responses throw `HttpClientError`; empty responses return `undefined`. Audience filtering controls client contents, not server authorization.

## Share development tooling between clients


```ts
import { ViteDevelopmentRuntime, viteClient } from "@kestreljs/framework/client";

function createSharedDevelopment(projectRoot: string) {
  const runtime = new ViteDevelopmentRuntime({ root: projectRoot, configFile: "vite.development.config.ts" });
  // Runtime dependencies and backend settings remain separate factory arguments.
  return viteClient(runtime.entry({ root: "src/client" }), {
    projectRoot, devMode: true, distDir: "dist/client",
  });
}
```


## Use cases still to document

- Call a generated client with shared headers or an injected fetch and handle HttpClientError.
- Generate separate clients for multiple audiences and exclude selected controllers.
- Build and serve a production client under a non-root base path.

## Explicit provider adapters

`ClientProvider(adapter, options?)` accepts a `WebClientAdapterDefinition`. `viteClient(settings)` supplies the bundled backend; `viteClient(development, settings)` borrows a shared development entry or resolves its typed dependency descriptor. Definitions initialize during HTTP mounting; `setup()` installs server-owned shutdown hooks. Borrowed development runtimes retain their own ownership. Each mount has its own adapter registration.

See the [shared composition convention](../implementation/app.md#provider-adapter-convention) and [configuration recipes](../usage/configuration.md#additional-provider-composition).
