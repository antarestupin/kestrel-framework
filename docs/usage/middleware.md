# Middleware

[Usage index](./README.md) · [Implementation and pipeline semantics](../implementation/middleware.md)

Use middleware to surround an action or controller with shared behavior. Choose action middleware when the behavior must apply through every transport, and HTTP/CLI middleware when it belongs to that transport.

## Surround business execution

Use action middleware for shared behavior that should apply to every invocation. This timing wrapper measures completion or failure without changing the business handler.

```ts
import { z } from "zod";
import { defineAction, defineActionMiddleware } from "@kestreljs/framework/actions";

const timing = defineActionMiddleware("example.timing", {
  handler: async ({ action }, next) => {
    const started = performance.now();
    try {
      // Await downstream execution so finally measures its completion or failure.
      return await next();
    } finally {
      // This also runs when the handler or output validation fails.
      console.log(action.name, performance.now() - started);
    }
  },
});
const greet = defineAction({
  name: "greeting.greet",
  input: z.object({ name: z.string() }),
  output: z.string(),
  middleware: [timing],
  handler: ({ name }) => `Hello, ${name}!`,
});
```

Return the result of `next()` unchanged in type. Middleware may declare its own `dependencies`. Input validation happens before middleware; output validation happens inside it. With `[first, second]`, entry order is first then second, and completion order is second then first.

## Add transport behavior

Use transport middleware when behavior needs HTTP request or reply objects. The example adds a response header to selected controllers.

```ts
import { defineHttpAccessPolicy, defineHttpController, defineHttpMiddleware, get } from "@kestreljs/framework/http";

const responseHeader = defineHttpMiddleware("example.response-header", {
  handler: async ({ reply }, next) => {
    reply.header("x-service", "example");
    // Continue to the controller after adding the transport-specific header.
    return next();
  },
});
const health = defineHttpController({
  route: get("/health"),
  access: defineHttpAccessPolicy("example.public"),
  middleware: [responseHeader],
  handler: () => ({ status: "ok" }),
});
```

Use `defineCliMiddleware` similarly for command behavior. Put HTTP access checks in a default or controller-specific [access policy](./http.md#set-default-access-and-override-a-route), and business permission checks on the action when they must protect direct calls too.

Each call to `next()` replays the downstream middleware and handler. Retry middleware must bound attempts and ensure downstream side effects are safe to repeat. For database transactions, use the existing [transaction middleware](./database.md#group-writes-in-a-transaction).

## Use cases still to document

- Inject services into middleware.
- Wrap a CLI command with middleware.
- Combine policy, controller and action middleware and illustrate their execution order.
- Retry downstream execution with bounded attempts and application-owned idempotency.
