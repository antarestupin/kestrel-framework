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
