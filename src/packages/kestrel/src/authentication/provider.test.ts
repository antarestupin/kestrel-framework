import { memoryAuthentication } from "./index.js";
import { z } from "zod";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { defineAction } from "../actions/index.js";
import {
  authenticationAdapterDependency, authenticationContextDependency, authenticationManagerDependency,
  currentUser, optionalCurrentUser, passwordHasherDependency, passwordMechanismDependency,
} from "./dependencies.js";
import { AuthenticationRequiredError, InvalidCredentialsError } from "./errors.js";
import type { AuthenticatedPrincipal, AuthenticationSubject } from "./types.js";
import { App } from "../app/index.js";
import { createAuthenticationActions, passwordSignInHttpInputSchema } from "./actions.js";
import { MemoryAuthenticationAdapter } from "./adapters/memory/index.js";
import { AllowAuthenticationAttemptGuard, type AuthenticationAttemptGuard, type AuthenticationAttemptInput } from "./attempt_guard.js";
import { dep } from "../di/index.js";
import { defineAuthentication } from "./definition.js";
import type { PasswordHasher } from "./mechanisms/password/index.js";
import { requireAuthentication } from "./middleware.js";
import { AuthenticationProvider } from "./provider.js";
import type { AuthenticationConfig } from "./configuration.js";

const config: AuthenticationConfig = {
  session: {
    tokenBytes: 32,
    idleTtlSeconds: 60,
    absoluteTtlSeconds: 300,
    touchIntervalSeconds: 10,
    maxClaimsBytes: 1_024,
  },
  mechanisms: { password: { minLength: 12, maxLength: 100 } },
  http: {
    cookie: { name: "session", secure: false, sameSite: "lax", path: "/" },
    trustedOrigins: ["http://app.test"],
  },
};

let app: App<Record<string, never>> | undefined;

afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

