import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "../actions/index.js";
import { atlasHistoryInputSchema, atlasHistoryOutputSchema } from "./history.js";
import { defineAtlas, defineAtlasResource, defineCatalogAtlasSource } from "./index.js";

function fixture() {
  const read = defineAction({ name: "entry.read", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }).nullable(), handler: () => null });
  const list = defineAction({ name: "entry.list", input: z.object({}), output: z.array(z.object({ id: z.string() })), handler: () => [] });
  const readMany = defineAction({ name: "entry.many", input: z.object({ ids: z.array(z.string()) }), output: z.array(z.object({ id: z.string() })), handler: () => [] });
  const history = defineAction({ name: "entry.history", input: atlasHistoryInputSchema, output: atlasHistoryOutputSchema, handler: () => ({ fields: [], events: [], nextCursor: null }) });
  const source = defineCatalogAtlasSource({ id: "example", actions: { read, list, readMany, history } });
  const options = { id: "entry", label: "Entries", identity: "id", source, capabilities: { read: source.query(read), list: source.query(list), readMany: source.query(readMany) } };
  return { options, history, source };
}
describe("Atlas history capability", () => {
  it("validates and snapshots one global actor Resource without changing default manifests", () => {
    const { options } = fixture();
    const resources = [defineAtlasResource(options)];
    expect(defineAtlas({ resources }).getManifest().history).toBeUndefined();
    expect(() => defineAtlas({ resources, history: { actor: { resource: "missing" } } })).toThrow("not registered");
    const history = { actor: { resource: "entry" } };
    const atlas = defineAtlas({ resources, history });
    history.actor.resource = "changed";
    expect(atlas.getManifest().history).toEqual({ actor: { resource: "entry" } });
  });
  it("exposes only explicitly configured history through the standard query gateway", async () => {
    const { options, source, history } = fixture();
    expect(defineAtlasResource(options).getOperationExposures().some((item) => item.id.endsWith(":history"))).toBe(false);
    const resource = defineAtlasResource({ ...options, capabilities: { ...options.capabilities, history: source.query(history) } });
    expect(resource.toManifest().capabilities.history?.effect).toBe("read");
    const exposure = resource.getOperationExposures().find((item) => item.id === "resource:entry:history")!;
    expect(await exposure.reference.execute({ id: "1", pageSize: 20 }, { execute: async () => ({ fields: [], events: [], nextCursor: null }) })).toMatchObject({ data: { events: [] } });
    expect(() => defineAtlasResource({ ...options, capabilities: { ...options.capabilities, history: source.action(history) } })).toThrow("Query");
  });
  it("rejects unbounded and out-of-range requests", () => {
    for (const input of [{ id: "1", pageSize: 101 }, { id: "1", before: "9223372036854775808" }, { id: "1", before: "abc" }]) {
      expect(atlasHistoryInputSchema.safeParse(input).success).toBe(false);
    }
  });
});
