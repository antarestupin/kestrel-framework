import { describe, expect, it } from "vitest";

import type { CreateStoredToken } from "../../types.js";
import { MemoryTokenStorageAdapter } from "./adapter.js";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("MemoryTokenStorageAdapter", () => {
  it("preserves an issued batch when validation fails", async () => {
    const store = new MemoryTokenStorageAdapter();
    await store.createMany([createToken("first", 1)]);

    await expect(store.createMany([
      createToken("second", 2),
      createToken("first", 3),
    ])).rejects.toThrow("unique");

    await expect(store.findValid({
      definition: "test.token",
      digest: new Uint8Array([2]),
      now,
    })).resolves.toBeUndefined();
    await expect(store.findValid({
      definition: "test.token",
      digest: new Uint8Array([1]),
      now,
    })).resolves.toMatchObject({ id: "first" });
  });

  it("rejects existing digests and distinct duplicate IDs or digests in one batch", async () => {
    const store = new MemoryTokenStorageAdapter();
    await store.createMany([createToken("original", 1)]);
    const first = createToken("fresh", 2);
    for (const conflict of [
      createToken("fresh", 3),
      createToken("different-id", 2),
      createToken("existing-digest", 1),
    ]) {
      await expect(store.createMany([first, conflict])).rejects.toThrow("unique");
      await expect(store.findValid({ definition: first.definition, digest: first.digest, now }))
        .resolves.toBeUndefined();
    }
  });

  it("validates every replacement subject before revoking a token", async () => {
    const store = new MemoryTokenStorageAdapter();
    const subject = "account-1";
    const original = createToken("first", 1, { subject });
    const replacement = createToken("second", 2, {
      subject,
      replaceExistingForSubject: true,
    });
    const { subject: _subject, ...subjectless } = createToken("third", 3, {
      replaceExistingForSubject: true,
    });
    const lookup = { definition: original.definition, digest: original.digest, now };
    await store.createMany([original]);

    await expect(store.createMany([replacement, subjectless]))
      .rejects.toThrow("Replacement tokens require a subject");
    await expect(store.createMany([replacement, createToken("third", 3, {
      subject,
      replaceExistingForSubject: true,
    })])).rejects.toThrow("cannot replace the same definition and subject");

    await expect(store.findValid(lookup)).resolves.toMatchObject({ id: original.id });
    await expect(store.findValid({ ...lookup, digest: replacement.digest }))
      .resolves.toBeUndefined();
  });

  it("leaves all tokens unchanged when a later payload cannot be cloned", async () => {
    const store = new MemoryTokenStorageAdapter();
    const original = createToken("original", 1, { subject: "account-1" });
    const replacement = createToken("replacement", 2, {
      subject: "account-1",
      replaceExistingForSubject: true,
    });
    const lookup = { definition: original.definition, digest: original.digest, now };
    await store.createMany([original]);

    await expect(store.createMany([
      replacement,
      createToken("invalid", 3, { payload: () => "uncloneable" }),
    ])).rejects.toMatchObject({ name: "DataCloneError" });

    // Preparation failures must occur before revocation or insertion starts.
    await expect(store.findValid(lookup)).resolves.toMatchObject({ id: original.id });
    await expect(store.findValid({ ...lookup, digest: replacement.digest }))
      .resolves.toBeUndefined();
  });

  it("rejects invalid prune limits before removing records", async () => {
    const store = new MemoryTokenStorageAdapter();
    await store.createMany(["one", "two"].map((id, index) =>
      createToken(id, index + 1, { expiresAt: now }),
    ));
    const prune = { expiredBefore: now, inactiveBefore: now };
    await expect(store.prune({ ...prune, limit: -1 })).rejects.toThrow("positive");
    await expect(store.prune({ ...prune, limit: 2 })).resolves.toBe(2);
  });

  it("revokes only a valid token and prunes it at the inactivity boundary", async () => {
    const store = new MemoryTokenStorageAdapter();
    const token = createToken("first", 1);
    const lookup = { definition: token.definition, digest: token.digest, now };
    await store.createMany([token]);

    await expect(store.revoke({ ...lookup, definition: "other.token", revokedAt: now }))
      .resolves.toBe(false);
    await expect(store.revoke({ ...lookup, revokedAt: now })).resolves.toBe(true);
    await expect(store.revoke({ ...lookup, revokedAt: now })).resolves.toBe(false);
    await expect(store.consume(lookup)).resolves.toBeUndefined();

    const prune = { expiredBefore: now, inactiveBefore: now, limit: 1 };
    // The retained revocation counts only when its exact cutoff is reached.
    await expect(store.prune({ ...prune, inactiveBefore: new Date(now.getTime() - 1) }))
      .resolves.toBe(0);
    await expect(store.prune(prune)).resolves.toBe(1);
    await expect(store.prune(prune)).resolves.toBe(0);
  });

  it("scopes replacement, revocation and deletion to one definition and subject", async () => {
    const store = new MemoryTokenStorageAdapter();
    const original = createToken("first", 1, { subject: "account-1" });
    const otherSubject = createToken("second", 2, { subject: "account-2" });
    const otherDefinition = createToken("third", 3, { definition: "other.token", subject: "account-1" });
    const replacement = createToken("replacement", 4, { subject: "account-1", replaceExistingForSubject: true });
    const scope = { definition: original.definition, subject: "account-1", now };
    await store.createMany([original, otherSubject, otherDefinition]);
    await store.createMany([replacement]);

    await expect(store.findValid({ definition: original.definition, digest: original.digest, now }))
      .resolves.toBeUndefined();
    await expect(store.revokeForSubject(scope)).resolves.toBe(1);
    await expect(store.revokeForSubject(scope)).resolves.toBe(0);
    // Subject deletion removes both retained records and leaves unrelated tokens valid.
    await expect(store.deleteForSubject(scope)).resolves.toBe(2);
    for (const token of [otherSubject, otherDefinition]) {
      await expect(store.findValid({ definition: token.definition, digest: token.digest, now }))
        .resolves.toMatchObject({ id: token.id });
    }
  });

  it("does not replace an ordinary issuance or overwrite inactive timestamps", async () => {
    const store = new MemoryTokenStorageAdapter();
    const subject = "account-1";
    const active = createToken("active", 1, { subject });
    const ordinary = createToken("ordinary", 2, { subject });
    const consumed = createToken("consumed", 3, { subject, consumedAt: new Date(now) });
    const revoked = createToken("revoked", 4, { subject, revokedAt: new Date(now) });
    const expired = createToken("expired", 5, { subject, expiresAt: now });
    const replacement = createToken("replacement", 6, {
      subject, replaceExistingForSubject: true, createdAt: new Date(now.getTime() + 1),
    });
    const lookup = (token: CreateStoredToken) => ({ definition: token.definition, digest: token.digest, now });
    await store.createMany([active, consumed, revoked, expired]);
    await store.createMany([ordinary]);
    await expect(store.findValid(lookup(active))).resolves.toMatchObject({ id: active.id });
    await expect(store.findValid(lookup(expired))).resolves.toBeUndefined();

    // The input Dates are still caller-owned after insertion.
    consumed.consumedAt!.setTime(now.getTime() + 1_000);
    revoked.revokedAt!.setTime(now.getTime() + 1_000);
    await expect(store.revokeForSubject({ definition: active.definition, subject, now })).resolves.toBe(2);
    await store.createMany([replacement]);
    await expect(store.prune({
      expiredBefore: new Date(now.getTime() - 1), inactiveBefore: now, limit: 10,
    })).resolves.toBe(4);
    await expect(store.findValid(lookup(replacement))).resolves.toMatchObject({ id: replacement.id });
  });

  it("retains inactive records at their own timestamps when issuing replacements", async () => {
    const store = new MemoryTokenStorageAdapter();
    const subject = "shared";
    const createdAt = new Date(now.getTime() + 1);
    const consumedAt = new Date(now.getTime() + 2);
    await store.createMany([
      createToken("consumed", 1, { subject, consumedAt }),
      createToken("revoked", 2, { subject, revokedAt: now }),
      createToken("active", 3, { subject }),
    ]);
    await store.createMany([
      createToken("replacement", 4, { subject, createdAt, replaceExistingForSubject: true }),
      createToken("other-subject", 5, { subject: "other", createdAt, replaceExistingForSubject: true }),
    ]);

    const options = { expiredBefore: new Date(now.getTime() - 1), inactiveBefore: now, limit: 10 };
    // Applying an earlier issuance timestamp cannot advance pruning of a consumed token.
    await expect(store.prune({ ...options, inactiveBefore: new Date(now.getTime() - 1) })).resolves.toBe(0);
    await expect(store.prune(options)).resolves.toBe(1);
    await expect(store.prune({ ...options, inactiveBefore: createdAt })).resolves.toBe(1);
    await expect(store.prune({ ...options, inactiveBefore: consumedAt })).resolves.toBe(1);
  });

  it("prunes only a bounded eligible batch", async () => {
    const store = new MemoryTokenStorageAdapter();
    await store.createMany([
      createToken("expired", 1, {
        expiresAt: new Date(now.getTime() - 1),
      }),
      createToken("consumed", 2, {
        consumedAt: new Date(now.getTime() - 1_000),
      }),
      createToken("active", 3),
    ]);

    await expect(store.prune({
      expiredBefore: now,
      inactiveBefore: now,
      limit: 1,
    })).resolves.toBe(1);
    await expect(store.prune({
      expiredBefore: now,
      inactiveBefore: now,
      limit: 10,
    })).resolves.toBe(1);
    await expect(store.findValid({
      definition: "test.token",
      digest: new Uint8Array([3]),
      now,
    })).resolves.toMatchObject({ id: "active" });
  });

  it("prunes older rows first and breaks creation-time ties by ID", async () => {
    const store = new MemoryTokenStorageAdapter();
    await store.createMany([
      createToken("b", 1, { expiresAt: now }),
      createToken("z", 2, { expiresAt: now, createdAt: new Date(now.getTime() + 1) }),
      createToken("a", 3, { expiresAt: now }),
    ]);
    const options = { expiredBefore: now, inactiveBefore: now, limit: 1 };
    const deleteSubject = (subject: string) => store.deleteForSubject({ definition: "test.token", subject, now });
    await expect(store.prune(options)).resolves.toBe(1);
    await expect(deleteSubject("a")).resolves.toBe(0);
    await expect(store.prune(options)).resolves.toBe(1);
    await expect(deleteSubject("b")).resolves.toBe(0);
    await expect(deleteSubject("z")).resolves.toBe(1);
  });
});

function createToken(
  id: string,
  digest: number,
  overrides: Partial<CreateStoredToken> = {},
): CreateStoredToken {
  return {
    id,
    definition: "test.token",
    subject: id,
    digest: new Uint8Array([digest]),
    payload: { id },
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    replaceExistingForSubject: false,
    ...overrides,
  };
}
