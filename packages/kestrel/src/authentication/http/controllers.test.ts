import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { App } from "../../app/index.js";
import {
  defineHttpAccessPolicy,
  HttpControllerManager,
} from "../../http/index.js";
import { MemoryAuthenticationAdapter } from "../adapters/memory/index.js";
import { createAuthenticationActions } from "../actions.js";
import type { AuthenticationConfig } from "../configuration.js";
import { defineAuthentication } from "../definition.js";
import type { PasswordHasher } from "../mechanisms/password/index.js";
import { AuthenticationProvider } from "../provider.js";
import { createAuthenticationHttpControllers } from "./controllers.js";

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
    cookie: {
      name: "session",
      secure: false,
      sameSite: "lax",
      path: "/",
    },
    trustedOrigins: ["http://app.test"],
  },
};

const anonymousAccess = defineHttpAccessPolicy("test.anonymous");

const apps = new Set<App<Record<string, never>>>();
const servers = new Set<FastifyInstance>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  await Promise.all([...apps].map((app) => app.dispose()));
  apps.clear();
  servers.clear();
});

describe("authentication HTTP controllers", () => {
  it("signs in, resolves the cookie, and signs out idempotently", async () => {
    const { adapter, server } = await createHttpAuthentication();
    const account = await adapter.createAccount({ subjectId: "subject-1" });
    await adapter.createPasswordCredential({
      accountId: account.id,
      username: "TestUser",
      normalizedUsername: "testuser",
      passwordHash: "hash:correct-password",
    });

    const signIn = await server.inject({
      method: "POST",
      url: "/authentication/password/sign-in",
      headers: { origin: "http://app.test" },
      payload: {
        username: "TESTUSER",
        password: "correct-password",
      },
    });

    expect(signIn.statusCode).toBe(200);
    expect(signIn.headers["cache-control"]).toBe("no-store");
    expect(signIn.json()).toMatchObject({
      subjectId: "subject-1",
      claims: {},
      authentication: {
        methods: ["password"],
        factors: ["knowledge"],
      },
    });
    const cookie = signIn.headers["set-cookie"];
    expect(cookie).toContain("session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const current = await server.inject({
      method: "GET",
      url: "/authentication/session",
      headers: { cookie },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      authenticated: true,
      principal: { subjectId: "subject-1" },
    });

    const signOut = await server.inject({
      method: "POST",
      url: "/authentication/sign-out",
      headers: {
        cookie,
        origin: "http://app.test",
      },
    });
    expect(signOut.statusCode).toBe(204);
    expect(signOut.headers["set-cookie"]).toContain("Max-Age=0");

    const anonymous = await server.inject({
      method: "GET",
      url: "/authentication/session",
      headers: { cookie },
    });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ authenticated: false });
  });

  it("returns generic credential failures and rejects untrusted origins", async () => {
    const { server } = await createHttpAuthentication();
    const untrusted = await server.inject({
      method: "POST",
      url: "/authentication/password/sign-in",
      headers: { origin: "http://attacker.test" },
      payload: {
        username: "missing",
        password: "incorrect-password",
      },
    });
    expect(untrusted.statusCode).toBe(403);

    const rejected = await server.inject({
      method: "POST",
      url: "/authentication/password/sign-in",
      headers: { origin: "http://app.test" },
      payload: {
        username: "missing",
        password: "incorrect-password",
      },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({
      error: "Unauthorized",
      message: "The supplied credentials are invalid.",
    });
  });

  it("rejects oversized credential payloads before authentication work", async () => {
    const { server } = await createHttpAuthentication();
    const response = await server.inject({
      method: "POST",
      url: "/authentication/password/sign-in",
      headers: { origin: "http://app.test" },
      payload: {
        username: "missing",
        password: "a".repeat(9 * 1_024),
      },
    });

    expect(response.statusCode).toBe(413);
  });

  it("trusts the request's exact origin without preconfiguring its hostname", async () => {
    const { server } = await createHttpAuthentication();
    const sameOrigin = await server.inject({
      method: "POST",
      url: "/authentication/password/sign-in",
      headers: {
        host: "local-preview.test:4444",
        origin: "http://local-preview.test:4444",
      },
      payload: {
        username: "missing",
        password: "incorrect-password",
      },
    });

    // Reaching credential verification proves Origin validation succeeded.
    expect(sameOrigin.statusCode).toBe(401);

    const crossOrigin = await server.inject({
      method: "POST",
      url: "/authentication/password/sign-in",
      headers: {
        host: "local-preview.test:4444",
        origin: "http://attacker.test",
      },
      payload: {
        username: "missing",
        password: "incorrect-password",
      },
    });
    expect(crossOrigin.statusCode).toBe(403);
  });
});

async function createHttpAuthentication(): Promise<{
  adapter: MemoryAuthenticationAdapter<Record<string, never>>;
  server: FastifyInstance;
}> {
  const definition = defineAuthentication({
    sessionClaims: {
      schema: z.object({}),
      create: () => ({}),
    },
  });
  const authentication = createAuthenticationActions(definition);
  const controllers = createAuthenticationHttpControllers(
    authentication,
    config,
    anonymousAccess,
  );
  const adapter = new MemoryAuthenticationAdapter<Record<string, never>>();
  const app = new App({});
  const server = Fastify();

  app.container.registerValue("authenticationAdapter", adapter);
  app.container.registerValue("authenticationSubjectProvider", {
    findById: async (id: string) => ({ id }),
  });
  app.register(new AuthenticationProvider(
    config,
    definition,
    new TestPasswordHasher(),
  ));

  const manager = new HttpControllerManager(app, server);
  manager.register(controllers.signInWithPassword);
  manager.register(controllers.signOut);
  manager.register(controllers.getCurrentSession);
  server.addHook("onReady", async () => app.start());
  apps.add(app);
  servers.add(server);

  return { adapter, server };
}

class TestPasswordHasher implements PasswordHasher {
  public readonly id = "test";

  public async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  public async verify(password: string, encodedHash: string): Promise<boolean> {
    return encodedHash === `hash:${password}`;
  }

  public needsRehash(_encodedHash: string): boolean {
    return false;
  }

  public async getDummyHash(): Promise<string> {
    return "hash:dummy-password";
  }
}
