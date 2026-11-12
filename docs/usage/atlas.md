# Atlas

[Usage index](./README.md) · [Implementation and resource contracts](../implementation/atlas.md)

Use Atlas to expose selected application operations through a resource-oriented administration interface. Resources reference explicit source operations; Atlas does not infer authorization or read database tables directly.

Atlas is included in `@kestreljs/framework` under the `@kestreljs/framework/atlas` entry point. The package ships its compiled browser assets; no separate Atlas installation or browser build is needed. Applications own authentication, authorization and business data.

New projects include Atlas by default, both interactively and with `--yes` or redirected input; answer no or pass `--no-atlas` to omit it. The generated starter mounts an empty Atlas at `/admin` only in the local environment, with application-owned resource and exposure configuration. See [installation choices](./installation.md#choose-whether-to-include-atlas).

## Customize colors and logo

Set `branding` and `theme` on `defineAtlas()`. This configuration applies to navigation and the password-login page, independently of the delivery adapter. The application serves its own image assets; the following example assumes the two URLs are publicly available, including before authentication.

```ts
import { defineAtlas } from "@kestreljs/framework/atlas";

export const administration = defineAtlas({
  title: "Example Administration",
  resources: [], // Replace with application-owned resources.
  branding: {
    logo: {
      src: "/branding/symbol.svg",
      alt: "Example",
      darkSrc: "/branding/symbol-light.svg", // Optional dark-mode image.
    },
  },
  theme: {
    primaryColor: "#176b70", // Derives accents, focus, selection and control colors.
    light: {
      colors: {
        background: "#f5f8f7",
        sidebarBackground: "#123638",
        sidebarText: "#eaf4f3",
      },
    },
    dark: {
      colors: { primary: "#79c9cc", background: "#101b1c" },
    },
  },
});
```

All options are optional. Without a logo, Atlas displays the title's initial. Without `darkSrc`, the same image is used in both modes. Atlas automatically uses the logo as its favicon and switches it with the effective theme, including manual theme choices. Without a logo, Atlas leaves the document favicon unchanged. Images keep their own background and fit the existing mark area; prefer a compact symbol with adequate contrast against both the sidebar and login surface. URLs must be root-relative or HTTPS, and alternative text must be nonblank. Atlas does not upload or proxy images; missing assets remain browser image failures.

Colors use six-digit hexadecimal notation. `primaryColor` generates light and dark palettes, including hover, focus, selection, sidebar accents and contrasting black or white text on filled controls. `light.colors` and `dark.colors` override individual semantic roles; omitted roles retain generated values or Atlas defaults. Overriding `primary` derives its associated colors for that scheme. Error and success colors remain independent. Explicit overrides take precedence, so applications remain responsible for contrast when overriding foreground/background pairs.

The existing light/dark/system selector and stored user preference continue to work. Appearance is embedded in the initial HTML, including login HTML, and applied before React renders without fetching the protected resource manifest. Keep this configuration public and free of secrets. Invalid colors, unknown roles and unsupported logo URLs fail when Atlas is constructed.

Use the exported `AtlasBrandingOptions`, `AtlasThemeOptions` and `AtlasColors` types for shared configuration. See the [appearance implementation contract](../implementation/atlas.md#visual-identity) for semantic roles and derivation details.

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

`authentication.requiredSession` runs before `access.required` on protected pages, the manifest, APIs and operations, including delegated controllers. Unsafe requests also cross `access.unsafe`. Anonymous page navigation redirects to the public login page; anonymous API calls return `401`, authenticated callers without the permission return `403`, and missing or untrusted mutation origins return `403`. The password sign-in and sign-out endpoints use same-origin paths starting with a single slash. Packaged client assets and the login document remain public and do not grant data access. See [login navigation](../implementation/atlas.md#login-navigation) for the full behavior.

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

Declare the identity and display fields in the read output schema. An explicit identity input appears in the create form when the create operation declares it. The standard form preserves entered numeric values and repeated numeric identifiers when their schema also allows `null`.

## Expose inspection with selected mutations

Every resource supplies `list`, `read` and `readMany`. Omit `create`, `update` or `delete` when the application does not support that operation. For an inspection resource, provide only the three read capabilities in the example above. Add record Actions for explicit domain commands such as publishing a proposal or closing a discussion, preserving their authoritative application authorization and validation.

Omitted mutations have no manifest entry, no standard UI control and no create/edit route. Their operation IDs are absent from the gateway allowlist and return `404`. All fields are inferred read-only when both create and update are absent. Optional capabilities describe supported operations for every operator of the resource; they do not implement per-record permissions. The application must still enforce access and business rules in the exposed operations.

## Group resources in navigation

Set `navigationGroup: "Editorial"` on a `defineAtlasResource()` definition to place it under that sidebar heading. Resources with matching labels share one section, even when their declarations are interleaved. Sections appear in order of their first resource; resources and their Views retain declaration order within each section. Labels are trimmed and cannot be blank.

Omit `navigationGroup` to retain the default Resources section. Grouping changes sidebar presentation only: it does not change URLs, resource capabilities, home-page cards or access policies. Keep authorization in the source operations and Atlas access composition.

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


## Add links to a record page

Use `recordLinks` on `defineAtlasResource` to open a record's public page or an external application from its Atlas detail page. Each entry has a stable lowercase kebab-case identifier, a nonempty `label` and a synchronous `href` builder. The builder argument is inferred from the validated output of the Resource's `read` capability, excluding `null` and `undefined`. Keep that output schema specific to preserve field inference; the application owns the source operations and any base URL configuration.

```typescript
import { defineAtlasResource } from "@kestreljs/framework/atlas";

// Reuse application-owned source and capabilities whose read output includes slug and published.
const resource = defineAtlasResource({
  id: "space",
  label: "Spaces",
  identity: "id",
  source,
  capabilities,
  recordLinks: {
    "public-page": {
      label: "Open public page",
      // Hide navigation while this record has no public page.
      href: (space) => space.published
        ? `/spaces/${encodeURIComponent(space.slug)}`
        : undefined,
    },
  },
});
```

Builders execute on the server after the normal authorized `read` operation, using its validated public output. They must be pure and synchronous, without additional data access or record mutation. Missing records skip all builders. Return `undefined` to omit a link; returning an invalid URL or throwing fails the read request as a server error rather than silently hiding a configuration problem. Only HTTP(S) URLs and same-origin absolute paths starting with a single `/` are accepted; encode record values when inserting them into path segments.

The read gateway response retains its business `data` and `effects` and adds `recordLinks: [{ id, label, href }]` for Resources configured with links, including an empty array when no links apply. Functions and configuration closures are never serialized into the manifest. The standard UI groups links in declaration order under a single `Links` menu in the record header, even for one link. No menu is displayed when all links are absent. Long menus scroll within a bounded height and entries open a new tab with `noopener noreferrer`. There is no additional link request, and list rows do not display these links. Cached links refresh with the record's normal read query. See the [implementation contract](../implementation/atlas.md#record-links) for boundaries and deferred extensions.

## Show record history

Add the optional `history` capability to show a collapsible **History** matrix on a record page. Rows are fields and columns are events, ordered oldest to newest. The panel loads on opening, initially shows the latest 20 events, and loads older columns on demand. Blank cells mean unchanged, `NULL` means an explicit null, and `""` means an empty string. Event headers show only the date and operation; sequence identifiers remain internal to ordering and pagination. Actor and reason appear in two always-visible, visually distinct metadata rows above the business fields. Deletion events have no business values. History cells reuse the same field renderers as lists, including resource-specific overrides. Relations use their configured display field or the target Resource computed display, with links to the target record. These labels reflect current related records, not their state at the event date. Missing related records fall back to identifiers. Explicit null and empty-string markers remain distinct. Field labels reuse Resource metadata; hidden fields are omitted from presentation but must also be excluded by the server when sensitive.

The application owns the history Action, its authorization and identity mapping. Use `atlasHistoryInputSchema` and `atlasHistoryOutputSchema` from `@kestreljs/framework/atlas` for the portable query contract. The input always uses `id` for the record route identity, independently from the Resource identity property. The output contains `fields`, newest-first `events` and nullable `nextCursor`; each event contains `sequence`, ISO `changedAt`, `operation`, nullable `actor` and `reason`, and a sparse `values` object.

```ts
import { defineAtlasResource } from "@kestreljs/framework/atlas";

// source, capabilities and historyAction are application-owned and authorized.
const resource = defineAtlasResource({
  id: "article", label: "Articles", identity: "id", source,
  capabilities: { ...capabilities, history: source.query(historyAction) },
});
```

For `defineHistoryTable` storage, use the [database history reader](./database.md#read-sparse-history) inside the Action. Explicitly allowlist exposed fields and enforce record or tenant access on every call, including direct gateway calls. Current-record access does not automatically authorize old values. Reject missing current records if deleted-resource browsing is outside the application's policy. History failures remain local to the panel and can be retried. History queries refresh when the Resource query cache is invalidated after writes.

Configure actor resolution once on Atlas when history actor strings identify records of an application-owned Resource:

```ts
import { defineAtlas } from "@kestreljs/framework/atlas";

// personResource and articleResources are application-owned Atlas Resources.
const atlas = defineAtlas({
  history: { actor: { resource: "person" } }, // Must match a registered Resource ID.
  resources: [personResource, ...articleResources],
});
```

Every history panel inherits this configuration. The Actor row uses the target's current `displayField` or computed `display`, with a link to its record. Authors share deduplicated, bounded `readMany` batches and the relation cache with business relations to the same Resource. The application must write actor values matching that Resource's identity input contract and authorize the target reads. A null actor displays `Unknown`; missing records retain their identifiers. Without configuration, actor strings stay plain text. Invalid target Resource IDs fail during Atlas construction. No storage or history-output change is needed. Mixed actor identity kinds and per-Resource overrides remain deferred.

An insertion can represent an initial baseline rather than the actual creation time. Without a baseline, earlier field values may be unknown; the matrix does not reconstruct or infer them. See [implementation and deferred extensions](../implementation/atlas.md#record-history-matrix).

## Configure text length

Record page titles and standard resource lists, including related-record tables, shorten text and email fields and each relation label to 50 visible grapheme clusters, including the final `…`. Short values remain unchanged. Hovering a shortened value reveals its complete text through the native browser tooltip; detail fields and history retain complete values. Identifiers, dates, numbers, JSON and form inputs keep their existing rendering. Data, searching, sorting and server-computed labels are unchanged.

```ts
import { defineAtlas, defineAtlasResource } from "@kestreljs/framework/atlas";

// The application supplies the Resource's source and capabilities.
const article = defineAtlasResource({
  id: "article", label: "Articles", identity: "id", source, capabilities,
  textMaxLength: 100, // Override the global limit for this Resource's tables and record titles.
});
const atlas = defineAtlas({
  defaults: { textMaxLength: 50 }, // Optional: 50 is Atlas's built-in default.
  resources: [article],
});
```

Resolution order is Resource, global `defaults`, then 50. Set `false` at either level to disable shortening; omit the setting or use `undefined` to inherit. Numeric limits must be positive safe integers; invalid settings fail during definition/construction. Record titles use the displayed Resource limit. Relation labels inherit the containing table's Resource limit, regardless of the target Resource's configuration. Application field renderers receive the original `value`, `context: "list"`, global `textMaxLength` and Resource metadata, and own their presentation. Keep computed labels complete unless deliberate shortening is required in every context; `truncateText` remains available for that purpose. See [presentation internals](../implementation/atlas.md#text-presentation).

## Configure record labels

A Resource defaults to its identity. Use `display: "name"` for a direct field (`displayField` remains supported), or declare inputs and a synchronous formatter for a computed label. Do not combine `display` with `displayField`.

```ts
import { defineAtlasResource } from "@kestreljs/framework/atlas";

// The application supplies source, capabilities and the registered revision Resource.
const article = defineAtlasResource({
  id: "article", label: "Articles", identity: "id", source, capabilities,
  fields: {
    revisionId: {
      relation: { resource: "revision", cardinality: "one", relatedRecords: false },
    },
  },
  display: {
    select: {
      title: { relation: "revisionId", field: "title" },
      code: "id", // Direct inputs may be combined with related fields.
    },
    format: ({ title }) => typeof title === "string"
      ? title : undefined,
  },
});
```

Selections reference raw fields, not another Resource's computed label. Relation selections require an explicitly declared `one` relation; the field may itself be nullable. Values are typed as `unknown` because targets may belong to independent sources; narrow them in the formatter. Unknown fields and invalid relations fail Atlas compilation. Keep formatters pure and synchronous: they receive only selected values, without an execution context. Returning `undefined` or an empty string falls back to the record identity. Missing or inaccessible records omitted by `readMany` also produce missing inputs; operation rejection and formatter exceptions propagate as failures.

The gateway resolves labels for `read`, `list`, `readMany`, specialized relation lookups and explicit related-record queries. It deduplicates identifiers per target Resource and invokes authorized `readMany` operations internally, without another browser request for the computed label. Set `readManyBatchSize` on a target Resource when its source accepts fewer or more than the default 100 identifiers. Each batch passes normal input/output validation and source middleware. The source remains responsible for efficient SQL or remote I/O within that operation. Ordinary relation hydration remains a separate browser operation, grouped by target Resource and chunked using the same `readManyBatchSize`. Successfully resolved and missing identities are cached for reuse for 30 seconds; Resource cache invalidation invalidates these entries too.

Labels appear in page titles, a read-only first list column, relation values and autocomplete candidates. Computed labels do not automatically become searchable, filterable or sortable; implement those operations explicitly in the source. Mutations invalidate Atlas Resource queries so labels based on other Resources refresh as well. External changes require the usual refetch. `truncateText` counts grapheme clusters, includes the ellipsis within the limit and requires a positive integer maximum.

See [display resolution internals](../implementation/atlas.md#computed-record-labels) for execution boundaries and future optimizations.
