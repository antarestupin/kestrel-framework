import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryTokenStorageAdapter } from "./adapters/memory/index.js";
import { defineToken } from "./definition.js";
import { StoredTokenStrategy } from "./stored_strategy.js";

const definition = defineToken({
  name: "service.access",
  payload: z.object({ scope: z.string() }),
});

describe("StoredTokenStrategy", () => {
  it.each([31, 32.5])("rejects an invalid bearer size of %s bytes", (tokenBytes) => {
    expect(() => new StoredTokenStrategy(new MemoryTokenStorageAdapter(), { tokenBytes }))
      .toThrow("tokenBytes must be an integer of at least 32");
  });

  it("issues a canonical random bearer and stores its digest with the requested lifetime", async () => {
    const store = new MemoryTokenStorageAdapter();
    const strategy = new StoredTokenStrategy(store, { tokenBytes: 32 });
    const payload = { scope: "read" };
    const now = new Date("2026-01-01T00:00:00.000Z");

    // Freeze the default clock while using the real random bearer generator.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now);
      const [grant] = await strategy.issue(definition, [payload], { ttlSeconds: 60 });
      const bytes = Buffer.from(grant!.token, "base64url");
      const digest = new Uint8Array(createHash("sha256").update(grant!.token).digest());

      expect(bytes.byteLength).toBe(32);
      expect(bytes.toString("base64url")).toBe(grant!.token);
      expect(grant!.expiresAt).toEqual(new Date(now.getTime() + 60_000));
      await expect(store.findValid({ definition: definition.name, digest, now }))
        .resolves.toMatchObject({ digest, payload, createdAt: now, expiresAt: grant!.expiresAt });
      await expect(strategy.verify(definition, grant!.token)).resolves.toEqual({
        payload, expiresAt: grant!.expiresAt,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid lifetimes before writing any token state", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const store = new MemoryTokenStorageAdapter();
    const createMany = vi.spyOn(store, "createMany");
    const strategy = new StoredTokenStrategy(store, { tokenBytes: 32, now: () => now });
    const payloads = [{ scope: "read" }];

    // Exercise both lifetime inputs, including the exact expiration boundary.
    for (const ttlSeconds of [0, 1.5]) {
      await expect(strategy.issue(definition, payloads, { ttlSeconds }))
        .rejects.toThrow("ttlSeconds must be a positive integer");
    }
    for (const expiresAt of [now, new Date(NaN)]) {
      await expect(strategy.issue(definition, payloads, { expiresAt }))
        .rejects.toThrow("expiration must be a valid future date");
    }
    expect(createMany).not.toHaveBeenCalled();
  });

  it("rejects empty, truncated and padded bearers before reaching storage", async () => {
    const store = new MemoryTokenStorageAdapter();
    const find = vi.spyOn(store, "findValid");
    const consume = vi.spyOn(store, "consume");
    const revoke = vi.spyOn(store, "revoke");
    const strategy = new StoredTokenStrategy(store, { tokenBytes: 32 });
    const [grant] = await strategy.issue(definition, [{ scope: "read" }], { ttlSeconds: 60 });

    // Node can decode a padded alias, so rejection must also check the canonical encoding.
    for (const bearer of ["", grant!.token.slice(1), `${grant!.token}=`]) {
      await expect(strategy.verify(definition, bearer)).resolves.toBeUndefined();
      await expect(strategy.consume(definition, bearer)).resolves.toBeUndefined();
      await expect(strategy.revoke(definition, bearer)).resolves.toBe(false);
    }
    expect(find).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    await expect(strategy.verify(definition, grant!.token)).resolves.toMatchObject({
      payload: { scope: "read" },
    });
  });
});
