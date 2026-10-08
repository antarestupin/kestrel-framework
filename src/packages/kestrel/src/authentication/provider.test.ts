import { memoryAuthentication } from "./index.js";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

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
