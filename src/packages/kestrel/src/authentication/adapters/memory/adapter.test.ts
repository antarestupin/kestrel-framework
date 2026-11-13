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

    // The default clock supplies usable audit timestamps.
    expect(Number.isFinite(account.createdAt.getTime())).toBe(true);
    expect(account.updatedAt).toEqual(account.createdAt);
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

  it("rejects a repeated generated account identifier before updating either lookup", async () => {
    const adapter = new MemoryAuthenticationAdapter({ createId: () => "repeated" });
    const first = await adapter.createAccount({ subjectId: "first" });

    // A caller-provided ID source must never redirect an existing subject to a different account.
    await expect(adapter.createAccount({ subjectId: "second" })).rejects.toThrow("Account identifiers must be unique.");
    await expect(adapter.findById(first.id)).resolves.toEqual(first);
    await expect(adapter.findBySubjectId(first.subjectId)).resolves.toEqual(first);
    await expect(adapter.findBySubjectId("second")).resolves.toBeUndefined();
  });

  it("rejects a repeated generated credential identifier without redirecting the original username", async () => {
    const adapter = new MemoryAuthenticationAdapter({ createId: () => "repeated" });
    const account = await adapter.createAccount({ subjectId: "subject" });
    const first = await adapter.createPasswordCredential({
      accountId: account.id, username: "First", normalizedUsername: "first", passwordHash: "original",
    });

    await expect(adapter.createPasswordCredential({
      accountId: account.id, username: "Second", normalizedUsername: "second", passwordHash: "replacement",
    })).rejects.toThrow("Password credential identifiers must be unique.");
    await expect(adapter.findByNormalizedUsername("first")).resolves.toEqual(first);
    await expect(adapter.findByNormalizedUsername("second")).resolves.toBeUndefined();
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
    // Mutating the caller's date cannot rewrite the audit timestamps after the change.
    replacement.changedAt.setTime(0);
    await expect(adapter.findByNormalizedUsername("member")).resolves.toMatchObject({
      passwordChangedAt: new Date(epoch + 1_000), updatedAt: new Date(epoch + 1_000),
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

  it("invalidates the previous security version when an account changes state", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject" });

    await expect(adapter.setState({ accountId: account.id, state: "disabled" }))
      .resolves.toMatchObject({ state: "disabled", securityVersion: account.securityVersion + 1 });
    await expect(adapter.setState({ accountId: account.id, state: "active" }))
      .resolves.toMatchObject({ state: "active", securityVersion: account.securityVersion + 2 });
  });

  it("keeps session claims detached from input and output objects", async () => {
    const adapter = new MemoryAuthenticationAdapter<{ role: { name: string } }>();
    const account = await adapter.createAccount({ subjectId: "subject" });
    const claims = { role: { name: "member" } };
    const stored = await adapter.createSession({ ...sessionInput(account), claims });
    claims.role.name = "owner";
    stored.claims.role.name = "admin";

    const listed = await adapter.listForAccount(account.id);
    expect(listed[0]?.claims).toEqual({ role: { name: "member" } });
    listed[0]!.claims.role.name = "administrator";
    await expect(adapter.findByTokenDigest(stored.tokenDigest))
      .resolves.toMatchObject({ claims: { role: { name: "member" } } });
  });

  it("preserves the latest activity when a stale touch completes after a fresh touch", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject" });
    const session = await adapter.createSession(sessionInput(account));
    const latest = new Date(epoch + 500);
    const fresh = await adapter.touch({
      id: session.id, now: latest, lastSeenAt: latest, idleExpiresAt: new Date(epoch + 3_000),
    });

    // A request that began earlier can write after a more recent one.
    const older = new Date(epoch + 200);
    await expect(adapter.touch({
      id: session.id, now: older, lastSeenAt: older, idleExpiresAt: new Date(epoch + 1_200),
    })).resolves.toEqual(fresh);
    expect(fresh).toMatchObject({ lastSeenAt: latest, idleExpiresAt: session.absoluteExpiresAt });
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
    await expect(adapter.revoke({ id: "missing", revokedAt, reason: "logout" })).resolves.toBe(false);
    await expect(adapter.revoke({ id: stored.id, revokedAt, reason: "logout" })).resolves.toBe(true);
    await expect(adapter.touch({ ...touch, now: revokedAt, lastSeenAt: revokedAt }))
      .resolves.toBeUndefined();
    const revoked = await adapter.findByTokenDigest(stored.tokenDigest);
    expect(revoked).toEqual({
      ...stored,
      revokedAt,
      revokeReason: "logout",
    });
    revoked?.revokedAt?.setTime(epoch);
    expect((await adapter.findByTokenDigest(stored.tokenDigest))?.revokedAt).toEqual(new Date(epoch + 500));
  });

  it("keeps stored revocation times independent from caller-owned dates", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject" });
    const single = await adapter.createSession(sessionInput(account));
    const bulk = await adapter.createSession({
      ...sessionInput(account), id: "bulk", tokenDigest: new Uint8Array([8]),
    });
    const singleRevokedAt = new Date(epoch + 100);
    const bulkRevokedAt = new Date(epoch + 200);
    await expect(adapter.revoke({ id: single.id, revokedAt: singleRevokedAt, reason: "logout" })).resolves.toBe(true);
    await expect(adapter.revokeAllForAccount({
      accountId: account.id, revokedAt: bulkRevokedAt, reason: "account-compromised",
    })).resolves.toBe(1);

    singleRevokedAt.setTime(0);
    bulkRevokedAt.setTime(1);
    expect((await adapter.findByTokenDigest(single.tokenDigest))?.revokedAt).toEqual(new Date(epoch + 100));
    expect((await adapter.findByTokenDigest(bulk.tokenDigest))?.revokedAt).toEqual(new Date(epoch + 200));
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
