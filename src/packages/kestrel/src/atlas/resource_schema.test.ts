import { describe, expect, it, vi } from "vitest";
import { z, type ZodType } from "zod";

import { defineAction } from "../actions/index.js";
import { defineAtlasResource, type AtlasResourceOptions } from "./resource.js";
import { defineCatalogAtlasSource } from "./source.js";

const identity = z.object({ id: z.string() });
const list = defineAction({
  name: "schema.list", input: z.object({}),
  output: z.object({ items: z.array(identity) }),
  handler: () => ({ items: [] }),
});
const readMany = defineAction({
  name: "schema.readMany", input: z.object({ ids: z.array(z.string()) }),
  output: z.array(identity), handler: () => [],
});

function makeOptions(output: ZodType = identity, input: ZodType = identity): AtlasResourceOptions {
  const read = defineAction({ name: "schema.read", input, output, handler: () => ({ id: "record" }) });
  const source = defineCatalogAtlasSource({ id: "schema", actions: { list, read, readMany } });
  return {
    id: "sample", label: "Samples", identity: "id", source,
    capabilities: { list: source.collectionQuery(list), read: source.query(read), readMany: source.query(readMany) },
  };
}

describe("Atlas Resource schema presentation", () => {
  it("finds a usable object in oneOf and preserves the schemas for its fields", () => {
    // Zod metadata can provide an exact JSON Schema when its own conversion is too broad.
    const output = z.any().meta({
      oneOf: [null, [], false, { type: "null" }, {
        type: "object", properties: {
          id: { type: "string" },
          contact2Email: { type: "string", format: "email" },
          reviewedAt: {},
          DateReminder: { type: "string" },
          effective__from: { type: "string", format: "date" },
          budget: { type: "number" },
          opaque: true,
          impossible: false,
          malformed: [1, 2],
          "___": { type: "string" },
        },
      }],
    });
    const input = z.any().meta({
      oneOf: [false, {
        type: "object", properties: { id: { type: "string" }, extra: true },
        required: ["id", 1, null],
      }],
    });
    const manifest = defineAtlasResource(makeOptions(output, input)).toManifest();
    expect(manifest.fields.map(({ id, kind, label, schema }) => [id, kind, label, schema])).toEqual([
      ["id", "id", "Id", { type: "string" }],
      ["contact2Email", "email", "Contact2 Email", { type: "string", format: "email" }],
      ["reviewedAt", "datetime", "Reviewed At", {}],
      ["DateReminder", "text", "Date Reminder", { type: "string" }],
      ["effective__from", "date", "Effective from", { type: "string", format: "date" }],
      ["budget", "number", "Budget", { type: "number" }],
      ["opaque", "json", "Opaque", true],
      ["impossible", "json", "Impossible", false],
      ["malformed", "json", "Malformed", {}],
      ["___", "text", "___", { type: "string" }],
    ]);
    expect(manifest.capabilities.read.inputs).toEqual([
      { id: "id", required: true, schema: { type: "string" } },
      { id: "extra", required: false, schema: true },
    ]);
  });

  it("handles absent or malformed structural metadata without losing valid resource labels", () => {
    const unknownInput = z.string();
    const noRequiredList = z.any().meta({
      type: "object", properties: { id: { type: "string" } }, required: "id",
    });
    const invalidRead = z.any().meta({ type: "object", properties: null });
    const options = makeOptions(identity, noRequiredList);
    const manifest = defineAtlasResource(options).toManifest();
    expect(manifest.labelSingular).toBe("Sample");
    expect(manifest.capabilities.read.inputs).toEqual([{ id: "id", required: false, schema: { type: "string" } }]);
    const equipment = defineAtlasResource({ ...makeOptions(identity, unknownInput), label: "Equipment" }).toManifest();
    expect(equipment.labelSingular).toBe("Equipment");
    expect(equipment.capabilities.read.inputs).toEqual([]);
    expect(() => defineAtlasResource(makeOptions(invalidRead)).toManifest()).toThrow(
      'Atlas resource "sample" identity "id" does not exist in its read output.',
    );
  });

  it("retains usable fields from unrepresentable Zod values and falls back for unavailable outputs", () => {
    const output = identity.extend({ updatedAt: z.date(), opaque: z.date(), quantity: z.number() });
    const options = makeOptions(output);
    const notify = defineAction({ name: "schema.notify", input: identity, handler: () => null });
    const unavailable = defineAction({
      name: "schema.unavailable", input: identity,
      output: z.lazy(() => { throw new Error("Unavailable JSON Schema"); }),
      handler: () => { throw new Error("Metadata only"); },
    });
    const actions = defineCatalogAtlasSource({ id: options.source.id, actions: { notify, unavailable } });
    const manifest = defineAtlasResource({
      ...options,
      recordActions: {
        notify: { label: "Notify", recordInput: "id", action: actions.action(notify) },
        unavailable: { label: "Unavailable", recordInput: "id", action: actions.action(unavailable) },
      },
    }).toManifest();
    expect(manifest.fields.map(({ id, kind, schema }) => [id, kind, schema])).toEqual([
      ["id", "id", { type: "string" }],
      ["updatedAt", "datetime", {}],
      ["opaque", "json", {}],
      ["quantity", "number", { type: "number" }],
    ]);
    expect(manifest.recordActions.map(({ id, action }) => [id, action.outputSchema]))
      .toEqual([["notify", expect.objectContaining({ type: "null" })], ["unavailable", {}]]);
  });

  it("skips record link builders for missing records and omits undefined links", () => {
    const omitted = vi.fn(() => undefined);
    const present = vi.fn((record: unknown) => `/samples/${identity.parse(record).id}`);
    const resource = defineAtlasResource({
      ...makeOptions(),
      recordLinks: { omitted: { label: "Omitted", href: omitted }, present: { label: "Present", href: present } },
    });
    const resolve = resource.getOperationExposures().find(({ id }) => id === "resource:sample:read")!.resolveRecordLinks!;
    expect(resolve(null)).toEqual([]);
    expect(resolve(undefined)).toEqual([]);
    expect(omitted).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
    expect(resolve({ id: "current" })).toEqual([{ id: "present", label: "Present", href: "/samples/current" }]);
    expect(omitted).toHaveBeenCalledWith({ id: "current" });
  });

  it.each([
    "https://", "relative/https://example.test", "https://example.test/two words",
    "https://example.test\\ignored", 42,
  ])("reports the declared link that produced an invalid value %j", (href) => {
    const resource = defineAtlasResource({
      ...makeOptions(),
      recordLinks: { detail: { label: "Details", href: () => href as string } },
    });
    const resolve = resource.getOperationExposures().find(({ id }) => id === "resource:sample:read")!.resolveRecordLinks!;
    expect(() => resolve({ id: "current" })).toThrow('Atlas record link "detail" returned an invalid URL.');
    if (href === "https://") {
      expect(() => resolve({ id: "current" })).toThrow(expect.objectContaining({ cause: expect.any(TypeError) }));
    }
  });
});
