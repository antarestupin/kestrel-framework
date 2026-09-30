# Utilities

[Usage index](./README.md) · [Implementation and export reference](../implementation/utilities.md)

Use focused utility entry points when you need identifiers, cursor encoding or catalog traversal without a provider.

## Generate an identifier

Generate an identifier before persistence when a record needs an ID in server or browser code. The same helper works without a database connection.

```ts
import { createUuid } from "@kestreljs/framework/utils/uuid";

const id = createUuid();
```

This generates a UUID v7 in server or browser code without a database round trip. Its timestamp is not a transaction sequence or a guarantee of strict ordering between concurrent callers.

## Encode a server-side cursor

Encode a cursor when a server needs to return a validated continuation value as an opaque string. The client can send that token back without interpreting its fields.

```ts
import { z } from "zod";
import { createPaginationCursorCodec } from "@kestreljs/framework/utils";

const codec = createPaginationCursorCodec(z.object({ id: z.string() }));
// Encode a validated cursor for transport; this does not sign or encrypt it.
const token = z.encode(codec, { id });
const cursor = z.decode(codec, token);
```

The codec validates both directions and bounds token size. It is server-only; browsers retain the opaque string. Encoding adds neither confidentiality nor authenticity. See [pagination](./pagination.md) for complete query integration.

## Flatten a typed catalog

Flatten a nested catalog when a tool needs an ordered list of selected definitions. A leaf guard identifies the action objects while traversal follows the surrounding branches.

```ts
import { defineAction } from "@kestreljs/framework/actions";
import { flattenCatalog, isAction } from "@kestreljs/framework/utils";

const ping = defineAction({
  name: "system.ping", input: z.object({}), output: z.literal("pong"),
  handler: () => "pong" as const,
});
// The guard distinguishes action leaves from grouping objects.
const actions = flattenCatalog({ system: { ping } }, isAction);
```

Traversal preserves declaration order. The leaf guard distinguishes definition objects from branches. Prefer [application catalogs](./definitions.md) when you need category indexes, paths and provenance as well.

## Use cases still to document

- Configure cursor size limits and handle malformed tokens.
- Flatten a mixed catalog with an application-specific leaf guard.
