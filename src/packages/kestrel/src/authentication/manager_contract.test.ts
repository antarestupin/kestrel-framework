import { createHash } from "node:crypto";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { MemoryAuthenticationAdapter } from "./adapters/memory/index.js";
import type { AuthenticationConfig } from "./configuration.js";
import { defineAuthentication } from "./definition.js";
import { AuthenticationManager } from "./manager.js";
import { createAuthenticationProof } from "./proof.js";

const epoch = new Date("2026-01-01T00:00:00.000Z");
const config: AuthenticationConfig = {
  session: { tokenBytes: 32, idleTtlSeconds: 60, absoluteTtlSeconds: 300, touchIntervalSeconds: 10, maxClaimsBytes: 1_024 },
  mechanisms: { password: { minLength: 12, maxLength: 1_024 } },
  http: { cookie: { name: "session", secure: false, sameSite: "lax", path: "/" }, trustedOrigins: ["https://app.test"] },
};
type Claims = { label: string };

/** Use real process-local stores and a fixed clock so filtered mutant reruns stay deterministic. */
async function setup(options: { combined?: boolean; maxClaimsBytes?: number; absoluteTtlSeconds?: number } = {}) {
  let now = epoch;
  let sequence = 0;
  let tokenSeed = 0;
  const adapter = new MemoryAuthenticationAdapter<Claims>({ now: () => now, createId: () => `id-${++sequence}` });
  const account = await adapter.createAccount({ subjectId: "subject-1" });
  const subjectProvider = { findById: vi.fn(async (id: string): Promise<{ id: string } | null> => ({ id })) };
  const createClaims = vi.fn<() => Claims | Promise<Claims>>(() => ({ label: "member" }));
  const combined = vi.fn(async (digest: Uint8Array) => {
    const session = await adapter.findByTokenDigest(digest);
    const current = session === undefined ? undefined : await adapter.findById(session.accountId);
    return session === undefined || current === undefined ? undefined : { session, account: current };
  });
  if (options.combined) Object.assign(adapter, { findSessionAndAccountByTokenDigest: combined });
  const manager = new AuthenticationManager({ accountStore: adapter, sessionStore: adapter, subjectProvider }, {
    ...config,
    session: {
      ...config.session,
      maxClaimsBytes: options.maxClaimsBytes ?? config.session.maxClaimsBytes,
      absoluteTtlSeconds: options.absoluteTtlSeconds ?? config.session.absoluteTtlSeconds,
    },
  }, defineAuthentication({ sessionClaims: { schema: z.object({ label: z.string() }), create: createClaims } }), {
    now: () => now,
    createId: () => `session-${++sequence}`,
    createToken: (bytes) => Buffer.alloc(bytes, ++tokenSeed),
  });
  const proof = (accountId = account.id) => createAuthenticationProof(accountId, {
    method: "password", factors: ["knowledge"], authenticatedAt: epoch,
  });
  return { adapter, account, manager, proof, combined, subjectProvider, createClaims, advance: (milliseconds: number) => { now = new Date(epoch.getTime() + milliseconds); } };
}

