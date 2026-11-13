import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { createRedisTestContext, type RedisTestContext } from "../../../testing/redis.js";
import { MemoryAuthenticationAdapter } from "../memory/adapter.js";
import { memoryAuthentication } from "../memory/definition.js";
import { AuthenticationManager } from "../../manager.js";
import { authenticationConfigBase } from "../../configuration.js";
import { defineAuthentication } from "../../definition.js";
import { withAuthenticationSessions } from "../composed/definition.js";
import { redisSessions } from "./definition.js";
import { dep } from "../../../di/index.js";
import { z } from "zod";
import type { StoredSession } from "../../stores.js";
import { RedisSessionStorageAdapter } from "./adapter.js";
import { redisSessionsConfigBase } from "./configuration.js";
import { sessionScript } from "./scripts.js";
import { App } from "../../../app/index.js";
import { defineHttpAccessPolicy, HttpControllerManager } from "../../../http/index.js";
import { AuthenticationProvider } from "../../provider.js";
import { createAuthenticationActions } from "../../actions.js";
import { createAuthenticationHttpControllers } from "../../http/controllers.js";

const it = test.extend<{ redis: RedisTestContext }>({
  redis: async ({}, use) => {
    const redis = await createRedisTestContext();
    try { await use(redis); } finally { await redis.dispose(); }
  },
});
type Claims = { roles: string[]; precise: number };
function session(id = "one", overrides: Partial<StoredSession<Claims>> = {}): StoredSession<Claims> {
  const now = Date.now();
  return {
    id, accountId: "account", tokenDigest: new Uint8Array(Buffer.from(id)), claims: { roles: [], precise: 1.2345678901234567 },
    accountSecurityVersion: 1, evidence: { method: "password", factors: [], authenticatedAt: new Date(now) },
    createdAt: new Date(now), lastSeenAt: new Date(now), idleExpiresAt: new Date(now + 30_000), absoluteExpiresAt: new Date(now + 60_000),
    ...overrides,
  };
}

