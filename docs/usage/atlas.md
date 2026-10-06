# Atlas

[Usage index](./README.md) · [Implementation and resource contracts](../implementation/atlas.md)

Use Atlas to expose selected application operations through a resource-oriented administration interface. Resources reference explicit source operations; Atlas does not infer authorization or read database tables directly.

Atlas is included in `@kestreljs/framework` under the `@kestreljs/framework/atlas` entry point. The package ships its compiled browser assets; no separate Atlas installation or browser build is needed. Applications own authentication, authorization and business data.

## Describe an application resource

Use a resource when operators need to browse and edit application records through Atlas. This example uses a tiny in-memory repository for clarity; provide the same operations with repository-backed [model action helpers](./database.md#create-a-repository-backed-action) in an application.

```ts
import { z } from "zod";
import { defineAction, createPaginationInputSchema, createPaginatedOutputSchema } from "@kestreljs/framework/actions";
import { defineAtlas, defineAtlasResource, defineCatalogAtlasSource } from "@kestreljs/framework/atlas";
import { createPaginatedResult } from "@kestreljs/framework/db";
import { uuidV7 } from "@kestreljs/framework/utils/uuid";

const contact = z.object({ id: z.uuid(), name: z.string() });
const identifier = contact.pick({ id: true });
const records = new Map<string, z.output<typeof contact>>();
const actions = {
  list: defineAction({
    name: "contact.list", input: z.object({ pagination: createPaginationInputSchema() }),
    output: createPaginatedOutputSchema(contact),
    handler: ({ pagination }) => {
      const items = [...records.values()];
      const offset = pagination.type === "page" ? (pagination.page - 1) * pagination.pageSize : 0;
      const window = pagination.type === "page" ? items.slice(offset, offset + pagination.pageSize + 1) : items;
      // The extra row lets pagination report whether another page exists.
      return createPaginatedResult(window, pagination);
    },
  }),
  read: defineAction({ name: "contact.get", input: identifier, output: contact.nullable(), handler: ({ id }) => records.get(id) ?? null }),
  readMany: defineAction({
    name: "contact.get-many", input: z.object({ ids: z.array(z.uuid()) }), output: z.array(contact),
    handler: ({ ids }) => [...records.values()].filter((record) => ids.includes(record.id)),
  }),
  create: defineAction({
    name: "contact.create", input: contact.omit({ id: true }), output: contact,
    handler: ({ name }) => { const record = { id: uuidV7(), name }; records.set(record.id, record); return record; },
  }),
  update: defineAction({
    name: "contact.update", input: contact, output: contact.nullable(),
    handler: (record) => { if (!records.has(record.id)) return null; records.set(record.id, record); return record; },
  }),
  delete: defineAction({
    name: "contact.delete", input: identifier, output: contact.nullable(),
    handler: ({ id }) => { const record = records.get(id) ?? null; records.delete(id); return record; },
  }),
};
const source = defineCatalogAtlasSource({ id: "application", actions });
const contacts = defineAtlasResource({
  id: "contact", label: "Contacts", source, identity: "id", displayField: "name",
  // Explicit references determine which operations this resource exposes.
  capabilities: {
    list: source.collectionQuery(actions.list), read: source.query(actions.read),
    readMany: source.query(actions.readMany), create: source.action(actions.create),
    update: source.action(actions.update), delete: source.action(actions.delete),
  },
  fields: { id: { kind: "id" }, name: { kind: "text" } },
});
const atlas = defineAtlas({ title: "Administration", basePath: "/admin", resources: [contacts] });
```

Only compiled exposures are callable through the gateway. `readMany` supports batched relation hydration. Enable searchable/filterable/sortable field metadata only when the source implements those operations; the demonstration above supplies pagination only.

## Mount Atlas behind application access checks

Mount the resource interface when it is ready for authenticated operators. The application supplies session, permission and origin checks for the administration boundary.

```ts
import type { App } from "@kestreljs/framework/app";
import { AtlasProvider } from "@kestreljs/framework/atlas";
import type { HttpMiddleware } from "@kestreljs/framework/http";

function installAtlas<Config>(app: App<Config>, requiredSession: HttpMiddleware<any>, requireOperator: HttpMiddleware<any>, trustedOrigin: HttpMiddleware<any>) {
  return app.register(new AtlasProvider({
    atlas,
    // Require operator access throughout, and check the origin for unsafe requests.
    access: { required: [requiredSession, requireOperator], unsafe: [trustedOrigin] },
  }));
}
```

Supply middleware from [authentication](./authentication.md) and [authorization](./authorization.md), register the HTTP runtime. Guard business actions separately when other transports expose them. Configure `authentication` on the provider for its login page and redirects; see the [login integration](../implementation/atlas.md#login-navigation).

## Add a record action and success feedback

Add a record action when operators need a task beyond the standard CRUD controls. This example reads a selected contact and displays a notification after the operation succeeds.

```ts
import { atlasNotification, defineAtlasRecordAction, onAtlasOperationSuccess } from "@kestreljs/framework/atlas";

const refresh = defineAtlasRecordAction({
  label: "Refresh contact", recordInput: "id", presentation: "dialog",
  // Attach UI feedback to successful completion without changing the source action.
  action: source.action(actions.read).derive(onAtlasOperationSuccess(function *() {
    yield atlasNotification({ message: "Contact refreshed.", level: "success" });
  })),
});
// Add refresh under the resource's recordActions when defining it.
```

Views can expose another query with `defineAtlasResourceView`. Relations reference another resource by ID and use its list/readMany capabilities for lookup and hydration. `defineDrizzleAtlasFields` helps derive field metadata while leaving relations explicit. Operation `mapInput`/`mapOutput` adapters adapt contracts without changing the underlying action.

Dynamic no-code pages, arbitrary external sources and bulk mutations are future work. The [resource reference](../implementation/atlas.md#resource) distinguishes implemented capabilities from design proposals.

## Use cases still to document

- Configure relation lookup, batched hydration and related collections.
- Add resource views with implemented search, filter and sort operations.
- Derive field metadata from Drizzle and adapt operation inputs and outputs.
- Expose HTTP controller and worker operations through catalog sources.
- Wire the login page and session redirects to application authentication.
