# Authentication

[Usage index](./README.md) · [Implementation, stores and session lifecycle](../implementation/authentication.md)

Kestrel supplies password authentication and stateful sessions. Your application owns subjects, account provisioning and session claims. [Authorization](./authorization.md) separately decides which operations a principal may perform.

## Install PostgreSQL storage

Add these objects to the application's global Drizzle schema and to the `schema` object passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Keep the library tables and namespace exported together.
export {
  authenticationSqlSchema,
  authenticationAccounts,
  authenticationPasswordCredentials,
  authenticationSessions,
} from "@kestreljs/framework/authentication";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required.

## Compose session services and routes

Use this composition to add password sign-in and cookie-backed sessions to an HTTP application. The memory stores make it suitable for an isolated example or test.

```ts
import { z } from "zod";
import { App, defineCatalog } from "@kestreljs/framework/app";
import { Argon2idPasswordHasher, AuthenticationProvider, authenticationConfigBase, createAuthenticationActions, createAuthenticationHttpControllers, defineAuthentication, DefaultUsernameNormalizer, MemoryAuthenticationAdapter, memoryAuthentication } from "@kestreljs/framework/authentication";
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { defineHttpAccessPolicy } from "@kestreljs/framework/http";

const configuration = createConfigurationApi({ environments: ["test"], defaultEnvironment: "test" });
const config = configuration.resolveConfig({
  authentication: configure(authenticationConfigBase, {
    session: {}, mechanisms: { password: {} },
    http: { cookie: {}, trustedOrigins: ["https://app.example"] },
  }),
}, { environment: "test", env: {} });
const definition = defineAuthentication({
  // This minimal session adds no application-specific claim fields.
  sessionClaims: { schema: z.object({}), create: () => ({}) },
});
const authentication = createAuthenticationActions(definition);
const { middleware, ...controllers } = createAuthenticationHttpControllers(
  authentication, config.authentication, defineHttpAccessPolicy("example.public"),
);
const adapter = new MemoryAuthenticationAdapter<Record<string, never>>();
const hasher = new Argon2idPasswordHasher();
const subjects = new Map([["member-1", { id: "member-1" }]]);
const app = new App(config, {
  catalog: defineCatalog({
    authentication: { actions: authentication.actions, controllers: { http: controllers } },
  }),
});
// Memory storage is for tests; production composition supplies persistent stores.
app.container.registerValue("authenticationSubjectProvider", {
  // Resolve the subject from application-owned data when authentication needs it.
  findById: async (id: string) => subjects.get(id) ?? null,
});
app.register(new AuthenticationProvider(config.authentication, memoryAuthentication(adapter), definition, hasher));
```

Add `HttpRuntimeProvider` as in [application composition](./app.md). The default routes are POST `/authentication/password/sign-in`, POST `/authentication/sign-out` and GET `/authentication/session`. Sign-in/out enforce trusted origins; successful sign-in sets the configured session cookie.

