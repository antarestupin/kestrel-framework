import { describe, expect, test } from "vitest";
import { createRedisTestContext, type RedisTestContext } from "../../../testing/redis.js";
import type { CreateStoredToken, StoredTokenLookup } from "../../types.js";
import { RedisTokenStorageAdapter } from "./adapter.js";

const it = test.extend<{ redis: RedisTestContext }>({
  redis: async ({}, use) => {
    const redis = await createRedisTestContext();
    try { await use(redis); } finally { await redis.dispose(); }
  },
});
function token(id = "one", overrides: Partial<CreateStoredToken> = {}): CreateStoredToken {
  return {
    id, definition: "invitation", digest: Buffer.from(id), subject: "user:1", payload: { groups: [], precise: 1.2345678901234567 },
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), replaceExistingForSubject: false, ...overrides,
  };
}
const lookup = (stored: CreateStoredToken, now = new Date()): StoredTokenLookup => ({ definition: stored.definition, digest: stored.digest, now });

describe("RedisTokenStorageAdapter", () => {
  it("preserves application JSON, dates and digests across independent clients", async ({ redis }) => {
    const other = await createRedisTestContext();
    try {
      const first = new RedisTokenStorageAdapter(redis.client, { keyPrefix: redis.keyPrefix });
      const second = new RedisTokenStorageAdapter(other.client, { keyPrefix: redis.keyPrefix });
      const stored = token();
      await first.createMany([stored]);
      const { replaceExistingForSubject: _, ...expected } = stored;
      const found = await second.findValid(lookup(stored));
      expect(found).toEqual({ ...expected, digest: new Uint8Array(expected.digest) });
      // Returned values never expose a mutable reference to subsequent reads.
      (found!.payload as { groups: string[] }).groups.push("changed");
      expect((await first.findValid(lookup(stored)))!.payload).toEqual(stored.payload);
    } finally { await other.dispose(); }
  });

  it("consumes a token only once under concurrent requests", async ({ redis }) => {
    const adapter = new RedisTokenStorageAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = token();
    await adapter.createMany([stored]);
    const results = await Promise.all(Array.from({ length: 20 }, () => adapter.consume(lookup(stored))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)!.consumedAt).toBeInstanceOf(Date);
    await expect(adapter.findValid(lookup(stored))).resolves.toBeUndefined();
    // Consumed state is retained until prune(), rather than disappearing immediately.
    expect(await redis.client.hExists(`${redis.keyPrefix}{tokens}:records`, stored.id)).toBe(1);
  });

  it("atomically replaces only the selected definition and subject", async ({ redis }) => {
    const adapter = new RedisTokenStorageAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const first = token(), otherSubject = token("two", { subject: "user:2" });
    const otherDefinition = token("three", { definition: "password-reset" });
    await adapter.createMany([first, otherSubject, otherDefinition]);
    const replacement = token("replacement", { replaceExistingForSubject: true });
    await adapter.createMany([replacement]);
    await expect(adapter.findValid(lookup(first))).resolves.toBeUndefined();
    await expect(adapter.findValid(lookup(replacement))).resolves.toBeDefined();
    await expect(adapter.findValid(lookup(otherSubject))).resolves.toBeDefined();
    await expect(adapter.findValid(lookup(otherDefinition))).resolves.toBeDefined();
  });

  it("leaves exactly one active replacement under concurrent issuance", async ({ redis }) => {
    const adapter = new RedisTokenStorageAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const values = Array.from({ length: 10 }, (_, index) => token(String(index), { replaceExistingForSubject: true }));
    await Promise.all(values.map((value) => adapter.createMany([value])));
    const found = await Promise.all(values.map((value) => adapter.findValid(lookup(value))));
    expect(found.filter(Boolean)).toHaveLength(1);
  });

  it("rejects conflicting batches before issuing or replacing anything", async ({ redis }) => {
    const adapter = new RedisTokenStorageAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const original = token();
    await adapter.createMany([original]);
    const replacement = token("replacement", { replaceExistingForSubject: true });
    await expect(adapter.createMany([replacement, token("collision", { digest: original.digest })])).rejects.toThrow("unique");
    await expect(adapter.findValid(lookup(original))).resolves.toBeDefined();
    await expect(adapter.findValid(lookup(replacement))).resolves.toBeUndefined();
    await expect(adapter.createMany([token("duplicate"), token("duplicate")])).rejects.toThrow("unique");
    await expect(adapter.createMany([token("a", { replaceExistingForSubject: true }), token("b", { replaceExistingForSubject: true })])).rejects.toThrow("unique");
  });

  it("rejects wrong definitions and expired tokens without deleting lifecycle records", async ({ redis }) => {
    const adapter = new RedisTokenStorageAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const stored = token();
    await adapter.createMany([stored]);
    await expect(adapter.findValid({ ...lookup(stored), definition: "other" })).resolves.toBeUndefined();
    await expect(adapter.consume(lookup(stored, stored.expiresAt))).resolves.toBeUndefined();
    expect(await redis.client.hExists(`${redis.keyPrefix}{tokens}:records`, stored.id)).toBe(1);
  });

  it("revokes idempotently and deletes all retained states for a subject", async ({ redis }) => {
    const adapter = new RedisTokenStorageAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const values = [token("active"), token("consumed"), token("expired", { expiresAt: new Date(Date.now() - 1) })];
    await adapter.createMany(values);
    await adapter.consume(lookup(values[1]!));
    const mutation = { definition: "invitation", subject: "user:1", now: new Date() };
    await expect(adapter.revokeForSubject(mutation)).resolves.toBe(1);
    await expect(adapter.revokeForSubject(mutation)).resolves.toBe(0);
    await expect(adapter.deleteForSubject(mutation)).resolves.toBe(3);
    await expect(adapter.deleteForSubject(mutation)).resolves.toBe(0);
    expect(await redis.client.exists([`${redis.keyPrefix}{tokens}:records`, `${redis.keyPrefix}{tokens}:digests`, `${redis.keyPrefix}{tokens}:subjects`])).toBe(0);
  });

  it("prunes bounded expired and inactive records and cleans their indexes", async ({ redis }) => {
    const adapter = new RedisTokenStorageAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const old = new Date(Date.now() - 10_000);
    const expired = token("expired", { expiresAt: old });
    const consumed = token("consumed");
    const revoked = token("revoked");
    await adapter.createMany([expired, consumed, revoked, token("active")]);
    await adapter.consume(lookup(consumed, old));
    await expect(adapter.revoke({ ...lookup(revoked, old), revokedAt: old })).resolves.toBe(true);
    await expect(adapter.revoke({ ...lookup(revoked), revokedAt: new Date() })).resolves.toBe(false);
    const options = { expiredBefore: new Date(), inactiveBefore: old, limit: 1 };
    await expect(adapter.prune(options)).resolves.toBe(1);
    await expect(adapter.prune(options)).resolves.toBe(1);
    await expect(adapter.prune(options)).resolves.toBe(1);
    await expect(adapter.prune(options)).resolves.toBe(0);
    expect(await redis.client.hLen(`${redis.keyPrefix}{tokens}:records`)).toBe(1);
    expect(await redis.client.hLen(`${redis.keyPrefix}{tokens}:digests`)).toBe(1);
    expect(await redis.client.zCard(`${redis.keyPrefix}{tokens}:expires`)).toBe(1);
    expect(await redis.client.zCard(`${redis.keyPrefix}{tokens}:inactive`)).toBe(0);
    await expect(adapter.deleteForSubject({ definition: "invitation", subject: "user:1", now: new Date() })).resolves.toBe(1);
    expect(await redis.client.exists(`${redis.keyPrefix}{tokens}:subjects`)).toBe(0);
  });

  it("isolates prefixes and rejects malformed data and input", async ({ redis }) => {
    const adapter = new RedisTokenStorageAdapter(redis.client, { keyPrefix: redis.keyPrefix });
    const separate = new RedisTokenStorageAdapter(redis.client, { keyPrefix: `${redis.keyPrefix}separate:` });
    const stored = token();
    await adapter.createMany([stored]);
    await expect(separate.findValid(lookup(stored))).resolves.toBeUndefined();
    await redis.client.hSet(`${redis.keyPrefix}{tokens}:records`, stored.id, "broken");
    await expect(adapter.consume(lookup(stored))).rejects.toThrow();
    await expect(adapter.prune({ expiredBefore: new Date(), inactiveBefore: new Date(), limit: 0 })).rejects.toThrow();
    await expect(adapter.createMany([token("invalid", { payload: undefined })])).rejects.toThrow();
  });
});