describe("AuthenticationManager account and session contracts", () => {
  it("rechecks account state after trusted proof creation without writing a session", async () => {
    const { adapter, account, manager, proof, createClaims } = await setup();
    const trusted = proof();
    await adapter.setState({ accountId: account.id, state: "disabled" });
    const write = vi.spyOn(adapter, "createSession");
    expect(await manager.complete(trusted)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(createClaims).not.toHaveBeenCalled();
    expect(await adapter.listForAccount(account.id)).toEqual([]);
  });

  it("refuses a trusted proof whose account no longer exists", async () => {
    const { adapter, manager, proof, subjectProvider } = await setup();
    const write = vi.spyOn(adapter, "createSession");
    expect(await manager.complete(proof("missing-account"))).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(subjectProvider.findById).not.toHaveBeenCalled();
  });

  it("refuses a proof when its application subject has disappeared", async () => {
    const { adapter, manager, proof, subjectProvider } = await setup();
    subjectProvider.findById.mockResolvedValue(null);
    const write = vi.spyOn(adapter, "createSession");
    expect(await manager.complete(proof())).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it("revokes a newly persisted session if account security changes while producing claims", async () => {
    const { adapter, account, manager, proof, createClaims } = await setup();
    createClaims.mockImplementationOnce(async () => {
      // A password reset can commit while application claim creation is awaiting data.
      await adapter.incrementSecurityVersion(account.id);
      return { label: "member" };
    });

    await expect(manager.complete(proof())).resolves.toBeUndefined();
    expect(await adapter.listForAccount(account.id)).toMatchObject([{
      accountSecurityVersion: account.securityVersion, revokedAt: epoch, revokeReason: "account-changed",
    }]);
  });

  it.each(["disabled", "missing"] as const)(
    "refuses a stored grant when the final account read reports the account %s",
    async (state) => {
      const { adapter, account, manager, proof } = await setup();
      const createSession = adapter.createSession.bind(adapter);
      const findAccount = vi.spyOn(adapter, "findById");
      vi.spyOn(adapter, "createSession").mockImplementationOnce(async (input) => {
        const stored = await createSession(input);
        // Separate stores may see a state change while persisting the new session.
        findAccount.mockResolvedValue(state === "disabled" ? { ...account, state } : undefined);
        return stored;
      });

      await expect(manager.complete(proof())).resolves.toBeUndefined();
      expect(await adapter.listForAccount(account.id)).toMatchObject([{
        accountSecurityVersion: account.securityVersion, revokedAt: epoch, revokeReason: "account-changed",
      }]);
    },
  );

  it("propagates an account recheck or stale-session revocation failure without granting access", async () => {
    const { adapter, account, manager, proof } = await setup();
    const failure = new Error("Storage unavailable");
    const findAccount = vi.spyOn(adapter, "findById")
      .mockResolvedValueOnce(account)
      .mockRejectedValueOnce(failure);
    await expect(manager.complete(proof())).rejects.toBe(failure);

    findAccount.mockResolvedValueOnce(account).mockResolvedValueOnce(undefined);
    vi.spyOn(adapter, "revoke").mockRejectedValueOnce(failure);
    await expect(manager.complete(proof())).rejects.toBe(failure);
  });

  it("uses proof-bound account and claims when attempt metadata has unrelated keys", async () => {
    const { adapter, account, manager, proof } = await setup();
    const other = await adapter.createAccount({ subjectId: "other-subject" });
    const metadata = {
      ipAddress: "203.0.113.10",
      accountId: other.id,
      accountSecurityVersion: 99,
      claims: { label: "administrator" },
      tokenDigest: new Uint8Array(32),
    };

    const grant = (await manager.complete(proof(), metadata))!;
    expect(grant.principal).toMatchObject({ accountId: account.id, claims: { label: "member" } });
    await expect(manager.resolve(grant.token)).resolves.toEqual(grant.principal);
    expect((await adapter.listForAccount(account.id))[0])
      .toMatchObject({ ipAddress: metadata.ipAddress, accountSecurityVersion: account.securityVersion });
    await expect(adapter.listForAccount(other.id)).resolves.toEqual([]);
  });

  it("returns only validated claims even when resolving a session that needs a touch", async () => {
    const { adapter, manager, proof, advance } = await setup();
    const grant = (await manager.complete(proof()))!;
    const stored = (await adapter.listForAccount(grant.principal.accountId))[0]!;
    const token = Buffer.alloc(32, 88).toString("base64url");
    const persistedClaims = { label: "member", legacyAdministrator: true };
    // A claim removed from the schema can still be present in the persisted snapshot.
    await adapter.createSession({
      ...stored, id: "legacy-session", tokenDigest: createHash("sha256").update(token).digest(), claims: persistedClaims,
    });

    const touch = vi.spyOn(adapter, "touch");
    expect((await manager.resolve(token))?.claims).toEqual({ label: "member" });
    expect(touch).not.toHaveBeenCalled();
    advance(11_000);
    expect((await manager.resolve(token))?.claims).toEqual({ label: "member" });
    expect(touch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "legacy-session" }));
  });

  for (const combined of [false, true]) {
    describe(combined ? "combined account/session lookup" : "separate account/session lookups", () => {
      it("refuses an existing session after its account is disabled", async () => {
        const { adapter, account, manager, proof, advance } = await setup({ combined });
        const grant = (await manager.complete(proof()))!;
        // Independently supplied account stores may expose disabled state before a version changes.
        vi.spyOn(adapter, "findById").mockResolvedValue({ ...account, state: "disabled" });
        advance(11_000);
        const touch = vi.spyOn(adapter, "touch");
        expect(await manager.resolve(grant.token)).toBeUndefined();
        expect(touch).not.toHaveBeenCalled();
        expect((await adapter.listForAccount(account.id))[0]?.revokedAt).toBeUndefined();
      });

      it("does not revive old sessions after a disabled account is re-enabled", async () => {
        const { adapter, account, manager, proof } = await setup({ combined });
        const old = (await manager.complete(proof()))!;
        await adapter.setState({ accountId: account.id, state: "disabled" });
        await adapter.setState({ accountId: account.id, state: "active" });
        const fresh = (await manager.complete(proof()))!;

        await expect(manager.resolve(old.token)).resolves.toBeUndefined();
        await expect(manager.resolve(fresh.token)).resolves.toEqual(fresh.principal);
      });

      it("refuses an existing session after its account security version changes", async () => {
        const { adapter, account, manager, proof } = await setup({ combined });
        const grant = (await manager.complete(proof()))!;
        await adapter.incrementSecurityVersion(account.id);
        expect(await manager.resolve(grant.token)).toBeUndefined();
      });

      it("returns anonymous access for an unknown canonical token", async () => {
        const { manager } = await setup({ combined });
        expect(await manager.resolve(Buffer.alloc(32, 99).toString("base64url"))).toBeUndefined();
      });
    });
  }

  it("refuses a session whose separately stored account is missing", async () => {
    const { adapter, manager, proof } = await setup();
    const grant = (await manager.complete(proof()))!;
    vi.spyOn(adapter, "findById").mockResolvedValue(undefined);
    expect(await manager.resolve(grant.token)).toBeUndefined();
  });

  it("uses the combined snapshot without falling back to separate session reads", async () => {
    const { adapter, manager, proof, combined } = await setup({ combined: true });
    const grant = (await manager.complete(proof()))!;
    // The combined resolver owns its snapshot; the independent path must not override it.
    combined.mockResolvedValue(undefined);
    const separateRead = vi.spyOn(adapter, "findByTokenDigest");
    expect(await manager.resolve(grant.token)).toBeUndefined();
    expect(separateRead).not.toHaveBeenCalled();
  });

  it("supports a store whose optional combined capability is undefined", async () => {
    const { adapter, manager, proof } = await setup();
    Object.assign(adapter, { findSessionAndAccountByTokenDigest: undefined });
    const grant = (await manager.complete(proof()))!;
    expect(await manager.resolve(grant.token)).toEqual(grant.principal);
  });

  for (const explicitReason of [false, true]) {
    it(`revokes only the selected account's sessions with ${explicitReason ? "an explicit" : "the default"} reason`, async () => {
      const { adapter, account, manager, proof, advance } = await setup();
      const first = (await manager.complete(proof()))!;
      const second = (await manager.complete(proof()))!;
      const other = await adapter.createAccount({ subjectId: "subject-2" });
      const unrelated = (await manager.complete(proof(other.id)))!;
      advance(5_000);
      const reason = explicitReason ? "account-compromised" : "revoked-all";
      const revoked = explicitReason ? await manager.revokeAllForAccount(account.id, reason) : await manager.revokeAllForAccount(account.id);
      expect(revoked).toBe(2);
      expect(await manager.resolve(first.token)).toBeUndefined();
      expect(await manager.resolve(second.token)).toBeUndefined();
      expect(await manager.resolve(unrelated.token)).toEqual(unrelated.principal);
      expect(await adapter.listForAccount(account.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.principal.sessionId, revokedAt: new Date(epoch.getTime() + 5_000), revokeReason: reason }),
        expect.objectContaining({ id: second.principal.sessionId, revokedAt: new Date(epoch.getTime() + 5_000), revokeReason: reason }),
      ]));
      expect(await manager.revokeAllForAccount(account.id)).toBe(0);
      expect(await manager.revokeAllForAccount("missing-account")).toBe(0);
    });
  }

  it("retains the default logout reason and supplied clock for single-session revocation", async () => {
    const { adapter, account, manager, proof, advance } = await setup();
    const grant = (await manager.complete(proof()))!;
    advance(4_000);
    expect(await manager.revokeSession(grant.principal.sessionId)).toBe(true);
    expect((await adapter.listForAccount(account.id))[0]).toMatchObject({ revokeReason: "logout", revokedAt: new Date(epoch.getTime() + 4_000) });
    expect(await manager.revokeSession(grant.principal.sessionId)).toBe(false);
  });

  // A malformed bearer must be refused before storage access, even when its decoded bytes match.
  for (const variant of ["padded", "short", "invalid", "non-string"] as const) {
    it(`rejects a ${variant} token before querying session storage`, async () => {
      const { adapter, manager, proof } = await setup();
      const grant = (await manager.complete(proof()))!;
      const invalid = {
        padded: `${grant.token}=`,
        short: Buffer.alloc(31).toString("base64url"),
        invalid: "!",
        // JavaScript consumers can call the public manager without the TypeScript contract.
        "non-string": undefined as unknown as string,
      };
      const lookup = vi.spyOn(adapter, "findByTokenDigest");
      expect(await manager.resolve(invalid[variant])).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    });
  }

  it("rejects schema-invalid claims at session creation and resolution", async () => {
    const { adapter, manager, proof, createClaims, advance } = await setup();
    const grant = (await manager.complete(proof()))!;
    // Simulate persisted claims from an older schema, without bypassing the public store contract.
    const stored = (await adapter.findByTokenDigest(createHash("sha256").update(grant.token).digest()))!;
    const token = Buffer.alloc(32, 88).toString("base64url");
    await adapter.createSession({ ...stored, id: "legacy-session", tokenDigest: createHash("sha256").update(token).digest(), claims: { label: 42 } as unknown as Claims });
    advance(11_000);
    const touch = vi.spyOn(adapter, "touch");
    expect(await manager.resolve(token)).toBeUndefined();
    expect(touch).not.toHaveBeenCalled();
    createClaims.mockReturnValue({ label: 42 } as unknown as Claims);
    const write = vi.spyOn(adapter, "createSession");
    await expect(manager.complete(proof())).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  for (const overLimit of [false, true]) {
    it(`${overLimit ? "refuses" : "accepts"} valid UTF-8 claims ${overLimit ? "one byte beyond" : "exactly at"} the byte limit`, async () => {
      const label = `é${"a".repeat(overLimit ? 3 : 2)}`;
      const maxClaimsBytes = Buffer.byteLength(JSON.stringify({ label: "éaa" }));
      const { adapter, manager, proof, createClaims } = await setup({ maxClaimsBytes });
      createClaims.mockReturnValue({ label });
      const write = vi.spyOn(adapter, "createSession");
      if (overLimit) {
        await expect(manager.complete(proof())).rejects.toThrow("Authentication session claims are too large.");
        expect(write).not.toHaveBeenCalled();
      } else {
        const grant = (await manager.complete(proof()))!;
        expect(grant.principal.claims).toEqual({ label });
        expect(await manager.resolve(grant.token)).toEqual(grant.principal);
      }
    });
  }

  it("refuses oversized but schema-valid persisted claims before touching the session", async () => {
    const { adapter, manager, proof, createClaims, advance } = await setup({ maxClaimsBytes: 32 });
    createClaims.mockReturnValue({ label: "ok" });
    const grant = (await manager.complete(proof()))!;
    const stored = (await adapter.listForAccount(grant.principal.accountId))[0]!;
    const token = Buffer.alloc(32, 88).toString("base64url");
    await adapter.createSession({ ...stored, id: "oversized-session", tokenDigest: createHash("sha256").update(token).digest(), claims: { label: "é".repeat(32) } });
    advance(11_000);
    const touch = vi.spyOn(adapter, "touch");
    expect(await manager.resolve(token)).toBeUndefined();
    expect(touch).not.toHaveBeenCalled();
  });

  it("rejects claims that a permissive schema accepts but JSON cannot encode", async () => {
    const { adapter, account, proof } = await setup();
    const manager = new AuthenticationManager({ accountStore: adapter, sessionStore: adapter, subjectProvider: { findById: async (id) => ({ id }) } }, config,
      defineAuthentication({ sessionClaims: { schema: z.unknown(), create: () => undefined } }));
    const write = vi.spyOn(adapter, "createSession");
    await expect(manager.complete(proof(account.id))).rejects.toThrow("Authentication session claims are too large.");
    expect(write).not.toHaveBeenCalled();
  });

  it("fails closed before touching a session when the claims parser throws", async () => {
    const { adapter, account, manager, proof } = await setup();
    const grant = (await manager.complete(proof()))!;
    const rejecting = new AuthenticationManager({ accountStore: adapter, sessionStore: adapter, subjectProvider: { findById: async (id) => ({ id }) } }, config,
      defineAuthentication({ sessionClaims: {
        schema: z.object({ label: z.string() }).transform(() => { throw new Error("Claims migration failed"); }),
        create: () => ({ label: "member" }),
      } }), { now: () => new Date(epoch.getTime() + 11_000) });
    const touch = vi.spyOn(adapter, "touch");

    // A throw from an application transform must leave the request unauthenticated just like an invalid parse result.
    await expect(rejecting.resolve(grant.token)).resolves.toBeUndefined();
    expect(touch).not.toHaveBeenCalled();
    await expect(adapter.listForAccount(account.id)).resolves.toHaveLength(1);
  });

  it("coalesces touches before the interval and renews exactly at the boundary", async () => {
    const { adapter, account, manager, proof, advance } = await setup();
    const grant = (await manager.complete(proof()))!;
    const touch = vi.spyOn(adapter, "touch");
    advance(9_999);
    expect(await manager.resolve(grant.token)).toEqual(grant.principal);
    expect(touch).not.toHaveBeenCalled();
    advance(10_000);
    expect(await manager.resolve(grant.token)).toEqual(grant.principal);
    expect(touch).toHaveBeenCalledExactlyOnceWith({ id: grant.principal.sessionId, now: new Date(epoch.getTime() + 10_000), lastSeenAt: new Date(epoch.getTime() + 10_000), idleExpiresAt: new Date(epoch.getTime() + 70_000) });
    expect((await adapter.listForAccount(account.id))[0]?.idleExpiresAt).toEqual(new Date(epoch.getTime() + 70_000));
  });

  it("caps renewed idle expiry at the absolute deadline", async () => {
    const { adapter, account, manager, proof, advance } = await setup({ absoluteTtlSeconds: 90 });
    const grant = (await manager.complete(proof()))!;
    advance(50_000);
    expect(await manager.resolve(grant.token)).toEqual(grant.principal);
    expect((await adapter.listForAccount(account.id))[0]?.idleExpiresAt).toEqual(new Date(epoch.getTime() + 90_000));
  });

  it("returns anonymous access when revocation races with a conditional touch", async () => {
    const { adapter, manager, proof, advance } = await setup();
    const grant = (await manager.complete(proof()))!;
    const originalTouch = adapter.touch.bind(adapter);
    vi.spyOn(adapter, "touch").mockImplementation(async (input) => {
      await adapter.revoke({ id: input.id, revokedAt: input.now, reason: "concurrent-logout" });
      return originalTouch(input);
    });
    advance(10_000);
    expect(await manager.resolve(grant.token)).toBeUndefined();
  });

  for (const milliseconds of [60_000, 60_001]) {
    it(`refuses an idle-expired session at offset ${milliseconds} without a renewal attempt`, async () => {
      const { adapter, manager, proof, advance } = await setup();
      const grant = (await manager.complete(proof()))!;
      advance(milliseconds);
      const touch = vi.spyOn(adapter, "touch");
      expect(await manager.resolve(grant.token)).toBeUndefined();
      expect(touch).not.toHaveBeenCalled();
    });
  }

  for (const milliseconds of [4_999, 5_000, 5_001]) {
    it(`enforces an independent absolute deadline at offset ${milliseconds}`, async () => {
      const { adapter, manager, proof, advance } = await setup();
      const grant = (await manager.complete(proof()))!;
      const stored = (await adapter.listForAccount(grant.principal.accountId))[0]!;
      const token = Buffer.alloc(32, 88).toString("base64url");
      // Public storage inputs allow independent deadlines, including imported sessions.
      // Keep idle expiry later and stay below the touch interval so neither can mask this check.
      await adapter.createSession({ ...stored, id: "short-absolute-session", tokenDigest: createHash("sha256").update(token).digest(), absoluteExpiresAt: new Date(epoch.getTime() + 5_000) });
      advance(milliseconds);
      const touch = vi.spyOn(adapter, "touch");
      if (milliseconds < 5_000) expect(await manager.resolve(token)).toMatchObject({ sessionId: "short-absolute-session" });
      else expect(await manager.resolve(token)).toBeUndefined();
      expect(touch).not.toHaveBeenCalled();
    });
  }
});
