import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAction } from "../actions/index.js";
import { defineAtlas, defineAtlasResource, defineCatalogAtlasSource, truncateText, type AtlasDisplayOptions } from "./index.js";
import { resolveDisplayLabels } from "./display.js";

function fixture(display: string | AtlasDisplayOptions = {
  select: { text: { relation: "versionId", field: "title" }, copy: { relation: "versionId", field: "title" } },
  format: ({ text }) => typeof text === "string" ? truncateText(text, { maxLength: 5 }) : undefined,
}) {
  const row = z.object({ id: z.string(), versionId: z.string().nullable(), title: z.string() });
  const read = defineAction({ name: "example.read", input: z.object({ id: z.string() }), output: row.nullable(), handler: () => null });
  const list = defineAction({ name: "example.list", input: z.object({}), output: z.object({ items: z.array(row) }), handler: () => ({ items: [] }) });
  const many = defineAction({ name: "example.many", input: z.object({ ids: z.array(z.string()).max(2) }), output: z.array(row), handler: () => [] });
  const source = defineCatalogAtlasSource({ id: "example", actions: { read, list, many } });
  const options = { label: "Examples", identity: "id", source, capabilities: { read: source.query(read), list: source.query(list), readMany: source.query(many) } };
  const target = defineAtlasResource({ ...options, id: "version", display: "title", readManyBatchSize: 2 });
  const parent = defineAtlasResource({ ...options, id: "document", display, fields: { versionId: { relation: { resource: "version", cardinality: "one", relatedRecords: false } } } });
  return { resources: [parent, target], parent };
}

describe("Atlas display", () => {
  it("deduplicates dependencies, chunks reads, preserves output and falls back for missing relations", async () => {
    const { resources } = fixture();
    defineAtlas({ resources });
    const execute = vi.fn(async (_operation, input) => (input as { ids: string[] }).ids.filter((id) => id !== "missing").map((id) => ({ id, versionId: null, title: "Example title" })));
    const data = { items: ["a", "a", "b", "missing", null].map((versionId, i) => ({ id: String(i), versionId, title: "Unused" })) };
    const before = structuredClone(data);
    expect(await resolveDisplayLabels(resources, "document", data, { execute })).toEqual({ shape: "list", labels: ["Exam…", "Exam…", "Exam…", "3", "4"] });
    expect(execute.mock.calls.map((call) => call[1])).toEqual([{ ids: ["a", "b"] }, { ids: ["missing"] }]);
    expect(data).toEqual(before);
    expect(JSON.stringify(resources[0]!.toManifest())).not.toContain('"select"');
  });

  it("supports direct fields and multiple inputs without I/O", async () => {
    const { resources } = fixture({ select: { text: "title", id: "id" }, format: ({ text, id }) => `${id}: ${text}` });
    const execute = vi.fn();
    expect(await resolveDisplayLabels(resources, "document", { id: "a", title: "Hello" }, { execute })).toEqual({ shape: "record", labels: ["a: Hello"] });
    expect(await resolveDisplayLabels(resources, "document", { id: "a", title: "Hello", items: [] }, { execute }, "record")).toEqual({ shape: "record", labels: ["a: Hello"] });
    expect(execute).not.toHaveBeenCalled();
    expect(await resolveDisplayLabels(resources, "document", null, { execute })).toBeUndefined();
  });

  it("propagates authorization and formatter failures", async () => {
    const { resources } = fixture();
    await expect(resolveDisplayLabels(resources, "document", [{ id: "a", versionId: "v" }], { execute: async () => { throw new Error("Forbidden"); } })).rejects.toThrow("Forbidden");
    const broken = fixture({ select: {}, format: () => { throw new Error("Format failed"); } });
    await expect(resolveDisplayLabels(broken.resources, "document", { id: "a" }, { execute: vi.fn() })).rejects.toThrow("Format failed");
  });

  it("validates relation paths and direct fields during compilation", () => {
    expect(() => defineAtlas({ resources: fixture({ select: { text: { relation: "id", field: "title" } }, format: () => "" }).resources })).toThrow("display relation");
    expect(() => defineAtlas({ resources: fixture({ select: { text: "unknown" }, format: () => "" }).resources })).toThrow("display dependency");
    expect(() => fixture("unknown").parent.toManifest()).toThrow("display field");
    expect(() => defineAtlas({ resources: fixture({ select: { text: { relation: "versionId", field: "unknown" } }, format: () => "" }).resources })).toThrow("display relation");
  });

  it("truncates graphemes and counts the ellipsis within the limit", () => {
    expect(truncateText("👨‍👩‍👧‍👦abcd", { maxLength: 3 })).toBe("👨‍👩‍👧‍👦a…");
    expect(truncateText("abc", { maxLength: 3 })).toBe("abc");
    expect(truncateText("ab", { maxLength: 1 })).toBe("…");
    expect(() => truncateText("abc", { maxLength: 0 })).toThrow("maxLength");
  });
});
