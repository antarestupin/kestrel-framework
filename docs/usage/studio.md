# Studio

[Usage index](./README.md) · [Implementation and extension contracts](../implementation/studio.md)

Studio is a development tool for inspecting definitions, executions and infrastructure. Enable it explicitly for a trusted development environment; its explorers include controls that invoke application operations.

## Mount Studio with an actions explorer

Enable an actions explorer when developers need to inspect the application catalog in a browser. The page groups dotted action names into collapsible namespaces, with a navigation tree and a detail panel matching the HTTP controllers explorer. Select an action to inspect its full name, description and middleware. Actions without a namespace appear at the root. Action execution from this page is planned for a later iteration. This composition limits Studio to the development environment.

```ts
import type { App } from "@kestrel/framework/app";
import { configure, createConfigurationApi } from "@kestrel/framework/configuration";
import { studioConfigBase, StudioProvider } from "@kestrel/framework/studio";
import { defineActionsDocumentationExtension } from "@kestrel/framework/studio/extensions/actions";

const configuration = createConfigurationApi({
  environments: ["development", "production"], defaultEnvironment: "development",
});
const config = configuration.resolveConfig({
  studio: configure(studioConfigBase, {
    // Mount developer tooling only in the explicitly selected environment.
    enabled: configuration.fromEnv({ development: true, default: false }),
    // Serve the built Studio client; enabling the tool does not require Vite HMR.
    devMode: false,
  }),
}, { environment: configuration.resolveEnvironment(process.env.ENVIRONMENT), env: process.env });

function installStudio<Config>(app: App<Config>) {
  // Compose after the providers contributing definitions to be displayed.
  return app.register(new StudioProvider(config.studio, {
    extensions: [defineActionsDocumentationExtension(app.catalog.actions.definitions)],
  }));
}
```

Register the HTTP runtime and build the Studio client when using bundled delivery (`devMode: false`). The default mount is `/_studio`. CLI/background processes do not mount its browser runtime. Select `devMode: true` or inject a shared development adapter when working on Studio itself.

## Add explorers for other libraries

Add the relevant explorers as the application adopts more Kestrel libraries. Each explorer receives the definitions and data source needed for its particular view.

Built-in extensions have their own public entry points under `studio/extensions/<name>/index.js`. Compose the controller, worker, scheduled-task, workflow, database, log, observation or email extension with its explicit catalog and data source. No extension discovers application files automatically.

Controller and worker explorers use declared `examples` to prepare forms and correlate executions with observations. Without examples they derive a deterministic fallback from the input schema. Add meaningful examples to complex definitions for more useful forms.

## Automatic refresh

Workers (including worker details), Scheduled tasks, Workflows, Email history and Email inbox refresh automatically every two seconds while their page is mounted. Workflow execution details refresh every three seconds. These pages use periodic HTTP requests, like Executions, Observations and Logs; updates become visible on the next successful request. Manual refresh controls remain available.

Paginated lists refresh their newest page, so automatic refresh replaces any older pages loaded with “Load older”. Server-pushed updates and retaining older pages during refresh remain deferred improvements.

## Link another development tool

Add a navigation link when a separate tool already provides a useful development interface. This example makes an existing database browser reachable from Studio.

```ts
import type { StudioExtension } from "@kestrel/framework/studio";

const tools: StudioExtension = {
  id: "external-tools", title: "External tools", pages: [],
  // The linked tool runs separately; this extension only adds navigation.
  links: [{ id: "database-browser", title: "Database browser", href: "http://localhost:4983" }],
};
```

Add this extension to the provider's `extensions`. Custom interactive pages additionally need a client renderer for their `kind` and optional data controllers. That extension-author workflow, serialization rules and source boundaries are covered in [implementation](../implementation/studio.md#extensions).

## Use cases still to document

- Enable the controller, worker, scheduled-task, workflow and email explorers.
- Connect development log and observation stores.
- Share a Vite development runtime and configure the Studio production build.
