import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { AtlasResourceManifest } from "../../contract.js";
import { loadRelationRecords } from "./relation_loader.js";

const resource = { id: "entry", identity: "id", readManyBatchSize: 2 } as AtlasResourceManifest;
describe("relation batch cache", () => {
  it("deduplicates, bounds batches, caches absent records and fetches only new identifiers", async () => {
    const client = new QueryClient();
    const read = vi.fn(async (ids: readonly unknown[]) => ids.filter((id) => id !== "missing").map((id) => ({ id, __atlas_display: `Label ${id}` })));
    try {
      expect(await loadRelationRecords(client, "/atlas", resource, [1, 1, 2, "missing", 3], read)).toHaveLength(3);
      expect(read.mock.calls.map(([ids]) => ids)).toEqual([[1, 2], ["missing", 3]]);
      await loadRelationRecords(client, "/atlas", resource, [1, 2, "missing", 3, 4], read);
      expect(read.mock.calls.at(-1)?.[0]).toEqual([4]);
      expect(read).toHaveBeenCalledTimes(3);
      // Resource invalidation also invalidates normalized positive and negative entries.
      await client.invalidateQueries({ queryKey: [resource.id] });
      await loadRelationRecords(client, "/atlas", resource, [1, "missing"], read);
      expect(read.mock.calls.at(-1)?.[0]).toEqual([1, "missing"]);
      client.setQueryData([resource.id, "relation-value", "/atlas", 1], { record: { id: 1 } }, { updatedAt: Date.now() - 31_000 });
      await loadRelationRecords(client, "/atlas", resource, [1], read);
      expect(read).toHaveBeenCalledTimes(5);
      await loadRelationRecords(client, "/other", resource, [1], read);
      expect(read).toHaveBeenCalledTimes(6);
    } finally { client.clear(); }
  });
  it("does not cache authorization failures as missing records", async () => {
    const client = new QueryClient();
    try {
      await expect(loadRelationRecords(client, "/atlas", resource, [1], async () => { throw new Error("Forbidden"); })).rejects.toThrow("Forbidden");
      const read = vi.fn(async () => [{ id: 1 }]);
      expect(await loadRelationRecords(client, "/atlas", resource, [1], read)).toEqual([{ id: 1 }]);
      expect(read).toHaveBeenCalledOnce();
    } finally { client.clear(); }
  });
});
