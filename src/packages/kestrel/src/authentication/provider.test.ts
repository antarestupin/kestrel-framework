import { memoryAuthentication } from "./index.js";
import { z } from "zod";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { authenticationContextDependency, currentUser, optionalCurrentUser } from "./dependencies.js";
import { AuthenticationRequiredError } from "./errors.js";
import type { AuthenticatedPrincipal, AuthenticationSubject } from "./types.js";
import { App } from "../app/index.js";
import { createAuthenticationActions } from "./actions.js";
import { MemoryAuthenticationAdapter } from "./adapters/memory/index.js";
import { defineAuthentication } from "./definition.js";
import type { PasswordHasher } from "./mechanisms/password/index.js";
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
        memoryAuthentication(stores),
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
  return { container: app.container, findById };
}

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