For PostgreSQL, pass `postgresAuthentication(managerDependency)` to the provider, using the scoped `PostgresDrizzleManager`, export the authentication schema into migrations and supply the same subject provider. Stores may also be registered separately by capability; see the [store composition contract](../implementation/authentication.md#adapter-composition).

## Provision credentials

Create credentials when onboarding a subject that already exists in your application. This recipe links that subject to an authentication account and stores a password hash.

```ts
async function provisionMember(username: string, password: string) {
  const account = await adapter.createAccount({ subjectId: "member-1" });
  await adapter.createPasswordCredential({
    accountId: account.id,
    username,
    // Use the same normalization policy for provisioning and sign-in.
    normalizedUsername: new DefaultUsernameNormalizer().normalize(username),
    // Persist the hash; the credential store must never receive the raw password.
    passwordHash: await hasher.hash(password),
  });
  return account;
}
```

This storage-level recipe assumes application validation has already enforced the configured password policy and username uniqueness. Use the same username normalizer as password authentication. In a persistent application, coordinate subject creation, account creation and credentials in one transaction.

## Require a session on a route

Apply a session policy when an endpoint must identify its caller before running. This version also checks the origin, making it suitable for protected browser mutations.

```ts
const authenticatedAccess = defineHttpAccessPolicy("example.authenticated", [
  middleware.trustedOrigin,
  // Stop unauthenticated requests before the protected controller runs.
  middleware.requiredSession,
]);
```

Assign this policy to protected controllers. The trusted-origin check requires an Origin header; select policies deliberately for browser mutations versus read-only navigation. An optional-session policy uses `middleware.optionalSession`. Services inspect the scoped `authenticationContextDependency`; business actions can use `requireAuthentication` to protect direct calls too.

## Inject the current application user

`AuthenticationProvider` automatically registers `currentUser` and `optionalCurrentUser`. Declare their exported typed dependencies in an action, controller or middleware; Kestrel awaits the lookup and injects the application-owned subject directly.

```ts
import { z } from "zod";
import { defineAction } from "@kestreljs/framework/actions";
import { currentUser, optionalCurrentUser } from "@kestreljs/framework/authentication";

type User = { id: string; displayName: string };
const getMyName = defineAction({
  name: "profile.my-name",
  output: z.string(),
  dependencies: { user: currentUser<User>() },
  // The asynchronous subject lookup finishes before this handler executes.
  handler: (_input, { user }) => user.displayName,
});
const getGreeting = defineAction({
  name: "profile.greeting",
  output: z.string(),
  dependencies: { user: optionalCurrentUser<User>() },
  handler: (_input, { user }) => user === undefined ? "Welcome" : `Welcome, ${user.displayName}`,
});
```

Run `getMyName` behind `middleware.requiredSession` and `getGreeting` behind `middleware.optionalSession`. Any middleware consuming a current-user dependency must come after session middleware in the access policy. A pending authentication context produces an explicit configuration error for both dependencies, including direct actions without an established authentication context; resolving a dependency never reads HTTP cookies itself.

The first current-user request calls `authenticationSubjectProvider.findById(principal.subjectId)`. Both variants share one lookup and the same returned object for that execution, including nested actions and concurrent consumers. Requests using only the principal or session claims never load the subject through these dependencies. The provider must return the application `User` type used in the dependency descriptor; Kestrel does not define a user model or add the object to session claims.

`currentUser<User>()` yields `User` and throws `AuthenticationRequiredError` (HTTP 401) for anonymous access or a deleted subject. `optionalCurrentUser<User>()` yields `User | undefined` for those cases. Lookup errors propagate for both variants and remain cached within the execution. Resolving a missing subject does not rewrite the already resolved principal; code requiring a live subject should depend on the current user. To construct a service from this asynchronous value, use an [explicit asynchronous factory](./di.md#inject-an-asynchronously-created-value).

The default attempt guard allows attempts. Configure an application-owned `authenticationAttemptGuard` or the bundled throttling guard before exposing password authentication; the [guard contract](../implementation/authentication.md#throttling-and-security-layers) explains the supported integration.

Sessions have idle and absolute expiry, and account state is checked when resolving a session. Claims are snapshots, not live permissions. Invalid credentials produce a generic failure; missing required authentication has 401 semantics. Keep raw credentials and session tokens out of logs.

## Use cases still to document

- Provision accounts and credentials in a PostgreSQL transaction.
- Configure throttled sign-in attempts.
- Exercise sign-in, session rotation and logout through HTTP cookies.
- Add session claims and read the principal in an action or an optionally authenticated route.
- Disable an account and revoke its active sessions.

## Explicit provider adapters

`AuthenticationProvider(config, adapter, definition, hasher)` registers an execution-scoped adapter. `postgresAuthentication(manager, tables?)` replaces the adapter-only PostgreSQL provider. Independently registered account, session and password-credential adapters still override the corresponding combined-adapter fallbacks. Public storage contracts use the `StorageAdapter` suffix.

See the [shared composition convention](../implementation/app.md#provider-adapter-convention) and [configuration recipes](../usage/configuration.md#additional-provider-composition).

## Redis sessions with PostgreSQL accounts

Select session storage inside the adapter definition passed to the existing provider:

```ts
import {
  AuthenticationProvider,
  postgresAuthentication,
  redisSessions,
  withAuthenticationSessions,
} from "@kestreljs/framework/authentication";
import { redisDependency } from "./providers/redis_provider.js";

app.register(new AuthenticationProvider(
  app.config.authentication,
  withAuthenticationSessions(
    postgresAuthentication(databaseManagerDependency),
    redisSessions(redisDependency, app.config.authentication.adapter.sessions),
  ),
  authenticationDefinition,
  passwordHasher,
));
```

Compose `redisSessionsConfigBase` under `adapter.sessions` in the application authentication configuration. Its `keyPrefix` defaults to `kestrel:authentication:`. Shared connection credentials remain in Redis infrastructure configuration. `RedisSessionStorageAdapter(client, settings)` is available for standalone use.

Accounts and password credentials remain in the base adapter; sessions alone use Redis. Account state and `securityVersion` are still checked during authentication. The combined PostgreSQL session/account query is deliberately unavailable in this composition. Both child adapters remain execution-scoped and borrow the infrastructure connections.

Redis 7.4 or later is required for native hash-field expiration. Active, idle-expired and revoked session records are retained until absolute expiration, so administration can inspect revocation metadata. The manager and atomic `touch()` enforce idle expiration without resurrecting expired or revoked sessions. Concurrent touches cannot shorten an existing activity watermark. Account indexes expire at the latest retained absolute deadline and remove stale members on subsequent session creation. No pruning task is required.

`withAuthenticationSessions()` also accepts external `SessionStorageAdapterDefinition` recipes created with `defineSessionStorageAdapter()`. There is no backend-name registry or Redis-specific provider subclass. Storage failures propagate and fail closed. Redis session writes do not share the base database transaction; avoid publishing a session whose account changes have not committed. Use a `noeviction` deployment with an explicit durability policy. See the [Redis implementation](../implementation/authentication.md#redis-session-adapter).