describe("AuthenticationProvider", () => {
  it("accepts independently registered storage capabilities", async () => {
    const stores = new MemoryAuthenticationAdapter<Record<string, never>>();
    const disabledAccount = await stores.createAccount({
      subjectId: "pending-subject",
      state: "disabled",
    });
    const definition = defineAuthentication({
      sessionClaims: { schema: z.object({}), create: () => ({}) },
    });
    const authentication = createAuthenticationActions(definition);
    const account = await stores.createAccount({ subjectId: "subject-1" });
    expect(disabledAccount.state).toBe("disabled");
    await stores.createPasswordCredential({
      accountId: account.id,
      username: "SeparateStores",
      normalizedUsername: "separatestores",
      passwordHash: "hash:correct-password",
    });

    app = new App({});
    // No combined `authenticationAdapter` is registered here.
    app.container.registerValue("accountStore", stores);
    app.container.registerValue("sessionStore", stores);
    app.container.registerValue("passwordCredentialStore", stores);
    app.container.registerValue("authenticationSubjectProvider", {
      findById: async (id: string) => ({ id }),
    });
    app.register(
      new AuthenticationProvider(
        config,
        memoryAuthentication(new MemoryAuthenticationAdapter<Record<string, never>>()),
        definition,
        new TestPasswordHasher(),
      ),
    );

    const grant = await app.get(authentication.actions.signInWithPassword).run({
      username: "SEPARATESTORES",
      password: "correct-password",
    });

    expect(grant.principal.subjectId).toBe("subject-1");
  });

  it("keeps the configured guard and forwards partial metadata through session creation", async () => {
    const adapter = new MemoryAuthenticationAdapter<Record<string, never>>();
    const definition = defineAuthentication({
      sessionClaims: { schema: z.object({}), create: () => ({}) },
    });
    const { actions } = createAuthenticationActions(definition);
    const account = await adapter.createAccount({ subjectId: "metadata-subject" });
    await adapter.createPasswordCredential({
      accountId: account.id, username: "user", normalizedUsername: "user", passwordHash: "hash:correct-password",
    });
    const attempt = vi.fn<(input: AuthenticationAttemptInput) => void>();
    app = new App({});
    app.container.registerValue("authenticationSubjectProvider", { findById: async (id: string) => ({ id }) });
    app.container.registerValue("authenticationAttemptGuard", {
      run<Value>(input: AuthenticationAttemptInput, operation: () => Promise<Value>) {
        attempt(input);
        return operation();
      },
    });
    app.register(new AuthenticationProvider(config, memoryAuthentication(adapter), definition, new TestPasswordHasher()));

    const credentials = { username: "user", password: "correct-password" };
    const ipMetadata = { ipAddress: "192.0.2.1" };
    const agentMetadata = { userAgent: "Test browser" };
    const ipGrant = await app.get(actions.signInWithPassword).run({ ...credentials, metadata: ipMetadata });
    const agentGrant = await app.get(actions.signInWithPassword).run({ ...credentials, metadata: agentMetadata });
    const sessions = await adapter.listForAccount(account.id);
    const ipSession = sessions.find(({ id }) => id === ipGrant.principal.sessionId);
    const agentSession = sessions.find(({ id }) => id === agentGrant.principal.sessionId);

    // Each attempt and stored session keeps only the metadata supplied to that action.
    expect(attempt.mock.calls.map(([input]) => input.metadata)).toStrictEqual([ipMetadata, agentMetadata]);
    expect(ipSession).toHaveProperty("ipAddress", ipMetadata.ipAddress);
    expect(ipSession).not.toHaveProperty("userAgent");
    expect(agentSession).toHaveProperty("userAgent", agentMetadata.userAgent);
    expect(agentSession).not.toHaveProperty("ipAddress");
  });

  it("prepares the dummy credential hash only during standard boot", async () => {
    const hasher = new TestPasswordHasher();
    const prepare = vi.spyOn(hasher, "getDummyHash");
    const definition = defineAuthentication({
      sessionClaims: { schema: z.object({}), create: () => ({}) },
    });

    for (const mode of ["minimal", "standard"] as const) {
      app = new App({});
      app.prepareBootPlan([], mode);
      app.register(new AuthenticationProvider(config, memoryAuthentication(new MemoryAuthenticationAdapter()), definition, hasher));
      try {
        await app.start();
        // Minimal CLI boot does not pay the password hashing setup cost.
        expect(prepare).toHaveBeenCalledTimes(mode === "minimal" ? 0 : 1);
      } finally {
        await app.dispose();
        app = undefined;
      }
    }
  });

  it("resolves public dependencies and shares authentication services within one execution", async () => {
    const { container } = createCurrentUserApp();
    const first = container.createScope();
    const second = container.createScope();
    try {
      for (const service of [authenticationManagerDependency(), passwordMechanismDependency] as const) {
        const resolved = first.resolve(service);
        expect(first.resolve(service)).toBe(resolved);
        expect(second.resolve(service)).not.toBe(resolved);
      }
      const guard = dep<AuthenticationAttemptGuard>("authenticationAttemptGuard");
      const defaultGuard = first.resolve(guard);
      expect(defaultGuard).toBeInstanceOf(AllowAuthenticationAttemptGuard);
      expect(first.resolve(guard)).toBe(defaultGuard);
      expect(second.resolve(guard)).not.toBe(defaultGuard);
      expect(first.resolve(authenticationAdapterDependency)).toBeInstanceOf(MemoryAuthenticationAdapter);
      expect(first.resolve(passwordHasherDependency)).toBeInstanceOf(TestPasswordHasher);
      expect(first.resolve(passwordHasherDependency)).toBe(second.resolve(passwordHasherDependency));
    } finally {
      await second.dispose();
      await first.dispose();
    }
  });

  it("exposes the action descriptions and excludes transport metadata from the HTTP input schema", () => {
    const definition = defineAuthentication({ sessionClaims: { schema: z.object({}), create: () => ({}) } });
    const { actions } = createAuthenticationActions(definition);
    const credentials = { username: "member", password: "correct-password" };

    // Public HTTP schemas never advertise client-controlled session metadata.
    expect(passwordSignInHttpInputSchema.parse({ ...credentials, metadata: { ipAddress: "192.0.2.1" } }))
      .toEqual(credentials);
    expect(actions.signInWithPassword.description).toBe("Authenticate an account with a username and password.");
    expect(actions.signOut.description).toBe("Revoke the current session when one is available.");
    expect(actions.getCurrentSession.description).toBe("Return the current authenticated principal when available.");
  });

  it.each(["during verification", "after proof issuance", "during a compatible rehash"] as const)(
    "rechecks password and account state if a hash is replaced %s",
    async (timing) => {
      const adapter = new MemoryAuthenticationAdapter<Record<string, never>>();
      const account = await adapter.createAccount({ subjectId: "member" });
      const credential = await adapter.createPasswordCredential({
        accountId: account.id, username: "Member", normalizedUsername: "member", passwordHash: "hash:old-password",
      });
      const compatible = timing === "during a compatible rehash";
      const replace = async () => {
        // A password reset replaces the hash and invalidates earlier sessions as one workflow.
        expect(await adapter.replaceHash({
          id: credential.id, previousHash: credential.passwordHash,
          passwordHash: compatible ? "rehash:old-password" : "hash:new-password", changedAt: new Date(),
        })).toBe(true);
        if (!compatible) await adapter.incrementSecurityVersion(account.id);
      };
      const hasher = new TestPasswordHasher();
      const verify = vi.spyOn(hasher, "verify").mockImplementation(async (password, encoded) =>
        encoded === `hash:${password}` || encoded === `rehash:${password}`);
      if (timing !== "after proof issuance") {
        verify.mockImplementationOnce(async (password, encoded) => {
          await replace();
          return encoded === `hash:${password}`;
        });
      }
      let firstAttempt = true;
      const guard: AuthenticationAttemptGuard = {
        async run<Value>(_input: AuthenticationAttemptInput, operation: () => Promise<Value>) {
          const result = await operation();
          if (timing === "after proof issuance" && firstAttempt) await replace();
          firstAttempt = false;
          return result;
        },
      };
      const definition = defineAuthentication({
        sessionClaims: { schema: z.object({}), create: () => ({}) },
      });
      const { actions } = createAuthenticationActions(definition);
      app = new App({});
      app.container.registerValue("authenticationAttemptGuard", guard);
      app.container.registerValue("authenticationSubjectProvider", { findById: async (id: string) => ({ id }) });
      app.register(new AuthenticationProvider(config, memoryAuthentication(adapter), definition, hasher));
      const signIn = (password: string) => app!.get(actions.signInWithPassword).run({ username: "member", password });

      if (compatible) {
        await expect(signIn("old-password")).resolves.toMatchObject({ principal: { accountId: account.id } });
        expect(verify.mock.calls).toEqual([
          ["old-password", "hash:old-password"], ["old-password", "rehash:old-password"],
        ]);
      } else {
        await expect(signIn("old-password")).rejects.toBeInstanceOf(InvalidCredentialsError);
        await expect(adapter.listForAccount(account.id)).resolves.toEqual([]);
        await expect(signIn("new-password")).resolves.toMatchObject({ principal: { accountId: account.id } });
        expect(await adapter.listForAccount(account.id)).toMatchObject([{ accountSecurityVersion: account.securityVersion + 1 }]);
      }
    },
  );
});

