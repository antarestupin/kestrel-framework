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
