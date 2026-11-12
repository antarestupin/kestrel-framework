import { memoryAuthentication } from "./../index.js";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { defineAction } from "../../actions/index.js";
import { authenticationContextDependency, currentUser, optionalCurrentUser } from "../dependencies.js";
import { App } from "../../app/index.js";
import {
  defineHttpAccessPolicy,
  defineHttpController,
  defineHttpMiddleware,
  get,
  HttpControllerManager,
} from "../../http/index.js";
import { MemoryAuthenticationAdapter } from "../adapters/memory/index.js";
import { createAuthenticationActions } from "../actions.js";
import type { AuthenticationAttemptGuard } from "../attempt_guard.js";
import type { AuthenticationConfig } from "../configuration.js";
import { defineAuthentication } from "../definition.js";
import { AuthenticationRateLimitedError } from "../errors.js";
import type { PasswordHasher } from "../mechanisms/password/index.js";
import { AuthenticationProvider } from "../provider.js";
import { createAuthenticationHttpControllers, type AuthenticationHttpControllerOptions } from "./controllers.js";

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
      headers: { origin: "http://app.test", "user-agent": undefined },
      remoteAddress: "192.0.2.1",
      payload: {
        username: "TESTUSER",
        password: "correct-password",
        metadata: { ipAddress: "203.0.113.1", userAgent: "Untrusted payload" },
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
    // Session metadata comes from the request transport and cannot be supplied in the credentials.
    const [session] = await adapter.listForAccount(account.id);
    expect(session).toHaveProperty("ipAddress", "192.0.2.1");
    expect(session).not.toHaveProperty("userAgent");

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
    expect(signOut.headers["cache-control"]).toBe("no-store");
    expect(signOut.headers["set-cookie"]).toContain("Max-Age=0");

    const anonymous = await server.inject({
      method: "GET",
      url: "/authentication/session",
      headers: { cookie },
    });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ authenticated: false });

    // Retrying with a revoked cookie still clears it and succeeds anonymously.
    const repeatedSignOut = await server.inject({
      method: "POST", url: "/authentication/sign-out", headers: { cookie, origin: "http://app.test" },
    });
    expect(repeatedSignOut.statusCode).toBe(204);
    expect(repeatedSignOut.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("reuses session resolution and denies ambiguous or absent cookies before the protected handler", async () => {
    const { adapter, server, manager, middleware } = await createHttpAuthentication({
      ...config,
      http: { ...config.http, cookie: { name: "__Host-session", secure: true, sameSite: "strict", path: "/" } },
    });
    const account = await adapter.createAccount({ subjectId: "protected-subject" });
    await adapter.createPasswordCredential({
      accountId: account.id, username: "user", normalizedUsername: "user", passwordHash: "hash:correct-password",
    });
    const findSession = vi.spyOn(adapter, "findByTokenDigest");
    const onRead = vi.fn();
    manager.register(defineHttpController({
      route: get("/protected"),
      access: defineHttpAccessPolicy("test.protected", [middleware.optionalSession, middleware.requiredSession]),
      dependencies: { context: authenticationContextDependency() },
      handler: ({ deps }) => {
        onRead();
        return { subjectId: deps.context.getPrincipal()?.subjectId };
      },
    }));

    const signIn = await server.inject({
      method: "POST", url: "/authentication/password/sign-in", headers: { origin: "http://app.test" },
      payload: { username: "user", password: "correct-password" },
    });
    expect(signIn.statusCode).toBe(200);
    const setCookie = String(signIn.headers["set-cookie"]);
    expect(setCookie).toMatch(/^__Host-session=.+; .*SameSite=Strict/);
    expect(setCookie.split("; ")).toContain("Secure");
    const cookie = setCookie.split(";", 1)[0];

    // A second session middleware must use the principal already resolved for this request.
    const accepted = await server.inject({ url: "/protected", headers: { cookie } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ subjectId: "protected-subject" });
    expect(findSession).toHaveBeenCalledOnce();

    for (const headers of [{}, { cookie: "__Host-session=" }, { cookie: `${cookie}; ${cookie}` }, { cookie: "__Host-session=%zz" }]) {
      const denied = await server.inject({ url: "/protected", headers });
      expect(denied.statusCode).toBe(401);
    }
    expect(findSession).toHaveBeenCalledOnce();
    expect(onRead).toHaveBeenCalledOnce();

    const signOut = await server.inject({
      method: "POST", url: "/authentication/sign-out", headers: { origin: "http://app.test", cookie },
    });
    expect(signOut.statusCode).toBe(204);
    expect(String(signOut.headers["set-cookie"]).split("; ")).toEqual(expect.arrayContaining([
      "__Host-session=", "Max-Age=0", "SameSite=Strict", "Secure",
    ]));
  });

  it("shares a lazy user between HTTP middleware, controller and nested action, with 401 semantics", async () => {
    const { adapter, server, manager, middleware, findById } = await createHttpAuthentication();
    const account = await adapter.createAccount({ subjectId: "subject-1" });
    await adapter.createPasswordCredential({
      accountId: account.id, username: "user", normalizedUsername: "user", passwordHash: "hash:correct-password",
    });
    const userDependency = currentUser<{ id: string }>();
    const optionalUser = optionalCurrentUser<{ id: string }>();
    const action = defineAction({
      name: "test.current-user", output: z.string(), dependencies: { user: userDependency },
      handler: (_input, { user }) => user.id,
    });
    let middlewareUser: { id: string } | undefined;
    const readUser = defineHttpMiddleware("test.read-user", {
      dependencies: { user: optionalUser },
      handler: async ({ deps }, next) => { middlewareUser = deps.user; return next(); },
    });
    const access = defineHttpAccessPolicy("test.session", [middleware.optionalSession, readUser]);
    manager.register(defineHttpController({
      route: get("/me"), access, dependencies: { user: userDependency },
      handler: async ({ deps, execution }) => {
        expect(deps.user).toBe(middlewareUser);
        return { id: await execution.get(action).run(null) };
      },
    }));
    manager.register(defineHttpController({
      route: get("/optional-me"), access, dependencies: { user: optionalUser },
      handler: ({ deps }) => ({ id: deps.user?.id ?? null }),
    }));
    const signIn = await server.inject({
      method: "POST", url: "/authentication/password/sign-in", headers: { origin: "http://app.test" },
      payload: { username: "user", password: "correct-password" },
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = signIn.headers["set-cookie"];
    findById.mockClear();
    // A session-only endpoint must not eagerly fetch the application user.
    expect((await server.inject({ url: "/authentication/session", headers: { cookie } })).statusCode).toBe(200);
    expect(findById).not.toHaveBeenCalled();
    const me = await server.inject({ url: "/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ id: "subject-1" });
    expect(findById).toHaveBeenCalledExactlyOnceWith("subject-1");
    const again = await server.inject({ url: "/me", headers: { cookie } });
    expect(again.statusCode).toBe(200);
    expect(findById).toHaveBeenCalledTimes(2);
    expect((await server.inject("/me")).statusCode).toBe(401);
    expect((await server.inject("/optional-me")).json()).toEqual({ id: null });
    findById.mockResolvedValue(null);
    expect((await server.inject({ url: "/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await server.inject({ url: "/optional-me", headers: { cookie } })).json()).toEqual({ id: null });
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

  it("returns the same HTTP rejection for a wrong password and an unknown username", async () => {
    const { adapter, server } = await createHttpAuthentication();
    const account = await adapter.createAccount({ subjectId: "known-subject" });
    await adapter.createPasswordCredential({
      accountId: account.id,
      username: "KnownUser",
      normalizedUsername: "knownuser",
      passwordHash: "hash:correct-password",
    });

    const createSession = vi.spyOn(adapter, "createSession");
    const signIn = (username: string) => server.inject({
      method: "POST",
      url: "/authentication/password/sign-in",
      headers: { origin: "http://app.test" },
      payload: { username, password: "incorrect-password" },
    });

    const rejected = await signIn("KNOWNUSER");
    const unknown = await signIn("missing");

    // Account existence must not change any observable response fields except the server clock.
    expect(rejected.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(rejected.statusCode);
    expect(rejected.json()).toMatchObject({
      error: "Unauthorized",
      message: "The supplied credentials are invalid.",
    });
    expect(unknown.body).toBe(rejected.body);
    expect({ ...unknown.headers, date: undefined }).toEqual({ ...rejected.headers, date: undefined });
    expect(rejected.headers["set-cookie"]).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
    expect(await adapter.listForAccount(account.id)).toEqual([]);
  });

  it("returns a generic 429 before looking up credentials when admission is denied", async () => {
    const { adapter, server } = await createHttpAuthentication(config, undefined, {
      async run() { throw new AuthenticationRateLimitedError(); },
    });
    const findCredential = vi.spyOn(adapter, "findByNormalizedUsername");

    // Denied requests stop at the admission boundary before any password or session work.
    const response = await server.inject({
      method: "POST",
      url: "/authentication/password/sign-in",
      headers: { origin: "http://app.test" },
      payload: { username: "member", password: "password" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Too many authentication attempts.",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(findCredential).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "null",
    "ftp://app.test",
    "http://user:password@app.test",
    "http://app.test/path",
    "http://app.test/?query=value",
    "http://app.test/#fragment",
  ])("rejects an absent or malformed Origin before checking credentials (%s)", async (origin) => {
    const { adapter, server } = await createHttpAuthentication();
    const lookup = vi.spyOn(adapter, "findByNormalizedUsername");

    // These origins can never be normalized into an allowed HTTP origin.
    const response = await server.inject({
      method: "POST", url: "/authentication/password/sign-in",
      ...(origin === undefined ? {} : { headers: { origin } }),
      payload: { username: "user", password: "correct-password" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns a generic credential failure if valid proof cannot create a session", async () => {
    const { adapter, server, findById } = await createHttpAuthentication();
    const account = await adapter.createAccount({ subjectId: "removed-subject" });
    await adapter.createPasswordCredential({
      accountId: account.id, username: "user", normalizedUsername: "user", passwordHash: "hash:correct-password",
    });
    findById.mockResolvedValue(null);

    // Correct credentials for a removed subject cannot issue a session or reveal the subject's state.
    const response = await server.inject({
      method: "POST", url: "/authentication/password/sign-in", headers: { origin: "http://app.test" },
      payload: { username: "user", password: "correct-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ message: "The supplied credentials are invalid." });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(await adapter.listForAccount(account.id)).toEqual([]);
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

  it("accepts either configured client origin and rejects a different origin", async () => {
    const { server } = await createHttpAuthentication({
      ...config,
      http: { ...config.http, trustedOrigins: ["https://first.test", "https://second.test"] },
    });
    const signIn = (origin: string) => server.inject({
      method: "POST",
      url: "/authentication/password/sign-in",
      headers: { origin },
      payload: { username: "missing", password: "incorrect-password" },
    });

    // Trusted origins reach credential verification, which rejects the unknown username.
    expect((await signIn("https://first.test")).statusCode).toBe(401);
    expect((await signIn("https://second.test")).statusCode).toBe(401);
    expect((await signIn("https://other.test")).statusCode).toBe(403);
  });

  it.each(["authentication", "/authentication/"])("rejects invalid controller prefix %s", async (prefix) => {
    // Invalid mount prefixes fail at controller definition time, before registering any routes.
    await expect(createHttpAuthentication(config, { prefix })).rejects.toThrow(
      "Authentication HTTP prefix must start with one slash and omit a trailing slash.",
    );
  });
});

async function createHttpAuthentication(
  httpConfig = config,
  options?: AuthenticationHttpControllerOptions,
  attemptGuard?: AuthenticationAttemptGuard,
): Promise<{
  adapter: MemoryAuthenticationAdapter<Record<string, never>>;
  server: FastifyInstance;
  app: App<Record<string, never>>;
  manager: HttpControllerManager<Record<string, never>>;
  middleware: ReturnType<typeof createAuthenticationHttpControllers>["middleware"];
  findById: ReturnType<typeof vi.fn<(id: string) => Promise<{ id: string } | null>>>;
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
    httpConfig,
    anonymousAccess,
    options,
  );
  const adapter = new MemoryAuthenticationAdapter<Record<string, never>>();
  const app = new App({});
  const server = Fastify();

  app.container.registerValue("authenticationAdapter", adapter);
  if (attemptGuard) app.container.registerValue("authenticationAttemptGuard", attemptGuard);
  const findById = vi.fn(async (id: string): Promise<{ id: string } | null> => ({ id }));
  app.container.registerValue("authenticationSubjectProvider", { findById });
  app.register(new AuthenticationProvider(httpConfig, memoryAuthentication(adapter), definition, new TestPasswordHasher()));

  const manager = new HttpControllerManager(app, server);
  manager.register(controllers.signInWithPassword);
  manager.register(controllers.signOut);
  manager.register(controllers.getCurrentSession);
  server.addHook("onReady", async () => app.start());
  apps.add(app);
  servers.add(server);

  return { adapter, server, app, manager, middleware: controllers.middleware, findById };
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
