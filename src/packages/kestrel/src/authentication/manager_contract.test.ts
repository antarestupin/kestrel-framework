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
  const createClaims = vi.fn((): Claims => ({ label: "member" }));
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

  for (const combined of [false, true]) {
    describe(combined ? "combined account/session lookup" : "separate account/session lookups", () => {
      it("refuses an existing session after its account is disabled", async () => {
        const { adapter, account, manager, proof, advance } = await setup({ combined });
        const grant = (await manager.complete(proof()))!;
        await adapter.setState({ accountId: account.id, state: "disabled" });
        advance(11_000);
        const touch = vi.spyOn(adapter, "touch");
        expect(await manager.resolve(grant.token)).toBeUndefined();
        expect(touch).not.toHaveBeenCalled();
        expect((await adapter.listForAccount(account.id))[0]?.revokedAt).toBeUndefined();
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
  for (const variant of ["padded", "short", "invalid"] as const) {
    it(`rejects a ${variant} token before querying session storage`, async () => {
      const { adapter, manager, proof } = await setup();
      const grant = (await manager.complete(proof()))!;
      const token = variant === "padded" ? `${grant.token}=` : variant === "short" ? Buffer.alloc(31).toString("base64url") : "!";
      const lookup = vi.spyOn(adapter, "findByTokenDigest");
      expect(await manager.resolve(token)).toBeUndefined();
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
