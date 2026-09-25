import { describe, expect, it, vi } from "vitest";

import { CachePool } from "../../cache_pool.js";
import type { CacheEntry } from "../../types.js";
import { RedisCacheAdapter, type RedisCacheClient } from "./adapter.js";

function fixture() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const sendCommand = vi.fn<RedisCacheClient["sendCommand"]>();
  const adapter = new RedisCacheAdapter({ sendCommand }, {
    maxEntrySizeBytes: 1_024,
    now: () => now,
  });
  const entry: CacheEntry = {
    value: { count: 2 },
    tags: [],
    sizeBytes: 20,
    createdAt: now,
    expiresAt: new Date("2026-01-01T00:01:00.000Z"),
  };
  return { adapter, sendCommand, entry };
}

describe("RedisCacheAdapter failure boundaries", () => {
  it("propagates connection failures for the pool to apply its operation policy", async () => {
    const { adapter, sendCommand, entry } = fixture();
    const failure = new Error("Connection unavailable");
    sendCommand.mockRejectedValue(failure);
    await expect(adapter.get("app:item")).rejects.toBe(failure);
    await expect(adapter.set("app:item", entry)).rejects.toBe(failure);
    await expect(adapter.delete("app:item")).rejects.toBe(failure);
  });

  it("keeps read-through loading fail-open but propagates deletion errors", async () => {
    const { adapter, sendCommand } = fixture();
    const failure = new Error("Connection unavailable");
    sendCommand.mockRejectedValue(failure);
    const report = vi.fn();
    const cache = new CachePool(adapter, {
      namespace: "app", defaultTtlSeconds: 60, maxTtlSeconds: 120,
      maxEntrySizeBytes: 1_024, reportStorageError: report,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await expect(cache.remember("item", async () => "loaded")).resolves.toBe("loaded");
    expect(report.mock.calls.map(([event]) => event.operation)).toEqual(["get", "set"]);
    await expect(cache.delete("item")).rejects.toBe(failure);
  });

  it("rejects unexpected write and deletion replies", async () => {
    const { adapter, sendCommand, entry } = fixture();
    sendCommand.mockResolvedValueOnce(123).mockResolvedValue(null);
    await expect(adapter.get("app:item")).rejects.toThrow("string or null");
    await expect(adapter.set("app:item", entry)).rejects.toThrow("must return OK");
    await expect(adapter.delete("app:item")).rejects.toThrow("zero or one");
  });

  it("validates configuration before issuing commands", () => {
    const { sendCommand } = fixture();
    for (const maxEntrySizeBytes of [0, -1, 1.5, Infinity]) {
      expect(() => new RedisCacheAdapter({ sendCommand }, { maxEntrySizeBytes }))
        .toThrow("positive safe integer");
    }
    expect(() => new RedisCacheAdapter({ sendCommand }, {
      maxEntrySizeBytes: 100, keyPrefix: "",
    })).toThrow("prefixes cannot be empty");
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
