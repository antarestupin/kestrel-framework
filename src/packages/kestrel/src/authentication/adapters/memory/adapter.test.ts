import { describe, expect, it } from "vitest";

import type { CreateStoredSession } from "../../stores.js";
import type { AuthenticationAccount } from "../../types.js";
import { MemoryAuthenticationAdapter } from "./adapter.js";

const epoch = Date.UTC(2026, 0, 1);

function sessionInput(account: AuthenticationAccount): CreateStoredSession<{ role: string }> {
  return {
    id: "session",
    accountId: account.id,
    tokenDigest: new Uint8Array([1, 2, 3]),
    claims: { role: "member" },
    accountSecurityVersion: account.securityVersion,
    evidence: { method: "password", factors: ["knowledge"], authenticatedAt: new Date(epoch) },
    createdAt: new Date(epoch),
    lastSeenAt: new Date(epoch),
    idleExpiresAt: new Date(epoch + 1_000),
    absoluteExpiresAt: new Date(epoch + 2_000),
  };
}

describe("MemoryAuthenticationAdapter", () => {
  it("keeps subject identifiers unique and leaves an existing account unchanged", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject", state: "disabled" });

    await expect(adapter.findBySubjectId("subject")).resolves.toEqual(account);
    await expect(adapter.findBySubjectId("missing")).resolves.toBeUndefined();
    await expect(adapter.findById("missing")).resolves.toBeUndefined();
    await expect(adapter.setState({ accountId: "missing", state: "active" }))
      .resolves.toBeUndefined();
    await expect(adapter.incrementSecurityVersion("missing")).resolves.toBeUndefined();
    await expect(adapter.createAccount({ subjectId: "subject" }))
      .rejects.toThrow("An authentication account already exists for this subject");
    await expect(adapter.findBySubjectId("subject")).resolves.toEqual(account);
  });

  it("rejects missing accounts, duplicate normalized usernames and stale hash replacements", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject" });
    const other = await adapter.createAccount({ subjectId: "other" });
    const input = {
      accountId: account.id,
      username: "Member",
      normalizedUsername: "member",
      passwordHash: "original",
    };

    await expect(adapter.createPasswordCredential({ ...input, accountId: "missing" }))
      .rejects.toThrow("Password credential account does not exist");
    await expect(adapter.findByNormalizedUsername("member")).resolves.toBeUndefined();
    const credential = await adapter.createPasswordCredential(input);
    await expect(adapter.createPasswordCredential({ ...input, accountId: other.id, username: "MEMBER" }))
      .rejects.toThrow("Normalized usernames must be unique");

    const replacement = {
      id: credential.id,
      previousHash: credential.passwordHash,
      passwordHash: "replacement",
      changedAt: new Date(epoch + 1_000),
    };
    await expect(adapter.replaceHash({ ...replacement, id: "missing" })).resolves.toBe(false);
    await expect(adapter.replaceHash({ ...replacement, previousHash: "stale" })).resolves.toBe(false);
    await expect(adapter.findByNormalizedUsername("member")).resolves.toEqual(credential);
    await expect(adapter.replaceHash(replacement)).resolves.toBe(true);
    await expect(adapter.findByNormalizedUsername("member")).resolves.toEqual({
      ...credential,
      passwordHash: replacement.passwordHash,
      passwordChangedAt: replacement.changedAt,
      updatedAt: replacement.changedAt,
    });
  });

  it("rejects duplicate session IDs and digests without changing either lookup", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject" });
    const stored = await adapter.createSession(sessionInput(account));
    const unusedDigest = new Uint8Array([4, 5, 6]);

    await expect(adapter.createSession({ ...stored, tokenDigest: unusedDigest }))
      .rejects.toThrow("Session identifiers and token digests must be unique");
    await expect(adapter.createSession({ ...stored, id: "another-session" }))
      .rejects.toThrow("Session identifiers and token digests must be unique");
    await expect(adapter.findByTokenDigest(unusedDigest)).resolves.toBeUndefined();
    await expect(adapter.findByTokenDigest(stored.tokenDigest)).resolves.toEqual(stored);
    await expect(adapter.listForAccount(account.id)).resolves.toEqual([stored]);
  });

  it("lists only the requested account's sessions in newest-first order", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject" });
    const other = await adapter.createAccount({ subjectId: "other" });
    const older = await adapter.createSession(sessionInput(account));
    const newer = await adapter.createSession({
      ...sessionInput(account), id: "newer", tokenDigest: new Uint8Array([2]),
      createdAt: new Date(epoch + 100),
    });
    const unrelated = await adapter.createSession({
      ...sessionInput(other), id: "unrelated", tokenDigest: new Uint8Array([3]),
      createdAt: new Date(epoch + 200),
    });

    // Interleaving another account's record checks the ownership filter independently of sorting.
    await expect(adapter.listForAccount(account.id)).resolves.toEqual([newer, older]);
    await expect(adapter.listForAccount(other.id)).resolves.toEqual([unrelated]);
  });

  it("persists each security-version increment independently per account", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject" });
    const other = await adapter.createAccount({ subjectId: "other" });

    await expect(adapter.incrementSecurityVersion(account.id)).resolves.toBe(account.securityVersion + 1);
    await expect(adapter.incrementSecurityVersion(account.id)).resolves.toBe(account.securityVersion + 2);
    await expect(adapter.findById(account.id)).resolves.toMatchObject({ securityVersion: account.securityVersion + 2 });
    await expect(adapter.findById(other.id)).resolves.toEqual(other);
  });

  it("does not renew missing, expired or revoked sessions", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject" });
    const stored = await adapter.createSession(sessionInput(account));
    const now = stored.idleExpiresAt;
    const touch = { id: stored.id, now, lastSeenAt: now, idleExpiresAt: stored.absoluteExpiresAt };

    await expect(adapter.touch({ ...touch, id: "missing" })).resolves.toBeUndefined();
    await expect(adapter.touch(touch)).resolves.toBeUndefined();
    await expect(adapter.findByTokenDigest(stored.tokenDigest)).resolves.toEqual(stored);

    // Use an earlier clock value to exercise the revocation check independently of expiration.
    const revokedAt = new Date(epoch + 500);
    await expect(adapter.revoke({ id: stored.id, revokedAt, reason: "logout" })).resolves.toBe(true);
    await expect(adapter.touch({ ...touch, now: revokedAt, lastSeenAt: revokedAt }))
      .resolves.toBeUndefined();
    await expect(adapter.findByTokenDigest(stored.tokenDigest)).resolves.toEqual({
      ...stored,
      revokedAt,
      revokeReason: "logout",
    });
  });

  it("does not renew a stored session at its absolute expiry even with later idle expiry", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject" });
    const input = sessionInput(account);
    // Storage can receive imported records whose idle and absolute deadlines are independent.
    const stored = await adapter.createSession({ ...input, idleExpiresAt: new Date(epoch + 3_000) });
    const now = stored.absoluteExpiresAt;

    await expect(adapter.touch({ id: stored.id, now, lastSeenAt: now, idleExpiresAt: stored.idleExpiresAt }))
      .resolves.toBeUndefined();
    await expect(adapter.findByTokenDigest(stored.tokenDigest)).resolves.toEqual(stored);
  });
});
