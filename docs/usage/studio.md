# Studio

[Usage index](./README.md) · [Implementation and extension contracts](../implementation/studio.md)

Studio is a development tool for inspecting definitions, executions and infrastructure. Enable it explicitly for a trusted development environment; its explorers include controls that invoke application operations.

## Mount Studio with an actions explorer

Enable an actions explorer when developers need to inspect the application catalog in a browser. The page groups dotted action names into collapsible namespaces, with a navigation tree and a detail panel matching the HTTP controllers explorer. Select an action to inspect its full name, description and middleware. Actions without a namespace appear at the root. Execution is enabled by default for registered action definitions whose input can be described as JSON. Metadata-only entries remain read-only. This composition limits Studio to the development environment.

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

## Execute actions

Select an action, edit its JSON input and choose **Run action**. Studio supplies a generated starting example, which may still require edits to satisfy refinements or business constraints. Actions with a null input contract run without an editor. The result panel shows execution duration, validation field paths and the execution identifier. Namespaces and action selection are retained while running, and the button prevents duplicate submissions until the response arrives.

```ts
const actions = defineActionsDocumentationExtension(app.catalog.actions.definitions, {
  // Execution defaults to true; set false to make the entire explorer read-only.
  execution: true,
  exclude: ["maintenance.reset"],
  examples: {
    "greeting.greet": [{ name: "Greeting", input: { name: "Sam" } }],
  },
  // Enable when the observation provider and Studio observation extension are installed.
  observability: true,
});
```

Compatibility is determined from the schema's raw input, before transformations. A string transformed into a class instance can run; an input requiring an existing class instance, Date, Map or another non-representable value remains visible with an explanation. Introspection does not run refinements or transforms. The action runner remains responsible for validation, middleware, dependency resolution and output validation. Global disabling and exclusions are enforced by the endpoint as well as the interface.

Studio attempts to serialize every successful result with standard `JSON.stringify` semantics: dates and `toJSON()` hooks are supported, class instances expose their enumerable properties, undefined object properties are omitted, and non-finite numbers become null. Maps and Sets normally appear as empty objects unless they provide a custom JSON representation. If serialization throws (for example, for a cycle or bigint) or produces no JSON value (for example, a top-level undefined), execution is still reported as successful with an unavailable result. JSON null is shown as a successful result. A lost network response leaves the outcome unknown; inspect the operation's effects before retrying. Leaving the page does not cancel a running action. Runs use the normal HTTP request lifetime, without a background job or automatic retry.

With `observability: true`, the result includes an observation timeline correlated to the action execution, including failed runs. Observations load after the response and poll briefly for delayed persistence. Studio's ordinary catalogue and polling requests remain unobserved. Access uses Studio's existing access boundary without per-action authorization or user impersonation; action middleware still applies. Enable Studio through application configuration for the intended local or stage environment.

Custom input adapters (for example, loading an entity from a JSON identifier), live observations before the execution response, generated field-by-field forms and background execution are deferred.

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
