import type { AuthenticationAdapterDefinition, SessionStorageAdapterDefinition } from "../../adapter_definition.js";
import type { AuthenticationAdapter, SessionStorageAdapter } from "../../stores.js";

/** Replaces only sessions while retaining scope-local account and credential ownership. */
export function withAuthenticationSessions<Claims>(
  baseDefinition: AuthenticationAdapterDefinition<Claims>,
  sessionDefinition: SessionStorageAdapterDefinition<Claims>,
): AuthenticationAdapterDefinition<Claims> {
  if (baseDefinition.initialize !== undefined || sessionDefinition.initialize !== undefined) {
    throw new TypeError("Scoped authentication adapters must be synchronously ready.");
  }
  const cleanup = new WeakMap<AuthenticationAdapter<Claims>, () => Promise<void>>();
  return Object.freeze({
    capabilities: Object.freeze({}),
    create(resolve, context) {
      let base: AuthenticationAdapter<Claims> | undefined;
      let sessions: SessionStorageAdapter<Claims> | undefined;
      // Lazy children remain owned even if construction of the other child fails.
      const getBase = () => base ??= baseDefinition.create(resolve, context);
      const getSessions = () => sessions ??= sessionDefinition.create(resolve, context);
      const adapter: AuthenticationAdapter<Claims> = {
        findById: (id) => getBase().findById(id),
        findBySubjectId: (id) => getBase().findBySubjectId(id),
        createAccount: (input) => getBase().createAccount(input),
        setState: (input) => getBase().setState(input),
        incrementSecurityVersion: (id) => getBase().incrementSecurityVersion(id),
        findByNormalizedUsername: (username) => getBase().findByNormalizedUsername(username),
        createPasswordCredential: (input) => getBase().createPasswordCredential(input),
        replaceHash: (input) => getBase().replaceHash(input),
        createSession: (input) => getSessions().createSession(input),
        findByTokenDigest: (digest) => getSessions().findByTokenDigest(digest),
        touch: (input) => getSessions().touch(input),
        revoke: (input) => getSessions().revoke(input),
        revokeAllForAccount: (input) => getSessions().revokeAllForAccount(input),
        listForAccount: (id) => getSessions().listForAccount(id),
      };
      // Deliberately omit SessionAccountResolver: the base no longer owns these sessions.
      cleanup.set(adapter, async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => sessions === undefined ? undefined : sessionDefinition.dispose?.(sessions)),
          Promise.resolve().then(() => base === undefined ? undefined : baseDefinition.dispose?.(base)),
        ]);
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "Authentication adapter cleanup failed.");
      });
      return adapter;
    },
    async dispose(adapter) {
      const dispose = cleanup.get(adapter);
      cleanup.delete(adapter);
      await dispose?.();
    },
  });
}
