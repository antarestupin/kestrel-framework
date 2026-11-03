import { describe, expect, it } from "vitest";
import type { AtlasManifest, AtlasResourceManifest, AtlasFieldManifest } from "../../contract.js";
import type { AtlasHistoryPage } from "../../history.js";
import { createHistoryRelationContext } from "./history_relations.js";
import { createRelationHydrationRequests } from "./relations.js";

const relation = { id: "authorId", hidden: false, relation: { resource: "person", cardinality: "one", optional: true } } as AtlasFieldManifest;
const resource = { id: "article", fields: [relation] } as unknown as AtlasResourceManifest;
const target = { id: "person" } as AtlasResourceManifest;
const manifest = { history: { actor: { resource: "person" } }, resources: [resource, target] } as unknown as AtlasManifest;
const event = (actor: string | null, values = {}): AtlasHistoryPage["events"][number] => ({
  sequence: "1", changedAt: "2026-11-03T00:00:00Z", operation: "update", actor, reason: null, values,
});
describe("history actor hydration", () => {
  it("merges repeated actors and business relations in one target request without mutating history", () => {
    const events = [event("p1", { authorId: "p2" }), event("p2"), event("p1"), event(null)];
    const context = createHistoryRelationContext(manifest, resource, ["authorId"], events);
    const requests = createRelationHydrationRequests(manifest, context.resource, context.records);
    expect(requests.map((request) => [request.resource.id, request.ids])).toEqual([["person", ["p2", "p1"]]]);
    expect(events[0]?.values).toEqual({ authorId: "p2" });
    expect(context.actorField?.relation?.resource).toBe("person");
  });
  it("avoids synthetic key collisions and ignores hidden business relations", () => {
    const context = createHistoryRelationContext(manifest, {
      ...resource, fields: [{ ...relation, hidden: true }, { ...relation, id: "__atlas_history_actor" }],
    }, ["authorId"], [event("p1", { authorId: "hidden" })]);
    expect(context.actorField?.id).toBe("__atlas_history_actor_");
    expect(createRelationHydrationRequests(manifest, context.resource, context.records)[0]?.ids).toEqual(["p1"]);
  });
  it("keeps unconfigured actors out of hydration and skips absent actors", () => {
    const plain = { ...manifest, history: {} };
    const context = createHistoryRelationContext(plain, resource, [], [event("raw")]);
    expect(context.actorField).toBeUndefined();
    expect(createRelationHydrationRequests(plain, context.resource, context.records)).toEqual([]);
    const anonymous = createHistoryRelationContext(manifest, resource, [], [event(null)]);
    expect(createRelationHydrationRequests(manifest, anonymous.resource, anonymous.records)).toEqual([]);
  });
});
