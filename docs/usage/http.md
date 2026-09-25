# HTTP

[Usage index](./README.md) · [Implementation and transport contracts](../implementation/http.md)

Use typed controllers for routes and register `HttpRuntimeProvider` as shown in [application composition](./app.md). Every controller must choose an explicit access policy.

## Expose an action and map URL fields

Add an HTTP controller when an existing business action should be callable through a route. Explicit bindings let URL names differ from the action input fields.

```ts
import { z } from "zod";
import { defineAction } from "@kestrel/framework/actions";
import { defineCatalog } from "@kestrel/framework/app";
import { defineActionHttpController, defineHttpAccessPolicy, defineHttpController, get, path, query } from "@kestrel/framework/http";

const greet = defineAction({
  name: "greeting.greet",
  input: z.object({ name: z.string(), prefix: z.string().default("Hello") }),
  output: z.string(),
  handler: ({ name, prefix }) => `${prefix}, ${name}!`,
});
// An empty policy is an explicit decision to allow anonymous requests.
const publicAccess = defineHttpAccessPolicy("example.public");
const greetHttp = defineActionHttpController(greet, get("/greetings/:person"), publicAccess, {
  // Translate URL field names into the reusable action's input names.
  bindings: { name: path("person"), prefix: query("salutation") },
});
export const catalog = defineCatalog({
  greeting: { actions: { greet }, controllers: { http: { greet: greetHttp } } },
});
```

This accepts `/greetings/Sam?salutation=Hi`. Without explicit bindings, matching fields come from path parameters, remaining GET fields from the query, and remaining POST/PATCH/DELETE fields from the body. Use coercing schemas for numeric strings. `post`, `patch`, `del` and `body` support the other route and binding forms.

## Add a route without a business action

Use a standalone controller for transport-specific endpoints such as health checks. It declares its own response contract without introducing a reusable business action.

```ts
const health = defineHttpController({
  route: get("/health"),
  access: publicAccess,
  output: z.object({ status: z.literal("ok") }),
  handler: () => ({ status: "ok" as const }),
});
// Include health in the catalog's controllers.http category to expose it.
```

Handlers receive a context object containing `input`, `deps`, `request`, `reply` and `execution`. For action controllers, `action` is the execution-bound runner. Add controller `dependencies` or a custom handler for transport-specific mapping; keep reusable business behavior in the action.

## Set a response status and protect a route

Choose a success status when the HTTP contract needs one other than the method default. This example keeps public access; protected routes additionally select the session and permission policies described below.

```ts
const acceptedGreeting = defineActionHttpController(greet, get("/accepted-greeting"), publicAccess, {
  // Override only the success status; the action still executes in this request.
  successStatusCode: 202,
  // Use the execution-bound runner to retain action validation and middleware.
  handler: async ({ action, input }) => action.run(input),
});
```

POST defaults to 201 and other supported methods to 200. Custom response shapes need a matching `output` schema; use `z.void()` for no output. Expected failures can implement an [error representation](./errors.md). To restrict access, use [authentication](./authentication.md) and [authorization](./authorization.md) middleware in the policy. Policies always surround controller-local middleware.

## Generate a typed browser client

Generate controller calls when browser code should follow changes to the server contract. Keep audience selection separate from the policies that protect requests on the server.

Compose `HttpClientGenerationProvider` with the typed HTTP catalog and generator settings, or call `generateHttpClientSource` directly. The [client guide](./client.md#generate-a-typed-http-client) provides the recipe. Audience filters select generated contracts; they do not authorize server requests.

Configure proxy trust, accepted hosts, limits and security headers through `httpConfigBase` and the [hardening settings](../implementation/http.md#production-hardening). Use `fastify.inject()` for controller integration tests without listening on a port.

## Use cases still to document

- Bind path, query and JSON body values for a mutation with input coercion.
- Map action results and return empty responses or manually controlled replies.
- Inject dependencies into a standalone controller.
- Compose authentication, authorization and trusted-origin checks on unsafe routes.
