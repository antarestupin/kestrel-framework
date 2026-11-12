import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAction } from "../actions/index.js";
import { defineAtlas, defineAtlasResource, defineCatalogAtlasSource, truncateText, type AtlasDisplayOptions } from "./index.js";
import { resolveDisplayLabels, validateDisplays } from "./display.js";

function fixture(display: string | AtlasDisplayOptions = {
  select: { text: { relation: "versionId", field: "title" }, copy: { relation: "versionId", field: "title" } },
  format: ({ text }) => typeof text === "string" ? truncateText(text, { maxLength: 5 }) : undefined,
}, options: { batchSize?: number; cardinality?: "one" | "many"; permissiveReadMany?: boolean; targetDisplay?: AtlasDisplayOptions } = {}) {
  const batchSize = options.batchSize ?? 2;
  const row = z.object({ id: z.string(), versionId: z.string().nullable(), ownerId: z.string().nullish(), title: z.string() });
  const read = defineAction({ name: "example.read", input: z.object({ id: z.string() }), output: row.nullable(), handler: () => null });
  const list = defineAction({ name: "example.list", input: z.object({}), output: z.object({ items: z.array(row) }), handler: () => ({ items: [] }) });
  const many = defineAction({ name: "example.many", input: z.object({ ids: z.array(z.string()).max(batchSize) }),
    output: options.permissiveReadMany ? z.unknown() : z.array(row), handler: () => [],
  });
  const source = defineCatalogAtlasSource({ id: "example", actions: { read, list, many } });
  const base = { label: "Examples", identity: "id", source, capabilities: { read: source.query(read), list: source.query(list), readMany: source.query(many) } };
  const target = defineAtlasResource({ ...base, id: "version", display: options.targetDisplay ?? "title", readManyBatchSize: batchSize });
  const parent = defineAtlasResource({ ...base, id: "document", display, fields: {
    versionId: { relation: { resource: "version", cardinality: options.cardinality ?? "one", relatedRecords: false } },
    ownerId: { relation: { resource: "version", cardinality: "one", relatedRecords: false } },
  } });
  return { resources: [parent, target], parent, target, many };
}

