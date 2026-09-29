import {
  describe,
  expect,
  it,
} from "vitest";

import { MemoryCacheAdapter } from "./adapter.js";
import type { CacheEntry } from "../../types.js";

function key(
  value: string,
  namespace = "test",
): string {
  return `${namespace}:${value}`;
}

function entry(
  value: unknown,
  options: {
    expiresAt?: Date;
    sizeBytes?: number;
    tags?: readonly string[];
  } = {},
): CacheEntry {
  return {
    value,
    expiresAt: options.expiresAt
      ?? new Date("2026-01-01T01:00:00.000Z"),
    tags: options.tags ?? [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    sizeBytes: options.sizeBytes ?? 1,
  };
}

function createAdapter(
  overrides: Partial<ConstructorParameters<typeof MemoryCacheAdapter>[0]> = {},
): MemoryCacheAdapter {
  return new MemoryCacheAdapter({
    maxEntries: 10,
    maxSizeBytes: 100,
    maxEntrySizeBytes: 50,
    now: () => new Date("2026-01-01T00:30:00.000Z"),
    ...overrides,
  });
}

describe("MemoryCacheAdapter", () => {
  it("stores, retrieves and deletes an entry", async () => {
    const adapter = createAdapter();
    const stored = entry("value");

    await adapter.set(key("key"), stored);

    await expect(adapter.get(key("key"))).resolves.toBe(stored);
    await expect(adapter.delete(key("key"))).resolves.toBe(true);
    await expect(adapter.delete(key("key"))).resolves.toBe(false);
  });

  it("removes an expired entry lazily", async () => {
    const adapter = createAdapter();
    await adapter.set(key("expired"), entry("value", {
      expiresAt: new Date("2026-01-01T00:29:59.000Z"),
    }));

    await expect(adapter.get(key("expired"))).resolves.toBeUndefined();
    await expect(adapter.delete(key("expired"))).resolves.toBe(false);
  });

  it("evicts the least recently used entry by count", async () => {
    const adapter = createAdapter({ maxEntries: 2 });
    await adapter.set(key("first"), entry("first"));
    await adapter.set(key("second"), entry("second"));

    // Reading first promotes it, making second the eviction candidate.
    await adapter.get(key("first"));
    await adapter.set(key("third"), entry("third"));

    await expect(adapter.get(key("first"))).resolves.toBeDefined();
    await expect(adapter.get(key("second"))).resolves.toBeUndefined();
    await expect(adapter.get(key("third"))).resolves.toBeDefined();
  });

  it("evicts entries until the total size limit is respected", async () => {
    const adapter = createAdapter({ maxSizeBytes: 5 });
    await adapter.set(key("first"), entry("first", { sizeBytes: 3 }));
    await adapter.set(key("second"), entry("second", { sizeBytes: 3 }));

    await expect(adapter.get(key("first"))).resolves.toBeUndefined();
    await expect(adapter.get(key("second"))).resolves.toBeDefined();
  });

  it("accounts for replacements without retaining the old size", async () => {
    const adapter = createAdapter({ maxSizeBytes: 5 });
    await adapter.set(key("same"), entry("large", { sizeBytes: 5 }));
    await adapter.set(key("same"), entry("small", { sizeBytes: 1 }));
    await adapter.set(key("other"), entry("other", { sizeBytes: 4 }));

    await expect(adapter.get(key("same"))).resolves.toBeDefined();
    await expect(adapter.get(key("other"))).resolves.toBeDefined();
  });

  it("does not store an entry over the individual size limit", async () => {
    const adapter = createAdapter({ maxEntrySizeBytes: 2 });

    await adapter.set(key("large"), entry("value", { sizeBytes: 3 }));

    await expect(adapter.get(key("large"))).resolves.toBeUndefined();
  });

  it("uses AND semantics when invalidating tags", async () => {
    const adapter = createAdapter();
    await adapter.set(key("all"), entry("all", { tags: ["a", "b"] }));
    await adapter.set(key("one"), entry("one", { tags: ["a"] }));

    await expect(adapter.invalidateAllTags(["a", "b"]))
      .resolves.toBe(1);
    await expect(adapter.get(key("all"))).resolves.toBeUndefined();
    await expect(adapter.get(key("one"))).resolves.toBeDefined();
  });

  it("resets every entry owned by the adapter", async () => {
    const adapter = createAdapter();
    await adapter.set(key("one", "first"), entry("first", { tags: ["tag"] }));
    await adapter.set(key("one", "second"), entry("second", { tags: ["tag"] }));

    await expect(adapter.reset()).resolves.toBe(2);
    await expect(adapter.get(key("one", "first")))
      .resolves.toBeUndefined();
    await expect(adapter.get(key("one", "second")))
      .resolves.toBeUndefined();
  });

  it("bounds the number of entries inspected by pruning", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const adapter = createAdapter({
      pruneBatchSize: 1,
      now: () => now,
    });
    const expiresAt = new Date("2026-01-01T00:01:00.000Z");
    await adapter.set(key("first"), entry("first", { expiresAt }));
    await adapter.set(key("second"), entry("second", { expiresAt }));

    // Advance time only after insertion so opportunistic write pruning does
    // not remove either fixture before the bounded calls below.
    now = new Date("2026-01-01T00:02:00.000Z");

    // Each explicit call can inspect and remove at most one matching entry.
    await expect(adapter.prune({ limit: 1 }))
      .resolves.toBe(1);
    await expect(adapter.prune({ limit: 1 }))
      .resolves.toBe(1);
  });
});
