import { describe, expect, it } from "vitest";

import { MemoryLockAdapter } from "./adapter.js";

describe("MemoryLockAdapter", () => {
  it("allows only one owner before expiration", async () => {
    const adapter = createAdapter();
    const first = await adapter.tryAcquire({
      key: "test:key",
      ownerId: "first",
      ttlMs: 1_000,
    });

    expect(first).toMatchObject({
      key: "test:key",
      ownerId: "first",
      fencingToken: 1n,
    });
    await expect(adapter.tryAcquire({
      key: "test:key",
      ownerId: "second",
      ttlMs: 1_000,
    })).resolves.toBeUndefined();
  });

  it("replaces an expired lease with a higher fencing token", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = createAdapter(() => now);
    await adapter.tryAcquire({
      key: "test:key",
      ownerId: "first",
      ttlMs: 1_000,
    });
    now = new Date("2026-01-01T00:00:01.000Z");

    const second = await adapter.tryAcquire({
      key: "test:key",
      ownerId: "second",
      ttlMs: 2_000,
    });

    expect(second).toMatchObject({
      ownerId: "second",
      fencingToken: 2n,
      expiresAt: new Date("2026-01-01T00:00:03.000Z"),
    });
  });

  it("acquires a batch atomically and preserves request order", async () => {
    const adapter = createAdapter();
    await adapter.tryAcquire({
      key: "test:busy",
      ownerId: "existing",
      ttlMs: 1_000,
    });

    await expect(adapter.tryAcquireMany([
      { key: "test:first", ownerId: "first", ttlMs: 1_000 },
      { key: "test:busy", ownerId: "busy", ttlMs: 1_000 },
    ])).resolves.toBeUndefined();
    await expect(adapter.tryAcquire({
      key: "test:first",
      ownerId: "later",
      ttlMs: 1_000,
    })).resolves.toMatchObject({ ownerId: "later" });

    const leases = await adapter.tryAcquireMany([
      { key: "test:second", ownerId: "second", ttlMs: 1_000 },
      { key: "test:third", ownerId: "third", ttlMs: 1_000 },
    ]);
    expect(leases?.map((lease) => lease.key)).toEqual([
      "test:second",
      "test:third",
    ]);
  });

  it("rejects duplicate keys in a batch", async () => {
    const adapter = createAdapter();

    await expect(adapter.tryAcquireMany([
      { key: "test:key", ownerId: "first", ttlMs: 1_000 },
      { key: "test:key", ownerId: "second", ttlMs: 1_000 },
    ])).rejects.toThrow("unique keys");
  });

  it("extends only a live lease owned by the caller", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = createAdapter(() => now);
    await adapter.tryAcquire({
      key: "test:key",
      ownerId: "owner",
      ttlMs: 1_000,
    });
    now = new Date("2026-01-01T00:00:00.500Z");

    await expect(adapter.extend({
      key: "test:key",
      ownerId: "other",
      ttlMs: 2_000,
    })).resolves.toBeUndefined();
    await expect(adapter.extend({
      key: "test:key",
      ownerId: "owner",
      ttlMs: 2_000,
    })).resolves.toMatchObject({
      expiresAt: new Date("2026-01-01T00:00:02.500Z"),
      fencingToken: 1n,
    });

    now = new Date("2026-01-01T00:00:02.500Z");
    await expect(adapter.extend({
      key: "test:key",
      ownerId: "owner",
      ttlMs: 2_000,
    })).resolves.toBeUndefined();
  });

  it("extends a batch atomically and preserves request order", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = createAdapter(() => now);
    await adapter.tryAcquireMany([
      { key: "test:first", ownerId: "first", ttlMs: 1_000 },
      { key: "test:second", ownerId: "second", ttlMs: 1_000 },
    ]);
    now = new Date("2026-01-01T00:00:00.500Z");

    await expect(adapter.extendMany([
      { key: "test:first", ownerId: "first", ttlMs: 2_000 },
      { key: "test:second", ownerId: "wrong", ttlMs: 2_000 },
    ])).resolves.toBeUndefined();
    now = new Date("2026-01-01T00:00:01.000Z");
    await expect(adapter.tryAcquire({
      key: "test:first",
      ownerId: "replacement",
      ttlMs: 2_000,
    })).resolves.toMatchObject({ ownerId: "replacement" });

    now = new Date("2026-01-01T00:00:00.000Z");
    const successAdapter = createAdapter(() => now);
    await successAdapter.tryAcquireMany([
      { key: "test:first", ownerId: "first", ttlMs: 1_000 },
      { key: "test:second", ownerId: "second", ttlMs: 1_000 },
    ]);
    now = new Date("2026-01-01T00:00:00.500Z");
    const extended = await successAdapter.extendMany([
      { key: "test:second", ownerId: "second", ttlMs: 3_000 },
      { key: "test:first", ownerId: "first", ttlMs: 3_000 },
    ]);
    expect(extended?.map((lease) => lease.key)).toEqual([
      "test:second",
      "test:first",
    ]);
  });

  it("releases only a lease owned by the caller", async () => {
    const adapter = createAdapter();
    await adapter.tryAcquire({
      key: "test:key",
      ownerId: "owner",
      ttlMs: 1_000,
    });

    await expect(adapter.release({
      key: "test:key",
      ownerId: "other",
    })).resolves.toBe(false);
    await expect(adapter.release({
      key: "test:key",
      ownerId: "owner",
    })).resolves.toBe(true);
    await expect(adapter.release({
      key: "test:key",
      ownerId: "owner",
    })).resolves.toBe(false);
  });

  it("prunes expired leases in bounded batches", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = createAdapter(() => now);
    await adapter.tryAcquire({
      key: "test:first",
      ownerId: "first",
      ttlMs: 1_000,
    });
    await adapter.tryAcquire({
      key: "test:second",
      ownerId: "second",
      ttlMs: 1_000,
    });
    now = new Date("2026-01-01T00:00:01.000Z");

    await expect(adapter.prune({ limit: 1 })).resolves.toBe(1);
    await expect(adapter.prune({ limit: 1 })).resolves.toBe(1);
    await expect(adapter.prune({ limit: 1 })).resolves.toBe(0);
  });
});

function createAdapter(
  now: () => Date = () => new Date("2026-01-01T00:00:00.000Z"),
): MemoryLockAdapter {
  return new MemoryLockAdapter({ now });
}