// The provider resolves application users rather than adding them to principals.
interface User extends AuthenticationSubject { readonly name: string }
const principal: AuthenticatedPrincipal<Record<string, never>> = {
  subjectId: "subject-1", accountId: "account-1", sessionId: "session-1", claims: {},
  authentication: { methods: ["password"], factors: ["knowledge"], authenticatedAt: new Date("2026-01-01") },
};

function createCurrentUserApp(findById = vi.fn(async (id: string): Promise<User | null> => ({ id, name: "Ada" }))) {
  app = new App({});
  app.container.registerValue("authenticationSubjectProvider", { findById });
  app.register(new AuthenticationProvider(config, memoryAuthentication(new MemoryAuthenticationAdapter()), defineAuthentication({
    sessionClaims: { schema: z.object({}), create: () => ({}) },
  }), new TestPasswordHasher()));
  return { app, container: app.container, findById };
}

it("protects actions invoked outside HTTP using the execution principal", async () => {
  const { app } = createCurrentUserApp();
  const handler = vi.fn(() => "protected result");
  const protectedAction = defineAction({
    name: "test.authentication.protected",
    input: z.null(),
    output: z.string(),
    middleware: [requireAuthentication],
    handler,
  });
  const execute = defineAction({
    name: "test.authentication.execute",
    input: z.boolean(),
    output: z.string(),
    dependencies: { context: authenticationContextDependency(), protectedAction },
    handler: (authenticated, { context, protectedAction }) => {
      // Resolve the parent execution's principal before invoking the nested action.
      if (authenticated) context.resolveAuthenticated(principal);
      else context.resolveAnonymous();
      return protectedAction.run(null);
    },
  });

  await expect(app.get(execute).run(false)).rejects.toBeInstanceOf(AuthenticationRequiredError);
  expect(handler).not.toHaveBeenCalled();
  await expect(app.get(execute).run(true)).resolves.toBe("protected result");
  expect(handler).toHaveBeenCalledOnce();
});

