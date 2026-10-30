import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { defineAction } from "../actions/index.js";
import { defineAtlasResource, defineCatalogAtlasSource } from "./index.js";

function resource(href?: (record: { id: string; slug: string }) => string | undefined, label = "Open public page") {
  const row = z.object({ id: z.string(), slug: z.string() });
  const read = defineAction({ name: "links.read", input: z.object({ id: z.string() }), output: row.nullable(), handler: () => null });
  const list = defineAction({ name: "links.list", input: z.object({}), output: z.object({ items: z.array(row) }), handler: () => ({ items: [] }) });
  const readMany = defineAction({ name: "links.readMany", input: z.object({ ids: z.array(z.string()) }), output: z.array(row), handler: () => [] });
  const source = defineCatalogAtlasSource({ id: "links", actions: { read, list, readMany } });
  return defineAtlasResource({
    id: "space", label: "Spaces", identity: "id", source,
    capabilities: { read: source.query(read), list: source.query(list), readMany: source.query(readMany) },
    recordLinks: {
      "public-page": { label, href: (record) => {
        expectTypeOf(record).toEqualTypeOf<{ id: string; slug: string }>();
        // Unknown read-output fields must remain compile-time errors.
        // @ts-expect-error The read output has no unknownField.
        void record.unknownField;
        return href ? href(record) : `/spaces/${encodeURIComponent(record.slug)}`;
      } },
      hidden: { label: "Hidden", href: () => undefined },
    },
  });
}

describe("Atlas record links", () => {
  it("requires nonempty labels and synchronous builders", () => {
    expect(() => resource(undefined, " ")).toThrow("label cannot be empty");
    // @ts-expect-error Async builders are outside the synchronous contract.
    resource(async () => "/spaces/test");
  });

  it("resolves ordered, conditional links without changing record or manifest", () => {
    const item = resource();
    const read = item.getOperationExposures().find(({ id }) => id.endsWith(":read"))!;
    const record = { id: "1", slug: "hello/world" };
    expect(read.resolveRecordLinks?.(record)).toEqual([{ id: "public-page", label: "Open public page", href: "/spaces/hello%2Fworld" }]);
    expect(record).toEqual({ id: "1", slug: "hello/world" });
    expect(JSON.stringify(item.toManifest())).not.toContain("public-page");
    expect(item.getOperationExposures().filter((exposure) => exposure.resolveRecordLinks)).toHaveLength(1);
  });

  it("does not invoke builders for missing records", () => {
    const href = vi.fn(() => "/spaces/test");
    const read = resource(href).getOperationExposures().find(({ id }) => id.endsWith(":read"))!;
    expect(read.resolveRecordLinks?.(null)).toEqual([]);
    expect(read.resolveRecordLinks?.(undefined)).toEqual([]);
    expect(href).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)", "//external.test", "/\\external.test", "https://example.test/\npath", "", "ftp://example.test"])("rejects unsafe URL %j", (url) => {
    const read = resource(() => url).getOperationExposures().find(({ id }) => id.endsWith(":read"))!;
    expect(() => read.resolveRecordLinks?.({ id: "1", slug: "test" })).toThrow("invalid URL");
  });

  it.each(["https://example.test/spaces/test", "http://localhost/spaces/test"])("accepts HTTP URL %j", (url) => {
    const read = resource(() => url).getOperationExposures().find(({ id }) => id.endsWith(":read"))!;
    expect(read.resolveRecordLinks?.({ id: "1", slug: "test" })[0]?.href).toBe(url);
  });

  it("propagates builder errors", () => {
    const read = resource(() => { throw new Error("builder failed"); }).getOperationExposures().find(({ id }) => id.endsWith(":read"))!;
    expect(() => read.resolveRecordLinks?.({ id: "1", slug: "test" })).toThrow("builder failed");
  });
});