describe("Atlas display", () => {
  it("deduplicates dependencies, chunks reads, preserves output and falls back for missing relations", async () => {
    const { resources, many } = fixture();
    defineAtlas({ resources });
    const execute = vi.fn(async (_operation, input) => (input as { ids: string[] }).ids.filter((id) => id !== "missing").map((id) => ({ id, versionId: null, title: "Example title" })));
    const data = { items: ["a", "a", "b", "missing", null].map((versionId, i) => ({ id: String(i), versionId, title: "Unused" })) };
    const before = structuredClone(data);
    expect(await resolveDisplayLabels(resources, "document", data, { execute })).toEqual({ shape: "list", labels: ["Exam…", "Exam…", "Exam…", "3", "4"] });
    expect(execute.mock.calls.map((call) => call[1])).toEqual([{ ids: ["a", "b"] }, { ids: ["missing"] }]);
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual([many, many]);
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

  it("merges distinct dependencies pointing at the same target and preserves record order", async () => {
    const { resources, many } = fixture({
      select: { version: { relation: "versionId", field: "title" }, owner: { relation: "ownerId", field: "title" } },
      format: ({ version, owner }) => `${version}/${owner}`,
    });
    const execute = vi.fn(async (_operation, input) => [...(input as { ids: string[] }).ids].reverse()
      .map((id) => ({ id, versionId: null, title: id.toUpperCase() })));
    const rows = [
      { id: "one", versionId: "a", ownerId: "c" },
      { id: "two", versionId: "b", ownerId: "a" },
    ];
    // Reverse each backend response to verify association by identity, not position.
    await expect(resolveDisplayLabels(resources, "document", rows, { execute })).resolves.toStrictEqual({
      shape: "array", labels: ["A/C", "B/A"],
    });
    expect(execute.mock.calls).toEqual([[many, { ids: ["a", "b"] }], [many, { ids: ["c"] }]]);
  });

  it("defaults to a bounded batch size when a Resource omits it", async () => {
    const { parent, target } = fixture(undefined, { batchSize: 100 });
    const { readManyBatchSize: _batchSize, ...defaultTarget } = target;
    const ids = Array.from({ length: 101 }, (_, index) => `version-${index}`);
    const rows = ids.map((versionId) => ({ id: versionId, versionId }));
    const execute = vi.fn(async (_operation, input) => (input as { ids: string[] }).ids
      .map((id) => ({ id, versionId: null, title: "Title" })));
    await expect(resolveDisplayLabels([parent, defaultTarget], "document", rows, { execute }, "array"))
      .resolves.toMatchObject({ shape: "array", labels: Array(101).fill("Title") });
    expect(execute.mock.calls.map(([, input]) => input)).toEqual([{ ids: ids.slice(0, 100) }, { ids: ids.slice(100) }]);
  });

  it("skips decoration when the Resource has no computed display or the result is absent", async () => {
    const { target, resources } = fixture();
    const { getDisplay: _display, ...plainTarget } = target;
    const execute = vi.fn();
    validateDisplays([plainTarget]);
    await expect(resolveDisplayLabels([plainTarget], target.id, { id: "plain", title: "Title" }, { execute })).resolves.toBeUndefined();
    await expect(resolveDisplayLabels(resources, "document", undefined, { execute })).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [false, undefined],
    [[null], "array"],
    [[[]], "array"],
    [{ items: [null] }, "list"],
    [{ items: "not a list" }, "list"],
  ] as const)("rejects a non-record result at the display boundary (case %#)", async (data, shape) => {
    const { resources } = fixture();
    const execute = vi.fn();
    await expect(resolveDisplayLabels(resources, "document", data, { execute }, shape)).rejects.toThrow("Invalid Atlas display records.");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["invalid", [null], [[]]])("rejects malformed readMany output before calling the formatter (%j)", async (data) => {
    const format = vi.fn(() => "label");
    const { resources } = fixture({ select: { related: { relation: "versionId", field: "title" } }, format }, { permissiveReadMany: true });
    const execute = vi.fn(async () => data);
    await expect(resolveDisplayLabels(resources, "document", { id: "document", versionId: "related" }, { execute }))
      .rejects.toThrow("Invalid Atlas display readMany output.");
    expect(format).not.toHaveBeenCalled();
  });

  it("falls back for an empty label and rejects non-string formatter output", async () => {
    const blank = fixture({ select: {}, format: () => "" });
    const execute = vi.fn();
    await expect(resolveDisplayLabels(blank.resources, "document", { id: 17 }, { execute }))
      .resolves.toStrictEqual({ shape: "record", labels: ["17"] });
    const broken = fixture({ select: {}, format: vi.fn().mockReturnValue(3) });
    await expect(resolveDisplayLabels(broken.resources, "document", { id: "a" }, { execute }))
      .rejects.toThrow("Atlas display format must return a string or undefined synchronously.");
    expect(execute).not.toHaveBeenCalled();
  });

  it("never decorates an absent relation with an unidentifiable readMany row", async () => {
    const { resources } = fixture({
      select: { label: { relation: "versionId", field: "title" } },
      format: ({ label }) => typeof label === "string" ? label : undefined,
    }, { permissiveReadMany: true });
    const execute = vi.fn(async () => [{ title: "unidentified" }, { id: "version", title: "Linked title" }]);
    const rows = [{ id: "linked", versionId: "version" }, { id: "orphan" }];
    await expect(resolveDisplayLabels(resources, "document", rows, { execute })).resolves.toStrictEqual({
      shape: "array", labels: ["Linked title", "orphan"],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("only uses records returned for identifiers in that authorized batch", async () => {
    const { resources, many } = fixture({
      select: { label: { relation: "versionId", field: "title" } },
      format: ({ label }) => typeof label === "string" ? label : undefined,
    }, { batchSize: 1, permissiveReadMany: true });
    const execute = vi.fn()
      .mockResolvedValueOnce([{ id: "shown", title: "Shown title" }, { id: "hidden", title: "Unrequested title" }])
      .mockResolvedValueOnce([]);
    const rows = [{ id: "first", versionId: "shown" }, { id: "second", versionId: "hidden" }];
    await expect(resolveDisplayLabels(resources, "document", rows, { execute })).resolves.toStrictEqual({
      shape: "array", labels: ["Shown title", "second"],
    });
    expect(execute.mock.calls).toEqual([[many, { ids: ["shown"] }], [many, { ids: ["hidden"] }]]);
  });

  it.each([0, -1, 0.5, Infinity, NaN])("rejects an invalid target batch size before executing a lookup (%s)", async (readManyBatchSize) => {
    const { parent, target } = fixture();
    const execute = vi.fn(async () => { throw new Error("ReadMany must not run for an invalid batch size"); });
    await expect(resolveDisplayLabels([parent, { ...target, readManyBatchSize }], "document", {
      id: "doc", versionId: "version",
    }, { execute })).rejects.toThrow("Atlas readManyBatchSize must be a positive safe integer.");
    expect(execute).not.toHaveBeenCalled();
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

  it("rejects missing targets, multi-value relations, and computed fields as raw display inputs", () => {
    const format = () => "label";
    expect(() => validateDisplays([fixture().parent])).toThrow("Invalid Atlas display relation on document.versionId.");
    expect(() => validateDisplays(fixture(undefined, { cardinality: "many" }).resources))
      .toThrow("Invalid Atlas display relation on document.versionId.");
    expect(() => validateDisplays(fixture({ select: { self: "__atlas_display" }, format }).resources))
      .toThrow("Invalid Atlas display dependency on document.");
    expect(() => validateDisplays(fixture({
      select: { computed: { relation: "versionId", field: "__atlas_display" } }, format,
    }, { targetDisplay: { select: { raw: "title" }, format } }).resources))
      .toThrow("Invalid Atlas display relation on document.versionId.");
  });

  it("truncates graphemes and counts the ellipsis within the limit", () => {
    expect(truncateText("👨‍👩‍👧‍👦abcd", { maxLength: 3 })).toBe("👨‍👩‍👧‍👦a…");
    expect(truncateText("abc", { maxLength: 3 })).toBe("abc");
    expect(truncateText("ab", { maxLength: 1 })).toBe("…");
    expect(() => truncateText("abc", { maxLength: 0 })).toThrow("maxLength");
  });
});