describe("RedisSessionStorageAdapter", () => {
  it("shares sessions across clients and preserves JSON and native deadlines", async ({ redis }) => {
    const other = await createRedisTestContext();
    try {
      const first = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
      const second = new RedisSessionStorageAdapter<Claims>(other.client, { keyPrefix: redis.keyPrefix });
      const stored = session();
      await expect(first.createSession(stored)).resolves.toStrictEqual(stored);
      await expect(second.findByTokenDigest(stored.tokenDigest)).resolves.toStrictEqual(stored);
      for (const [name, field] of [["records", stored.id], ["digests", Buffer.from(stored.tokenDigest).toString("base64url")], ["accounts", stored.accountId]]) {
        expect(await redis.client.sendCommand(["HPEXPIRETIME", `${redis.keyPrefix}{sessions}:${name}`, "FIELDS", "1", field!])).toEqual([stored.absoluteExpiresAt.getTime()]);
      }
    } finally { await other.dispose(); }
  });

  it("rejects duplicate identities without replacing existing sessions", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = session();
    await adapter.createSession(stored);
    await expect(adapter.createSession(session("two", { tokenDigest: stored.tokenDigest }))).rejects.toThrow("unique");
    await expect(adapter.createSession(session("one", { tokenDigest: Buffer.from("different") }))).rejects.toThrow("unique");
    await expect(adapter.findByTokenDigest(stored.tokenDigest)).resolves.toEqual(stored);
  });

  it("rejects a corrupted digest index before returning another account's session", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = await adapter.createSession(session());
    const unrelated = await adapter.createSession(session("other", { accountId: "other-account" }));

    // Simulate an index left inconsistent by an external restore.
    const indexKey = `${redis.keyPrefix}{sessions}:digests`;
    const digest = Buffer.from(stored.tokenDigest).toString("base64url");
    await redis.client.hSet(indexKey, digest, unrelated.id);
    await expect(adapter.findByTokenDigest(stored.tokenDigest))
      .rejects.toThrow("Redis returned a different session digest");
    await expect(adapter.findByTokenDigest(unrelated.tokenDigest)).resolves.toEqual(unrelated);
  });

  it("retains imported revocation and client metadata without renewing the session", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const input = session("imported", {
      // Use a value beyond Lua JSON's numeric precision to exercise string encoding.
      revokedAt: new Date(8_000_000_000_000_123),
      revokeReason: "security",
      ipAddress: "192.0.2.10",
      userAgent: "Kestrel test client",
    });
    await expect(adapter.createSession(input)).resolves.toEqual(input);
    await expect(adapter.touch({
      id: input.id,
      now: input.lastSeenAt,
      lastSeenAt: input.lastSeenAt,
      idleExpiresAt: input.absoluteExpiresAt,
    })).resolves.toBeUndefined();
    await expect(adapter.listForAccount(input.accountId)).resolves.toEqual([input]);
  });

  it("rejects an unknown script operation without revoking the account's sessions", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = await adapter.createSession(session());
    const keys = ["records", "digests", "accounts"].map((name) => `${redis.keyPrefix}{sessions}:${name}`);

    await expect(redis.client.eval(sessionScript, {
      keys,
      arguments: ["unknown", JSON.stringify({
        accountId: stored.accountId, revokedAt: Date.now(), reason: "unsupported-command",
      })],
    })).rejects.toThrow("Invalid Redis session operation");
    await expect(adapter.findByTokenDigest(stored.tokenDigest)).resolves.toEqual(stored);
  });

  it("rejects invalid key prefixes, digests and deadline ordering before reaching Redis", async () => {
    const client = { eval: vi.fn() };
    const adapter = new RedisSessionStorageAdapter<Claims>(client);
    const stored = session();

    expect(() => new RedisSessionStorageAdapter(client, { keyPrefix: "" }))
      .toThrow("Redis session key prefixes cannot be empty");
    await expect(adapter.findByTokenDigest(new Uint8Array()))
      .rejects.toThrow("Session digests cannot be empty");
    await expect(adapter.createSession({ ...stored, absoluteExpiresAt: stored.createdAt }))
      .rejects.toThrow("Idle expiration cannot exceed absolute expiration");
    expect(client.eval).not.toHaveBeenCalled();
    const keyPrefix = "application:authentication:";
    expect(redisSessionsConfigBase.schema.parse({ keyPrefix })).toEqual({ keyPrefix });
  });

  it("allows idle and absolute deadlines to coincide", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = session();
    const input = { ...stored, idleExpiresAt: stored.absoluteExpiresAt };
    await expect(adapter.createSession(input)).resolves.toStrictEqual(input);
  });

  it("distinguishes malformed Redis responses from a missing session or successful revocation", async () => {
    const client = { eval: vi.fn().mockResolvedValue(2) };
    const adapter = new RedisSessionStorageAdapter<Claims>(client);
    const stored = session();

    await expect(adapter.findByTokenDigest(stored.tokenDigest))
      .rejects.toThrow("Invalid Redis session result");
    await expect(adapter.listForAccount(stored.accountId))
      .rejects.toThrow("Invalid Redis session list result");
    await expect(adapter.revoke({ id: stored.id, revokedAt: stored.createdAt, reason: "logout" }))
      .rejects.toThrow("Invalid Redis session revocation result");
    client.eval.mockResolvedValue(-1);
    await expect(adapter.revokeAllForAccount({ accountId: stored.accountId, revokedAt: stored.createdAt, reason: "logout" }))
      .rejects.toThrow();
  });

  it.each([" 1", "1 ", "0x10", "1e2"])("rejects a non-decimal stored timestamp %j", async (createdAt) => {
    const stored = session();
    const client = { eval: vi.fn().mockResolvedValue(JSON.stringify({
      ...stored,
      version: 1,
      digest: Buffer.from(stored.tokenDigest).toString("base64url"),
      claims: JSON.stringify(stored.claims),
      evidence: JSON.stringify({ ...stored.evidence, authenticatedAt: stored.createdAt.getTime() }),
      createdAt,
      lastSeenAt: stored.lastSeenAt.getTime(),
      idleExpiresAt: stored.idleExpiresAt.getTime(),
      absoluteExpiresAt: stored.absoluteExpiresAt.getTime(),
    })) };
    const adapter = new RedisSessionStorageAdapter<Claims>(client);

    // Number() accepts whitespace, hex and exponents. The persisted format requires decimal integers.
    await expect(adapter.findByTokenDigest(stored.tokenDigest)).rejects.toMatchObject({ issues: expect.any(Array) });
  });

  it("extends activity monotonically and never exceeds absolute expiration", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = session();
    await adapter.createSession(stored);
    const later = new Date(stored.lastSeenAt.getTime() + 1_000);
    const updated = await adapter.touch({ id: stored.id, now: later, lastSeenAt: later, idleExpiresAt: new Date(stored.absoluteExpiresAt.getTime() + 1_000) });
    expect(updated!.idleExpiresAt).toEqual(stored.absoluteExpiresAt);
    const older = await adapter.touch({ id: stored.id, now: stored.lastSeenAt, lastSeenAt: stored.lastSeenAt, idleExpiresAt: stored.idleExpiresAt });
    expect(older!.lastSeenAt).toEqual(later);
    expect(older!.idleExpiresAt).toEqual(stored.absoluteExpiresAt);
  });

  it("never revives idle-expired or revoked sessions", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = session();
    await adapter.createSession(stored);
    await expect(adapter.touch({ id: stored.id, now: stored.idleExpiresAt, lastSeenAt: stored.idleExpiresAt, idleExpiresAt: stored.absoluteExpiresAt })).resolves.toBeUndefined();
    await expect(adapter.revoke({ id: stored.id, revokedAt: new Date(), reason: "logout" })).resolves.toBe(true);
    await expect(adapter.revoke({ id: stored.id, revokedAt: new Date(), reason: "again" })).resolves.toBe(false);
    await expect(adapter.touch({ id: stored.id, now: new Date(), lastSeenAt: new Date(), idleExpiresAt: stored.absoluteExpiresAt })).resolves.toBeUndefined();
    expect((await adapter.findByTokenDigest(stored.tokenDigest))!.revokeReason).toBe("logout");
  });

  it("retains revocations under concurrent touch requests", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = session();
    await adapter.createSession(stored);
    await Promise.all([
      adapter.revoke({ id: stored.id, revokedAt: new Date(), reason: "logout" }),
      ...Array.from({ length: 10 }, () => adapter.touch({ id: stored.id, now: new Date(), lastSeenAt: new Date(), idleExpiresAt: stored.absoluteExpiresAt })),
    ]);
    expect((await adapter.findByTokenDigest(stored.tokenDigest))!.revokedAt).toBeInstanceOf(Date);
  });

  it("lists and revokes all sessions for only the selected account", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const first = session(), second = session("two", { createdAt: new Date(Date.now() + 1) });
    const other = session("other", { accountId: "other-account" });
    await Promise.all([first, second, other].map((stored) => adapter.createSession(stored)));
    expect((await adapter.listForAccount("account")).map(({ id }) => id)).toEqual(["two", "one"]);
    await expect(adapter.revokeAllForAccount({ accountId: "account", revokedAt: new Date(), reason: "security" })).resolves.toBe(2);
    await expect(adapter.revokeAllForAccount({ accountId: "account", revokedAt: new Date(), reason: "again" })).resolves.toBe(0);
    expect((await adapter.findByTokenDigest(other.tokenDigest))!.revokedAt).toBeUndefined();
    await expect(adapter.listForAccount("missing")).resolves.toEqual([]);
  });

  it("expires records and both indexes without a pruning operation", async ({ redis }) => {
    const adapter = new RedisSessionStorageAdapter<Claims>(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = session();
    await adapter.createSession(stored);
    for (const [name, field] of [["records", stored.id], ["digests", Buffer.from(stored.tokenDigest).toString("base64url")], ["accounts", stored.accountId]]) {
      await redis.client.sendCommand(["HPEXPIRE", `${redis.keyPrefix}{sessions}:${name}`, "1", "FIELDS", "1", field!]);
    }
    await expect.poll(() => adapter.findByTokenDigest(stored.tokenDigest)).toBeUndefined();
    await expect(adapter.listForAccount(stored.accountId)).resolves.toEqual([]);
    expect("prune" in adapter).toBe(false);
  });

  it("validates account security state when sessions use Redis", async ({ redis }) => {
    const base = new MemoryAuthenticationAdapter<Claims>();
    const account = await base.createAccount({ subjectId: "user" });
    const connection = dep<typeof redis.client>("redis");
    const recipe = withAuthenticationSessions(memoryAuthentication(base), redisSessions<Claims>(connection, { keyPrefix: redis.keyPrefix }));
    const adapter = recipe.create((descriptor) => {
      if (descriptor.id !== "redis") throw new Error("Unexpected dependency.");
      return redis.client as never;
    }, undefined);
    try {
      expect("findSessionAndAccountByTokenDigest" in adapter).toBe(false);
      const definition = defineAuthentication({ sessionClaims: { schema: z.object({ roles: z.array(z.string()), precise: z.number() }), create: () => ({ roles: [], precise: 1 }) } });
      const manager = new AuthenticationManager({ accountStore: adapter, sessionStore: adapter, subjectProvider: { findById: async (id: string) => ({ id }) } }, authenticationConfigBase.schema.parse({ session: {}, mechanisms: { password: {} }, http: { cookie: {}, trustedOrigins: ["https://example.test"] } }), definition);
      const bearer = Buffer.alloc(32, 1).toString("base64url");
      const stored = session("security", { accountId: account.id, accountSecurityVersion: account.securityVersion, tokenDigest: createHash("sha256").update(bearer).digest() });
      await adapter.createSession(stored);
      expect(await manager.resolve(bearer)).toBeDefined();
      await base.incrementSecurityVersion(account.id);
      expect(await manager.resolve(bearer)).toBeUndefined();
    } finally { await recipe.dispose?.(adapter); }
  });

  it("signs in and revokes Redis sessions through Fastify injection", async ({ redis }) => {
    const base = new MemoryAuthenticationAdapter<Record<string, never>>();
    const account = await base.createAccount({ subjectId: "user" });
    await base.createPasswordCredential({ accountId: account.id, username: "user", normalizedUsername: "user", passwordHash: "hash:correct-password" });
    const config = authenticationConfigBase.schema.parse({
      session: {}, mechanisms: { password: {} },
      http: { cookie: { name: "session", secure: false }, trustedOrigins: ["http://app.test"] },
    });
    const definition = defineAuthentication({ sessionClaims: { schema: z.object({}), create: () => ({}) } });
    const actions = createAuthenticationActions(definition);
    const controllers = createAuthenticationHttpControllers(actions, config, defineHttpAccessPolicy("redis.anonymous"));
    const connection = dep<typeof redis.client>("redis");
    const app = new App({});
    const server = Fastify();
    app.container.registerValue(connection.id, redis.client);
    app.container.registerValue("authenticationSubjectProvider", { findById: async (id: string) => ({ id }) });
    app.register(new AuthenticationProvider(config,
      withAuthenticationSessions(memoryAuthentication(base), redisSessions<Record<string, never>>(connection, { keyPrefix: redis.keyPrefix })),
      definition, {
        id: "test", hash: async (value: string) => `hash:${value}`,
        verify: async (value: string, encoded: string) => encoded === `hash:${value}`,
        needsRehash: () => false, getDummyHash: async () => "hash:dummy-password",
      },
    ));
    const manager = new HttpControllerManager(app, server);
    manager.register(controllers.signInWithPassword);
    manager.register(controllers.getCurrentSession);
    manager.register(controllers.signOut);
    server.addHook("onReady", async () => app.start());
    try {
      const signIn = await server.inject({ method: "POST", url: "/authentication/password/sign-in", headers: { origin: "http://app.test" }, payload: { username: "user", password: "correct-password" } });
      expect(signIn.statusCode).toBe(200);
      const cookie = signIn.headers["set-cookie"];
      expect(cookie).toContain("HttpOnly");
      expect((await server.inject({ url: "/authentication/session", headers: { cookie } })).json()).toMatchObject({ authenticated: true });
      expect(await redis.client.hLen(`${redis.keyPrefix}{sessions}:records`)).toBe(1);
      expect(await base.listForAccount(account.id)).toEqual([]);
      const signOut = await server.inject({ method: "POST", url: "/authentication/sign-out", headers: { cookie, origin: "http://app.test" } });
      expect(signOut.statusCode).toBe(204);
      expect((await server.inject({ url: "/authentication/session", headers: { cookie } })).json()).toEqual({ authenticated: false });
    } finally { await server.close(); await app.dispose(); }
  });
});
