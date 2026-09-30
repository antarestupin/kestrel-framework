# Tokens

[Usage index](./README.md) · [Implementation and strategy contracts](../implementation/tokens.md)

Use typed token definitions for invitations, verification links or other bearer capabilities. Choose a strategy according to the lifecycle guarantee you need.

| Strategy | Single use and revocation | Payload |
| --- | --- | --- |
| Stored opaque | Supported | Stored server-side |
| Signed JWT | Unsupported | Readable by the bearer |
| Hybrid JWT | Supported through shared storage | Readable by the bearer |

## Install PostgreSQL storage

Add these objects to the application's global Drizzle schema and to the `schema` object passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Keep the library tables and namespace exported together.
export {
  tokensSqlSchema,
  tokenRecords,
} from "@kestreljs/framework/tokens";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required. If you create a dedicated table with `createPostgresTokenTable()`, export that table and its namespace instead of the default objects, and pass the same table to the store.

## Issue and atomically consume a single-use token

Use a single-use token for an invitation or verification link that must not be accepted twice. The memory-backed example issues an invitation with a short lifetime and then consumes it.

```ts
import { z } from "zod";
import { defineToken, MemoryTokenStore, StoredTokenStrategy, TokenManager } from "@kestreljs/framework/tokens";

const invitation = defineToken({
  name: "member.invitation",
  payload: z.object({ memberId: z.string() }),
  usage: "single",
  replacement: "same-subject",
  // Use this member identity to replace or revoke related invitations.
  subject: ({ memberId }) => memberId,
});
const store = new MemoryTokenStore();
const tokens = new TokenManager({ stored: new StoredTokenStrategy(store, { tokenBytes: 32 }) }, { maxPayloadBytes: 4_096 });
const grant = await tokens.issue(invitation, { memberId: "member-1" }, { ttlSeconds: 900 });

// Hand the bearer value only to its intended recipient; do not log it.
const payload = await tokens.consume(invitation, grant.token);
if (payload === undefined) throw new Error("Invalid invitation.");
```

Issuing another invitation for the same subject replaces the previous active one. Single-use definitions require `consume`; reusable definitions use `verify`. Invalid, expired, revoked, consumed or wrong-definition values resolve to `undefined`. Storage failures are not successful validation.

## Compose the provider and revoke a subject's tokens

Register token services when application actions need a shared manager. Revoke a subject's outstanding tokens when their invitations or other capabilities should no longer work.

```ts
import { App } from "@kestreljs/framework/app";
import { TokenProvider } from "@kestreljs/framework/tokens";

const app = new App({});
app.container.registerValue("tokenStore", store);
app.register(new TokenProvider({ stored: { tokenBytes: 32, maxPayloadBytes: 4_096 } }));
// This standalone manager and the provider share the registered store.
await tokens.revokeForSubject(invitation, "member-1");
```

Normally resolve settings through `tokensConfigBase` and inject `tokenManagerDependency` into services. Use `PostgresTokenStore` with the scoped database manager for persistence. It can join the protected domain mutation's transaction, so token consumption and the mutation commit or roll back together. `issueMany` batches issuance; schedule bounded `prune` calls through application maintenance.

## Configure signed and hybrid representations

Choose signed tokens when recipients need a verifiable payload, or hybrid tokens when you also need stored revocation or single-use state. The application supplies the keyring and verification policy.

```ts
import { HybridTokenStrategy, JwtTokenStrategy, type JwtTokenStrategyOptions, type TokenStore } from "@kestreljs/framework/tokens";

function signedTokens(options: JwtTokenStrategyOptions, store: TokenStore) {
  // options supplies the application's keyring, issuer and audience policy.
  return new TokenManager({
    jwt: new JwtTokenStrategy(options),
    // The hybrid strategy adds stored lifecycle checks to signed tokens.
    hybrid: new HybridTokenStrategy(store, options),
  }, { maxPayloadBytes: 4_096 });
}
const download = defineToken({
  name: "document.download", payload: z.object({ documentId: z.string() }),
  strategy: "jwt", usage: "multiple",
});
```

The definition's `strategy` selects its manager entry. Retain old verification keys for outstanding tokens during rotation; removing a key invalidates them. Signed payloads are not encrypted. Keyring setup and capability restrictions are detailed in the [composition reference](../implementation/tokens.md#composition-reference).

## Use cases still to document

- Configure signing keys, issuer and audience checks, and JWT key rotation.
- Verify and revoke reusable tokens, and consume a hybrid single-use token.
- Issue tokens in batches and replace tokens for a subject.
- Compose PostgreSQL token consumption with a domain transaction.
- Prune expired tokens and delete tokens belonging to a subject.
