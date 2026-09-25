# Definitions and validation

[Usage index](./README.md) · [Implementation and registries](../implementation/definitions.md)

Use `defineCatalog` to gather features explicitly. Most application code does not need to construct low-level definition registries.

## Group definitions without file discovery

Organize definitions into an explicit catalog when a feature includes operations that the application and its tools must discover. The typed tree keeps navigation close to the feature structure.

```ts
import { z } from "zod";
import { defineAction } from "@kestrel/framework/actions";
import { App, defineCatalog, selectActionCatalog } from "@kestrel/framework/app";

const greet = defineAction({
  name: "greeting.greet",
  input: z.object({ name: z.string() }),
  output: z.string(),
  handler: ({ name }) => `Hello, ${name}!`,
});
// The category identifies the definition; the feature path organizes navigation.
const catalog = defineCatalog({ greeting: { actions: { greet } } });
const app = new App({}, { catalog });

// Keep the typed tree for application navigation and the index for inspection.
const action = catalog.greeting.actions.greet;
const actionTree = selectActionCatalog(catalog);
const definitions = app.catalog.actions.definitions;
```

Each feature may add `controllers.http`, `controllers.cli`, `workers`, `workflows` and `scheduledTasks`. Definitions have explicit identities; duplicate names or colliding catalog paths fail during composition. Providers may contribute catalogs before bootstrap seals registration.

## Choose a validation mode

Set a boundary to async parsing when its schema performs asynchronous refinement or transformation. This example normalizes text before the handler receives it.

```ts
const normalize = defineAction({
  name: "text.normalize",
  input: z.string().transform(async (value) => value.trim()),
  output: z.string(),
  // Only the input schema requires asynchronous parsing here.
  validation: { input: "async", output: "sync" },
  handler: (value) => value,
});
```

Parsing defaults to `sync`. Async handlers and async mappers are allowed independently of schema parsing. Declare `async` on the boundary whose schema uses asynchronous refinements/transforms; using one under sync mode is a programming error.

Action controllers inherit unchanged action schema policies; replacement schemas need their own policy. Workers have only input validation. See the [complete inheritance rules](../implementation/definitions.md#schema-validation-policy) when extending a definition.

Applications can preload `zod/compile` at their launcher, as shown in [CLI usage](./cli.md#launch-the-application). This is an application choice; definitions do not enable global schema compilation themselves.

## Use cases still to document

- Override schemas on derived definitions and controllers while preserving or replacing validation policies.
- Validate asynchronous output schemas.
- Inspect catalog paths and provenance, including provider-contributed definitions.