describe("current user dependencies", () => {
  it("loads lazily, shares both variants concurrently, and isolates executions", async () => {
    const { container, findById } = createCurrentUserApp();
    const first = container.createScope();
    const second = container.createScope();
    try {
      first.resolve(authenticationContextDependency()).resolveAuthenticated(principal);
      second.resolve(authenticationContextDependency()).resolveAuthenticated({ ...principal, subjectId: "subject-2" });
      expect(findById).not.toHaveBeenCalled();
      const [required, optional] = await Promise.all([
        first.resolveAsync(currentUser<User>()), first.resolveAsync(optionalCurrentUser<User>()),
      ]);
      expectTypeOf(required).toEqualTypeOf<User>();
      expectTypeOf(optional).toEqualTypeOf<User | undefined>();
      expect(required).toBe(optional);
      expect(required).toEqual({ id: "subject-1", name: "Ada" });
      expect(findById).toHaveBeenCalledExactlyOnceWith("subject-1");
      expect(await second.resolveAsync(currentUser<User>())).toEqual({ id: "subject-2", name: "Ada" });
      expect(findById).toHaveBeenCalledTimes(2);
    } finally {
      await second.dispose();
      await first.dispose();
    }
  });

  it("returns undefined for anonymous executions and rejects required access without a lookup", async () => {
    const { container, findById } = createCurrentUserApp();
    container.resolve(authenticationContextDependency()).resolveAnonymous();
    expect(await container.resolveAsync(optionalCurrentUser<User>())).toBeUndefined();
    await expect(container.resolveAsync(currentUser<User>())).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(findById).not.toHaveBeenCalled();
  });

  it("rejects pending authentication explicitly for both variants", async () => {
    const { container, findById } = createCurrentUserApp();
    await expect(container.resolveAsync(optionalCurrentUser<User>())).rejects.toThrow(/Authentication context is pending/);
    await expect(container.resolveAsync(currentUser<User>())).rejects.toThrow(/Authentication context is pending/);
    expect(findById).not.toHaveBeenCalled();
  });

  it("fails closed when the subject no longer exists", async () => {
    const findById = vi.fn(async (): Promise<User | null> => null);
    const { container } = createCurrentUserApp(findById);
    container.resolve(authenticationContextDependency()).resolveAuthenticated(principal);
    expect(await container.resolveAsync(optionalCurrentUser<User>())).toBeUndefined();
    await expect(container.resolveAsync(currentUser<User>())).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(findById).toHaveBeenCalledOnce();
  });

  it("propagates and shares lookup failures without converting them to anonymous access", async () => {
    const failure = new Error("Database unavailable");
    const findById = vi.fn(async (): Promise<User | null> => { throw failure; });
    const { container } = createCurrentUserApp(findById);
    container.resolve(authenticationContextDependency()).resolveAuthenticated(principal);
    await expect(container.resolveAsync(optionalCurrentUser<User>())).rejects.toBe(failure);
    await expect(container.resolveAsync(currentUser<User>())).rejects.toBe(failure);
    expect(findById).toHaveBeenCalledOnce();
  });

  it("caches a required-user rejection in the same execution", async () => {
    const findById = vi.fn(async (): Promise<User | null> => null);
    const { container } = createCurrentUserApp(findById);
    container.resolve(authenticationContextDependency()).resolveAuthenticated(principal);
    const failure = await container.resolveAsync(currentUser<User>()).catch((error: unknown) => error);

    // Both the absence and the required-user failure are part of the scoped lookup result.
    expect(failure).toBeInstanceOf(AuthenticationRequiredError);
    await expect(container.resolveAsync(currentUser<User>())).rejects.toBe(failure);
    expect(findById).toHaveBeenCalledOnce();
  });

  it.each([currentUser<User>(), optionalCurrentUser<User>()])("rejects a singleton async consumer of $id", async (user) => {
    const { container, findById } = createCurrentUserApp();
    container.resolve(authenticationContextDependency()).resolveAuthenticated(principal);
    container.registerAsyncFactory("invalidSingletonUser", { user }, ({ user: captured }) => captured, { lifetime: "singleton" });

    // A long-lived consumer must never capture the first execution's user or authentication state.
    await expect(container.resolveAsync(dep("invalidSingletonUser")))
      .rejects.toThrow(`Dependency "${user.id}" has a shorter lifetime than its async factory ancestor.`);
    expect(findById).not.toHaveBeenCalled();
  });
});

class TestPasswordHasher implements PasswordHasher {
  public readonly id = "test";

  public async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  public async verify(password: string, hash: string): Promise<boolean> {
    return hash === `hash:${password}`;
  }

  public needsRehash(_hash: string): boolean {
    return false;
  }

  public async getDummyHash(): Promise<string> {
    return "hash:dummy";
  }
}
