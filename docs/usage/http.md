# HTTP

[Usage index](./README.md) · [Implementation and transport contracts](../implementation/http.md)

Use typed controllers for routes and register `HttpRuntimeProvider` as shown in [application composition](./app.md). Controllers inherit the runtime access policy, which permits anonymous requests by default. Set `defaultAccess` on the provider to change that default, or `access` in a controller's options to override it.

## Enable maintenance mode

Configure `http.maintenance` to reject new HTTP requests with `503 Service Unavailable` while keeping the requested URL. Maintenance is disabled by default. Add the following fields to your existing `configure(httpConfigBase, { ... })` declaration, retaining its listener and client-generation settings:

```ts
maintenance: {
  enabled: true,
  // Optional delay in seconds, advertised on every maintenance response.
  retryAfterSeconds: 120,
  // API prefixes match a complete path segment, including descendants.
  apiPathPrefixes: ["/api", "/rpc"],
  exceptions: [
    // Keep only this liveness endpoint available during maintenance.
    { path: "/health/live", methods: ["GET", "HEAD"] },
  ],
},
```

Pass the resolved `config.http` to `HttpRuntimeProvider` as usual. The runtime captures maintenance settings when constructed; changing configuration afterward does not toggle an existing runtime. With the `APP_CONFIG` prefix from the [configuration guide](./configuration.md#override-a-library-setting-without-another-binding), deployments can set `APP_CONFIG__HTTP__MAINTENANCE__ENABLED=true` and optionally `APP_CONFIG__HTTP__MAINTENANCE__RETRY_AFTER_SECONDS=120` before starting the application. Array settings such as exceptions and API prefixes belong in the application declaration or an explicit configuration source.

Browsers receive a self-contained HTML page for GET/HEAD requests that explicitly accept `text/html` with a positive quality value and do not prefer JSON. API prefixes always receive JSON, even if HTML is requested. Other methods, requests without `Accept`, and wildcard-only requests also receive JSON. The default API prefix is `/api`; set `apiPathPrefixes: []` to rely entirely on `Accept` for GET/HEAD requests. JSON contains:

```json
{
  "statusCode": 503,
  "error": "Service Unavailable",
  "message": "The site is temporarily unavailable for maintenance. Please try again later."
}
```

Every maintenance response includes `Cache-Control: no-store` and `Vary: Accept`, plus `Retry-After` when configured. HEAD responses include no body. Maintenance covers catalog controllers, extension routes, static assets served by those extensions, and unknown paths before body parsing or request execution. Exceptions bypass only maintenance; routing, validation and authentication still apply. The application and extensions still start normally, so maintenance does not remove their startup dependencies.

### Customize the page and exceptions

Set `maintenance.html` to a complete trusted HTML document. Kestrel serves it verbatim only for HTML maintenance responses; JSON errors retain the contract above.

```ts
maintenance: {
  enabled: true,
  // Keep this document independent of blocked assets and application services.
  html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scheduled maintenance</title></head>
<body><main><h1>We'll be back soon</h1><p>We are upgrading our service.</p></main></body>
</html>`,
  exceptions: [{ path: "/health/live", methods: ["GET", "HEAD"] }],
},
```

The default page needs no external assets or JavaScript. Custom HTML should be equally autonomous and compatible with the application's security headers. If it needs a separately served asset, declare that asset's path as an exception.

Exception paths match the raw URL path exactly, ignoring the query string. They are case-sensitive, do not decode percent escapes, and do not expand wildcards, route parameters or trailing slashes. `/health/live` does not exempt `/health/live/` or `/health/live/details`. Omitting `methods` allows every method on that path; listing `GET` alone does not exempt `HEAD`. No paths are automatically exempted. A liveness exception does not imply that a readiness check should report the application ready to serve business traffic.

Maintenance currently controls new HTTP requests only. It does not cancel in-flight work, stop workers or scheduled tasks, or close existing long-lived connections. Live toggling and coordinated background-work suspension are deferred; see the [implementation contract](../implementation/http.md#maintenance-admission).

## Set default access and override a route

```ts
import { anonymousHttpAccess, defineActionHttpController, get, post, HttpRuntimeProvider } from "@kestreljs/framework/http";

// Apply the application's authenticated policy to routes that omit access.
app.register(new HttpRuntimeProvider(config.http, {
  defaultAccess: authenticatedHttpAccess,
}));

const profileHttp = defineActionHttpController(profileAction, get("/profile"));
const signInHttp = defineActionHttpController(signInAction, post("/sign-in"), {
  // Replace the default so anonymous callers can sign in.
  access: anonymousHttpAccess,
});
```

`authenticatedHttpAccess` is an application policy built from [authentication](./authentication.md) middleware. An override replaces the default policy rather than adding to it. Without `defaultAccess`, routes that omit `access` are public. Standalone controllers and `defineModelListActionHttpController(action, url, options?)` follow the same rule. When migrating action controllers, move the former third `access` argument into the options object.

## Expose an action and map URL fields

Add an HTTP controller when an existing business action should be callable through a route. Explicit bindings let URL names differ from the action input fields.

```ts
import { z } from "zod";
import { defineAction } from "@kestreljs/framework/actions";
import { defineCatalog } from "@kestreljs/framework/app";
import { defineActionHttpController, defineHttpAccessPolicy, defineHttpController, get, path, query } from "@kestreljs/framework/http";

const greet = defineAction({
  name: "greeting.greet",
  input: z.object({ name: z.string(), prefix: z.string().default("Hello") }),
  output: z.string(),
  handler: ({ name, prefix }) => `${prefix}, ${name}!`,
});
// An empty policy is an explicit decision to allow anonymous requests.
const publicAccess = defineHttpAccessPolicy("example.public");
const greetHttp = defineActionHttpController(greet, get("/greetings/:person"), {
  access: publicAccess,
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

Handlers receive a context object containing `input`, `deps`, `request`, `reply`, `execution` and `defaultAccess`. For action controllers, `action` is the execution-bound runner. Add controller `dependencies` or a custom handler for transport-specific mapping; keep reusable business behavior in the action. See [direct request and reply access](./controllers.md#access-the-http-request-and-reply) for reading Fastify request metadata and manually sending a response.

## Set a response status and protect a route

Choose a success status when the HTTP contract needs one other than the method default. This example keeps public access; protected routes additionally select the session and permission policies described below.

```ts
const acceptedGreeting = defineActionHttpController(greet, get("/accepted-greeting"), {
  access: publicAccess,
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
- Map action results and return empty responses.
- Inject dependencies into a standalone controller.
- Compose authentication, authorization and trusted-origin checks on unsafe routes.
