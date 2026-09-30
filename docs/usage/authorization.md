# Authorization

[Usage index](./README.md) · [Implementation and RBAC stores](../implementation/authorization.md)

Define permissions and protect operations with requirements. The authorization manager uses the principal established by [authentication](./authentication.md) and an injected permission resolver.

## Install PostgreSQL storage

Add these objects to the application's global Drizzle schema and to the `schema` object passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Keep the library tables and namespace exported together.
export {
  authorizationSqlSchema,
  authorizationRoles,
  authorizationRolePermissions,
  authorizationSubjectRoles,
} from "@kestreljs/framework/authorization";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required.

## Define roles and register a resolver

Use role-based permissions when a group of users should share access to the same operations. This example gives an operator role permission to manage contacts and assigns it to one subject.

```ts
import { App } from "@kestreljs/framework/app";
import { AuthorizationProvider, definePermission, defineRole, MemoryAuthorizationAdapter, permission, requireAuthorization, requireHttpAuthorization } from "@kestreljs/framework/authorization";

const manageContacts = definePermission({ id: "contacts.manage" });
const operator = defineRole({
  key: "operator", name: "Operator", permissions: [manageContacts],
});
const permissions = new MemoryAuthorizationAdapter({ roles: [operator] });

function registerAuthorization<Config>(app: App<Config>) {
  // The application must already provide the scoped authenticationContext.
  app.container.registerValue("permissionResolver", permissions);
  app.register(new AuthorizationProvider<Config>());
}
const role = await permissions.findRoleByKey("operator");
// Assignments refer to the application subject, not a session or credential ID.
if (role !== undefined) await permissions.grantRole("member-1", role.id);
```

Memory is useful for tests. Production may inject a custom `PermissionResolver` or the PostgreSQL RBAC adapter, with roles and subject-role stores from the same integration. Role assignments use the application's subject ID. See [PostgreSQL composition](../implementation/authorization.md#postgresql-rbac-adapter).

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

Use this on administration endpoints requiring an Origin header. HTTP policy protects that boundary; retain action middleware where the permission must apply to other callers. `allOf(permission(a), permission(b))` requires every child; `anyOf(...)` accepts any child. Empty combinations are rejected. Effective permissions are cached within one execution, so revocations affect subsequent executions.

## Use cases still to document

- Manage PostgreSQL role assignments and revocation.
- Compose permission requirements with allOf and anyOf.
- Supply an application-specific permission resolver.
- Establish a principal for authorized execution outside HTTP.
