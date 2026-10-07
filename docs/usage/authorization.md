# Authorization

[Usage index](./README.md) · [Implementation and assignment stores](../implementation/authorization.md)

Define permissions and protect operations with requirements. The authorization manager uses the principal established by [authentication](./authentication.md) and an injected permission resolver.

## Define roles and register a resolver

Roles and their permissions are authoritative application code. Only subject-role assignments are persisted. Kestrel ships one permission resolver, `RolePermissionResolver`, which combines that catalog with a `SubjectRoleStore`.

```ts
import { App } from "@kestreljs/framework/app";
import {
  AuthorizationProvider,
  definePermission,
  defineRole,
  MemorySubjectRoleStore,
  permission,
  requireAuthorization,
  requireHttpAuthorization,
  RolePermissionResolverProvider,
} from "@kestreljs/framework/authorization";

const manageContacts = definePermission({ id: "contacts.manage" });
const operator = defineRole({
  key: "operator", name: "Operator", permissions: [manageContacts],
});
const subjectRoles = new MemorySubjectRoleStore();

function registerAuthorization<Config>(app: App<Config>) {
  // The application must already provide the scoped authenticationContext.
  app.container.registerValue("subjectRoleStore", subjectRoles);
  app.register(new RolePermissionResolverProvider<Config>([operator]));
  app.register(new AuthorizationProvider<Config>());
}

// Assign the stable role key directly; no role seed or UUID lookup is required.
await subjectRoles.grantRole("member-1", operator.key);
await subjectRoles.revokeRole("member-1", operator.key);
```

The memory store is useful for tests and explicit local setups. Assignments refer to the application's subject ID, not a session or credential ID. Grant and revoke return whether the association changed; repeated calls are idempotent. Multiple roles contribute the union of their permissions. Unknown or removed role keys contribute no permissions. Application management operations should validate user-supplied keys against their catalog before granting them; stores deliberately do not own that catalog.

For direct use without dependency injection, construct `new RolePermissionResolver({ roles: [operator], subjectRoleStore: subjectRoles })` and call `resolvePermissions(subjectId)`.

## Install PostgreSQL storage

Export only the assignment table and its namespace from the application's aggregate Drizzle schema, and include them in the `schema` passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Keep the library table and namespace exported together.
export {
  authorizationSqlSchema,
  authorizationSubjectRoles,
} from "@kestreljs/framework/authorization/adapters/postgres/schema";
```

For a fresh installation, run `npm run db:generate`, review the SQL, then run `npm run db:migrate`. The generator includes library database descriptions automatically. Existing installations must first follow the [migration guidance](../implementation/authorization.md#migrating-the-previous-database-role-model) to preserve active assignments.

Replace the memory registration with the PostgreSQL store provider:

```ts
import { PostgresSubjectRoleStoreProvider } from "@kestreljs/framework/authorization";

function registerPostgresAuthorization<Config>(app: App<Config>) {
  // Database and authentication providers supply their existing scoped dependencies.
  app.register(new PostgresSubjectRoleStoreProvider<Config>());
  app.register(new RolePermissionResolverProvider<Config>([operator]));
  app.register(new AuthorizationProvider<Config>());
}
```

`PostgresSubjectRoleStoreProvider` registers only `subjectRoleStore`; it does not register a permission resolver. Resolve `subjectRoleStoreDependency` in the execution scope or inject it into an Action to grant or revoke roles. PostgreSQL grants optionally record the granting subject: `store.grantRole(subjectId, operator.key, actingSubjectId)`.

Changing a role's permissions requires a deployment, with no permission data migration or seed. Changing its key requires migrating assignments. Do not reuse retired role keys while their old assignments remain. During rolling deployments, each version evaluates its own catalog; coordinate policy changes that cannot tolerate this overlap. See the [implementation contract](../implementation/authorization.md).

## Protect business behavior through every transport

Place the permission check on an action when every caller must satisfy it, including scripts and background jobs. The import action requires contact-management permission before its handler runs.

```ts
import { z } from "zod";
import { defineAction } from "@kestreljs/framework/actions";

const prepareImport = defineAction({
  name: "contacts.prepare-import",
  input: z.object({ count: z.number().int().positive() }),
  output: z.object({ accepted: z.number() }),
  // Enforce the permission for every invocation of this action.
  middleware: [requireAuthorization(permission(manageContacts))],
  handler: ({ count }) => ({ accepted: count }),
});
```

Direct calls, CLI and workers must establish the appropriate authentication context as well; selecting another transport does not bypass this action check. Missing authentication yields 401 semantics, missing permission 403. Resolver outages propagate as operational failures, rather than ordinary denials.

## Protect an HTTP boundary

Use an HTTP policy to gate a group of administration endpoints before their controllers run. It resolves the session before checking the permission required by those endpoints.

```ts
import { createAuthenticationHttpMiddleware, type AuthenticationConfig } from "@kestreljs/framework/authentication";
import { defineHttpAccessPolicy } from "@kestreljs/framework/http";

function operatorAccess(config: AuthenticationConfig) {
  const { requiredSession, trustedOrigin } = createAuthenticationHttpMiddleware(config);
  return defineHttpAccessPolicy("example.operator", [
    // Resolve the caller's session before evaluating its permission.
    trustedOrigin, requiredSession, requireHttpAuthorization(permission(manageContacts)),
  ]);
}
```

Use this as `options.access` on administration endpoints requiring an Origin header, or as `HttpRuntimeProvider`'s `defaultAccess` when it should apply to every controller without an override. See [default HTTP access](./http.md#set-default-access-and-override-a-route). HTTP policy protects that boundary; retain action middleware where the permission must apply to other callers. `allOf(permission(a), permission(b))` requires every child; `anyOf(...)` accepts any child. Empty combinations are rejected. Effective permissions are cached within one execution, so revocations affect subsequent executions.

## Supply a custom resolver

The storage-neutral `PermissionResolver` contract remains available for application integrations. Register `permissionResolver` yourself and use `AuthorizationProvider` without `RolePermissionResolverProvider`. Kestrel does not ship a resolver for database-defined role permissions.

## Deferred capabilities

Resource ownership, organization-scoped assignments, role inheritance, runtime role editing, and durable authorization audit history are not implemented. Establishing a principal for authorized execution outside HTTP remains an application responsibility.
