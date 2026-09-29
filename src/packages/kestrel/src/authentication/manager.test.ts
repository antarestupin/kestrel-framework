import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { MemoryAuthenticationAdapter } from "./adapters/memory/index.js";
import type { AuthenticationConfig } from "./configuration.js";
import { defineAuthentication } from "./definition.js";
import { AuthenticationManager } from "./manager.js";
import { createAuthenticationProof } from "./proof.js";
import type { AuthenticationSubject } from "./types.js";

const config: AuthenticationConfig = {
  session: {
    tokenBytes: 32,
    idleTtlSeconds: 60,
    absoluteTtlSeconds: 300,
    touchIntervalSeconds: 10,
    maxClaimsBytes: 1_024,
  },
  mechanisms: {
    password: {
      minLength: 12,
      maxLength: 1_024,
    },
  },
  http: {
    cookie: {
      name: "session",
      secure: false,
      sameSite: "lax",
      path: "/",
    },
    trustedOrigins: ["http://localhost"],
  },
};

interface TestSubject extends AuthenticationSubject {
  readonly role: "member";
}

describe("AuthenticationManager", () => {
  it("creates and resolves a validated opaque-token session", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let nextId = 0;
    const adapter = new MemoryAuthenticationAdapter<{ role: "member" }>({
      now: () => now,
      createId: () => `id-${++nextId}`,
    });
    const account = await adapter.createAccount({ subjectId: "subject-1" });
    const manager = createManager(adapter, () => now);
    const proof = createAuthenticationProof(account.id, {
      method: "password",
      factors: ["knowledge"],
      authenticatedAt: now,
    });

    const grant = await manager.complete(proof, {
      ipAddress: "127.0.0.1",
      userAgent: "test",
    });

    expect(grant?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant?.principal).toMatchObject({
      accountId: account.id,
      subjectId: "subject-1",
      claims: { role: "member" },
    });
    expect(await manager.resolve(grant!.token)).toEqual(grant!.principal);

    now = new Date("2026-01-01T00:00:11.000Z");
    expect(await manager.resolve(grant!.token)).toMatchObject({
      sessionId: grant!.principal.sessionId,
    });
    const [stored] = await adapter.listForAccount(account.id);
    expect(stored?.lastSeenAt).toEqual(now);
  });

  it("fails closed for expiry, revocation, and account version changes", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryAuthenticationAdapter<{ role: "member" }>({
      now: () => now,
      createId: createSequentialId(),
    });
    const account = await adapter.createAccount({ subjectId: "subject-1" });
    const manager = createManager(adapter, () => now);
    const createGrant = () => manager.complete(createAuthenticationProof(
      account.id,
      {
        method: "password",
        factors: ["knowledge"],
        authenticatedAt: now,
      },
    ));

    const versioned = await createGrant();
    await adapter.incrementSecurityVersion(account.id);
    expect(await manager.resolve(versioned!.token)).toBeUndefined();

    const refreshedAccount = await adapter.findById(account.id);
    const current = await manager.complete(createAuthenticationProof(
      refreshedAccount!.id,
      {
        method: "password",
        factors: ["knowledge"],
        authenticatedAt: now,
      },
    ));
    expect(await manager.revokeSession(current!.principal.sessionId)).toBe(true);
    expect(await manager.resolve(current!.token)).toBeUndefined();

    const expiring = await createGrant();
    now = new Date("2026-01-01T00:01:01.000Z");
    expect(await manager.resolve(expiring!.token)).toBeUndefined();
    expect(await manager.resolve("not-a-token")).toBeUndefined();
  });

  it("prefers a combined session and account resolver when available", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryAuthenticationAdapter<{ role: "member" }>({
      now: () => now,
      createId: createSequentialId(),
    });
    const account = await adapter.createAccount({ subjectId: "subject-1" });
    const combinedResolution = vi.fn(async (tokenDigest: Uint8Array) => {
      const session = await adapter.findByTokenDigest(tokenDigest);

      return session === undefined ? undefined : { session, account };
    });
    Object.assign(adapter, {
      findSessionAndAccountByTokenDigest: combinedResolution,
    });
    const manager = createManager(adapter, () => now);
    const grant = await manager.complete(createAuthenticationProof(
      account.id,
      {
        method: "password",
        factors: ["knowledge"],
        authenticatedAt: now,
      },
    ));
    const accountLookup = vi.spyOn(adapter, "findById");

    await expect(manager.resolve(grant!.token)).resolves.toEqual(
      grant!.principal,
    );
    expect(combinedResolution).toHaveBeenCalledOnce();
    expect(accountLookup).not.toHaveBeenCalled();
  });

  it("rejects proofs not created by a trusted mechanism", async () => {
    const adapter = new MemoryAuthenticationAdapter<{ role: "member" }>();
    const manager = createManager(adapter, () => new Date());

    await expect(manager.complete({
      accountId: "account-1",
      evidence: {
        method: "password",
        factors: ["knowledge"],
        authenticatedAt: new Date(),
      },
    })).rejects.toThrow("Authentication proof is not trusted.");
  });
});

function createManager(
  adapter: MemoryAuthenticationAdapter<{ role: "member" }>,
  now: () => Date,
): AuthenticationManager<{ role: "member" }, TestSubject> {
  let tokenSeed = 0;

  return new AuthenticationManager(
    {
      accountStore: adapter,
      sessionStore: adapter,
      subjectProvider: {
        findById: async (id) => ({ id, role: "member" }),
      },
    },
    config,
    defineAuthentication({
      sessionClaims: {
        schema: z.object({ role: z.literal("member") }),
        create: ({ subject }) => ({ role: subject.role }),
      },
    }),
    {
      now,
      createId: createSequentialId("session"),
      createToken: () => {
        tokenSeed += 1;
        return Uint8Array.from(
          { length: 32 },
          (_, index) => (index + tokenSeed) % 256,
        );
      },
    },
  );
}

function createSequentialId(prefix = "id"): () => string {
  let nextId = 0;
  return () => `${prefix}-${++nextId}`;
}
