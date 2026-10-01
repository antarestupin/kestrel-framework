# Actions

[Usage index](./README.md) · [Implementation and API reference](../implementation/actions.md)

Declare an action when business behavior should be reusable from HTTP, CLI, workers or direct application calls. Its input and output are validated independently of the transport.

## Define and run an action

Package a business operation with a validated input and output when several callers need the same behavior. This example runs a greeting directly, before exposing it through a transport.

```ts
// hide-start
import { z } from "zod";
import { defineAction, mapActionInput } from "@kestreljs/framework/actions";
import { App, defineCatalog } from "@kestreljs/framework/app";

// hide-end
const greet = defineAction({
  name: "greeting.greet",
  description: "Create a greeting.",
  // Validate at the action boundary so direct and transport callers share the contract.
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ message: z.string() }),
  handler: ({ name }) => ({ message: `Hello, ${name}!` }),
});

const catalog = defineCatalog({ greeting: { actions: { greet } } });
const app = new App({}, { catalog });
try {
  await app.start();
  // The runner owns validation, middleware and the execution scope for this call.
  const result = await app.get(greet).run({ name: "Sam" });
  console.log(result.message);
} finally {
  await app.dispose();
}
```

Add `dependencies` for services and `middleware` for shared behavior; see [dependency injection](./di.md) and [middleware](./middleware.md). Call through a runner to retain validation and middleware, rather than calling `handler` yourself.

## Accept another input shape

Adapt an existing action when a caller uses different field names or a different input structure. Here, a profile display name becomes the name expected by the greeting action.

```ts
const greetingFromProfile = greet.derive(mapActionInput(
  z.object({ displayName: z.string().min(1) }),
  // Map the caller's shape to the original action input before it executes.
  ({ displayName }) => ({ name: displayName }),
));
// Run this variant through app.get(greetingFromProfile) in a running app.
```

The source action is unchanged. The variant preserves its name and output, and validates the mapped source input. Do not register both under the same action name in one catalog.

## Validate asynchronously

Choose asynchronous parsing when a schema refinement or transform returns a promise. The normalization example shows where to enable it independently of the handler.

```ts
const normalizeName = defineAction({
  name: "greeting.normalize",
  input: z.object({ name: z.string().transform(async (value) => value.trim()) }),
  output: z.string(),
  // The schema transform returns a promise, so input parsing must await it.
  validation: { input: "async" },
  handler: ({ name }) => name,
});
```

Async handlers do not require async validation. Set `validation.input` or `validation.output` only when that schema needs asynchronous parsing; both default to sync. See [validation modes](./definitions.md#choose-a-validation-mode).

## Expose an action or reuse CRUD behavior

Once an action works, expose it through the interfaces your users need. For ordinary repository operations, the model helpers reduce the amount of CRUD code to write.

Use [HTTP controllers](./http.md) and [CLI controllers](./cli.md) to expose the same definition. For repository-backed CRUD, `defineModelCreateAction`, `defineModelGetAction`, `defineModelGetManyAction`, `defineModelListAction`, `defineModelLookupAction`, `defineModelUpdateAction` and `defineModelDeleteAction` provide conventional actions; see the [database recipe](./database.md#create-a-repository-backed-action) and [pagination recipes](./pagination.md).

## Use cases still to document

- Implement read, batch read, lookup, update and delete operations with the model action helpers.
- Call another action inside an existing execution scope while preserving scoped dependencies.
- Validate and transform an action output asynchronously.
