# Atlas

[Usage index](./README.md) · [Implementation and resource contracts](../implementation/atlas.md)

Use Atlas to expose selected application operations through a resource-oriented administration interface. Resources reference explicit source operations; Atlas does not infer authorization or read database tables directly.

Atlas is included in `@kestreljs/framework` under the `@kestreljs/framework/atlas` entry point. The package ships its compiled browser assets; no separate Atlas installation or browser build is needed. Applications own authentication, authorization and business data.

New projects include Atlas by default, both interactively and with `--yes` or redirected input; answer no or pass `--no-atlas` to omit it. The generated starter mounts an empty Atlas at `/admin` only in the local environment, with application-owned resource and exposure configuration. See [installation choices](./installation.md#choose-whether-to-include-atlas).

## Install Atlas with application access checks

**Atlas does not restrict access when `authentication` and `access` are omitted.** Atlas declares its own HTTP access policies, so the HTTP runtime's general `defaultAccess` policy does not automatically protect it. Configure the boundary before exposing business resources or enabling Atlas in a deployment.

The initial administration model gives every authorized operator access to the exposed resources. Install [authentication](./authentication.md) and [authorization](./authorization.md), including their providers and application-owned subject/role resolution, then register Atlas before starting the HTTP runtime. Configure trusted browser origins, deployment cookie settings and an authentication attempt guard before exposing password sign-in; the default attempt guard allows attempts.

This composition assumes three application-owned modules: an Atlas definition, authentication controllers created with `createAuthenticationHttpControllers`, and a registered `admin.access` permission granted through an administrator role. Adapt their import paths to your application; the empty generated starter does not scaffold authentication.

```ts
import type { App } from "@kestreljs/framework/app";
import { AtlasProvider, viteAtlasClient } from "@kestreljs/framework/atlas";
import { AuthenticationRequiredError } from "@kestreljs/framework/authentication";
import { permission, requireHttpAuthorization } from "@kestreljs/framework/authorization";
import { applicationBackoffice } from "../../../admin/index.js";
import { applicationAuthenticationHttp } from "../../authentication/actions/authentication_catalog.js";
import { adminAccessPermission } from "../authorization/permissions.js";

export function installAtlas<Config>(app: App<Config>, enabled: boolean) {
  return app.register(new AtlasProvider(viteAtlasClient({}), {
    enabled,
    atlas: applicationBackoffice,
    authentication: {
      // The application owns sign-in/out, cookies and credential throttling.
      passwordSignInUrl: applicationAuthenticationHttp.signInWithPassword.route.url,
      signOutUrl: applicationAuthenticationHttp.signOut.route.url,
      requiredSession: applicationAuthenticationHttp.middleware.requiredSession,
      isAuthenticationRequired: (error) => error instanceof AuthenticationRequiredError,
    },
    access: {
      // A valid session alone does not grant administration privileges.
      required: [requireHttpAuthorization(permission(adminAccessPermission))],
      // Cookie-authenticated mutations must also pass the origin check.
      unsafe: [applicationAuthenticationHttp.middleware.trustedOrigin],
    },
  }));
}
```

`authentication.requiredSession` runs before `access.required` on protected pages, the manifest, APIs and operations, including delegated controllers. Unsafe requests also cross `access.unsafe`. Anonymous page navigation redirects to the public login page; anonymous API calls return `401`, authenticated callers without the permission return `403`, and missing or untrusted mutation origins return `403`. Packaged client assets and the login document remain public and do not grant data access. See [login navigation](../implementation/atlas.md#login-navigation) for the full behavior.

If another system owns login navigation, omit `authentication` and put both the required-session middleware and the operator-permission middleware in `access.required`; retain `access.unsafe` for cookie-authenticated mutations. Do not replace authorization with a session check alone.

The Atlas boundary does not protect direct Action calls or other transports. Put required business authorization in authoritative Action middleware, source mappings and repositories as appropriate. Hidden fields and read-only controls are presentation metadata, not server authorization. Applications needing per-record, field or tenant restrictions must enforce them there before exposing the corresponding resources.

### Keep the public starter local

The generated empty starter intentionally omits authentication for local exploration. Keep its `local`-only configuration until the protected composition above is installed. `APP_CONFIG__BACKOFFICE__ENABLED=true` only enables mounting: it does not add authentication or authorization, and no executable check rejects an unprotected deployment. Mounting with only `{ atlas: applicationBackoffice }` is an intentional public configuration suitable for an isolated demonstration, not the recommended administration installation.

### Verify the deployment composition

Use `fastify.inject()` with the application's actual provider and catalogs to verify anonymous API rejection, authenticated non-operator rejection, authorized access, and mutation rejection with missing or untrusted Origin headers. Exercise a real gateway operation as well as unmatched routes, and verify that a rejected mutation never executes its business handler. Keep separate Action tests for restrictions that must hold for direct or alternate-transport calls. The middleware implementation and role assignments remain application responsibilities.

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

## Expose inspection with selected mutations

Every resource supplies `list`, `read` and `readMany`. Omit `create`, `update` or `delete` when the application does not support that operation. For an inspection resource, provide only the three read capabilities in the example above. Add record Actions for explicit domain commands such as publishing a proposal or closing a discussion, preserving their authoritative application authorization and validation.

Omitted mutations have no manifest entry, no standard UI control and no create/edit route. Their operation IDs are absent from the gateway allowlist and return `404`. All fields are inferred read-only when both create and update are absent. Optional capabilities describe supported operations for every operator of the resource; they do not implement per-record permissions. The application must still enforce access and business rules in the exposed operations.

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

## Explicit provider adapters

`AtlasProvider(adapter, options)` requires an explicit `AtlasClientAdapterDefinition`; `viteAtlasClient(settings)` selects bundled browser delivery. Atlas manifests, access policy and authentication options remain distinct from delivery. Backend initialization waits until HTTP mounting.

See the [shared composition convention](../implementation/app.md#provider-adapter-convention) and [configuration recipes](../usage/configuration.md#additional-provider-composition).
