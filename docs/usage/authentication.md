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
} from "@kestrel/framework/authentication";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required.

## Compose session services and routes

Use this composition to add password sign-in and cookie-backed sessions to an HTTP application. The memory stores make it suitable for an isolated example or test.

```ts
import { z } from "zod";
import { App, defineCatalog } from "@kestrel/framework/app";
import { Argon2idPasswordHasher, AuthenticationProvider, authenticationConfigBase, createAuthenticationActions, createAuthenticationHttpControllers, defineAuthentication, DefaultUsernameNormalizer, MemoryAuthenticationAdapter } from "@kestrel/framework/authentication";
import { configure, createConfigurationApi } from "@kestrel/framework/configuration";
import { defineHttpAccessPolicy } from "@kestrel/framework/http";

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
app.container.registerValue("authenticationAdapter", adapter);
app.container.registerValue("authenticationSubjectProvider", {
  // Resolve the subject from application-owned data when authentication needs it.
  findById: async (id: string) => subjects.get(id) ?? null,
});
app.register(new AuthenticationProvider(config.authentication, definition, hasher));
```

Add `HttpRuntimeProvider` as in [application composition](./app.md). The default routes are POST `/authentication/password/sign-in`, POST `/authentication/sign-out` and GET `/authentication/session`. Sign-in/out enforce trusted origins; successful sign-in sets the configured session cookie.

For PostgreSQL, register `PostgresAuthenticationAdapter` against the scoped `DatabaseManager`, export the authentication schema into migrations and supply the same subject provider. Stores may also be registered separately by capability; see the [store composition contract](../implementation/authentication.md#adapter-composition).

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

The default attempt guard allows attempts. Configure an application-owned `authenticationAttemptGuard` or the bundled throttling guard before exposing password authentication; the [guard contract](../implementation/authentication.md#throttling-and-security-layers) explains the supported integration.

Sessions have idle and absolute expiry, and account state is checked when resolving a session. Claims are snapshots, not live permissions. Invalid credentials produce a generic failure; missing required authentication has 401 semantics. Keep raw credentials and session tokens out of logs.

## Use cases still to document

- Provision accounts and credentials in a PostgreSQL transaction.
- Configure throttled sign-in attempts.
- Exercise sign-in, session rotation and logout through HTTP cookies.
- Add session claims and read the principal in an action or an optionally authenticated route.
- Disable an account and revoke its active sessions.
