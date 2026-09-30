# Controllers

[Usage index](./README.md) · [Implementation and shared type contract](../implementation/controllers.md)

A controller adapts an action or a handler to a transport. Use the HTTP and CLI factories for application code; the lower-level `controllers` library is intended for transport authors.

## Expose one action through two transports

Use transport controllers when the same business operation should be available over HTTP and from a command. Both adapters reuse the greeting action and its validation contract.

```ts
import { z } from "zod";
import { defineAction } from "@kestreljs/framework/actions";
import { defineCatalog } from "@kestreljs/framework/app";
import { defineActionCliController } from "@kestreljs/framework/cli";
import { defineActionHttpController, defineHttpAccessPolicy, get } from "@kestreljs/framework/http";

const greet = defineAction({
  name: "greeting.greet",
  input: z.object({ name: z.string() }),
  output: z.string(),
  handler: ({ name }) => `Hello, ${name}!`,
});
export const catalog = defineCatalog({
  actions: { greet },
  controllers: {
    http: {
      // GET /greet?name=Sam supplies the action input through the query.
      greet: defineActionHttpController(greet, get("/greet"), defineHttpAccessPolicy("example.public")),
    },
    // The command supplies the same input as greet --name Sam.
    cli: { greet: defineActionCliController(greet, "greet") },
  },
});
```

Compose this catalog into the application. The HTTP call supplies `name` in the query; the command supplies `--name`. Both run the same business definition and validate its output.

Use an object input schema so transport bindings can address individual fields. Standalone controllers may omit `input` for an empty object and omit `output` when they do not declare a response contract. For custom bindings, dependencies and result mapping, continue with [HTTP](./http.md) or [CLI](./cli.md).

## Use cases still to document

- Expose one action with different HTTP and CLI input mappings and output representations.
- Implement standalone controllers with empty input or no declared output contract.
