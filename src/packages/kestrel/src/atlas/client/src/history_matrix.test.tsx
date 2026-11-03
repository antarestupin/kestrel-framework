import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AtlasRendererRegistryProvider } from "./renderer_registry.js";
import { resolveRelationReferences, resolveRelationValue } from "./relations.js";
import type { AtlasManifest } from "../../contract.js";
import { createHistoryRelationContext } from "./history_relations.js";
import { HistoryTable } from "./history_matrix.js";
import type { AtlasResourceManifest } from "../../contract.js";

// The renderer consumes only field labels and visibility from the resource.
const resource = { fields: [{ id: "title", label: "Title" }, { id: "secret", hidden: true }] } as unknown as AtlasResourceManifest;
describe("history matrix", () => {
  it("renders explicit NULL, empty strings and unchanged cells distinctly, with escaped content", () => {
    const html = renderToStaticMarkup(<HistoryTable resource={resource} fields={["title", "secret"]} events={[
      { sequence: "1", changedAt: "2026-10-01Z", operation: "insert", actor: null, reason: null, values: { title: "" } },
      { sequence: "2", changedAt: "2026-10-02Z", operation: "update", actor: "<script>", reason: "Correction", values: { title: null } },
      { sequence: "3", changedAt: "2026-10-03Z", operation: "delete", actor: null, reason: null, values: {} },
    ]} />);
    expect(html).toContain("&quot;&quot;");
    expect(html).toContain("<pre>NULL</pre>");
    expect(html).toContain("<td></td>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("secret");
    // Metadata is readable immediately rather than hidden in disclosure controls.
    expect(html).toContain('<tbody class="history-metadata">');
    expect(html).toContain('scope="row">Actor');
    expect(html).toContain('scope="row">Reason');
    expect(html).toContain("Correction");
    expect(html).toContain("Unknown");
    expect(html).toContain("Not provided");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<caption");
    expect(html).toContain('scope="row">Title');
    expect(html).not.toContain("#1");
    expect(html).not.toContain("#2");
    expect(html).not.toContain("#3");
    expect(html).toContain('dateTime="2026-10-01Z"');
    expect(html).toContain("<div>update</div>");
    expect(html.indexOf("<div>insert</div>")).toBeLessThan(html.indexOf("<div>delete</div>"));
  });
});

// Custom renderers and relation labels must match the normal list presentation.
describe("history field presentation", () => {
  it("uses the Resource field renderer and computed relation display labels", () => {
    const origin = { ...resource, id: "article", fields: [
      { id: "title", label: "Title", kind: "text" },
      { id: "topicId", label: "Topic", kind: "relation", relation: { resource: "topic", cardinality: "one" } },
    ] } as unknown as AtlasResourceManifest;
    const target = { id: "topic", identity: "id", displayField: "__atlas_display" } as AtlasResourceManifest;
    const manifest = { resources: [origin, target] } as unknown as AtlasManifest;
    const loaded = new Map([["topic", [{ id: "t1", __atlas_display: "Current topic title" }]]]);
    const html = renderToStaticMarkup(<AtlasRendererRegistryProvider registries={{ fields: {
      "article.title": ({ value }) => <mark>{String(value).toUpperCase()}</mark>,
    } }}><HistoryTable resource={origin} fields={["title", "topicId"]} basePath="/atlas" relations={{
      error: undefined, isPending: false,
      resolve: (field, value) => resolveRelationValue(field, value, loaded, target),
      references: (field, value) => resolveRelationReferences(manifest, field, value, loaded),
    }} events={[{ sequence: "1", changedAt: "2026-10-01Z", operation: "update", actor: null, reason: null, values: { title: "New title", topicId: "t1" } }]} /></AtlasRendererRegistryProvider>);
    expect(html).toContain("<mark>NEW TITLE</mark>");
    expect(html).toContain('href="/atlas/topic/t1"');
    expect(html).toContain("Current topic title");
  });
});

// Actor presentation follows the globally selected application Resource.
describe("history actor presentation", () => {
  it("uses computed labels and links, preserves unknown actors and falls back for deleted targets", () => {
    const target = { id: "person", identity: "id", displayField: "__atlas_display" } as AtlasResourceManifest;
    const manifest = { history: { actor: { resource: "person" } }, resources: [resource, target] } as unknown as AtlasManifest;
    const events = ["p1", "gone", null].map((actor, index) => ({ sequence: String(index), changedAt: "2026-11-03T00:00:00Z", operation: "update" as const, actor, reason: null, values: {} }));
    const context = createHistoryRelationContext(manifest, resource, [], events);
    const loaded = new Map([["person", [{ id: "p1", __atlas_display: "Ada <Admin>" }]]]);
    const html = renderToStaticMarkup(<HistoryTable resource={resource} fields={[]} events={events}
      actorField={context.actorField!} basePath="/atlas" relations={{
        error: undefined, isPending: false,
        resolve: (field, value) => resolveRelationValue(field, value, loaded, target),
        references: (field, value) => resolveRelationReferences(manifest, field, value, loaded),
      }} />);
    expect(html).toContain('href="/atlas/person/p1"');
    expect(html).toContain("Ada &lt;Admin&gt;");
    expect(html).toContain(">gone</a>");
    expect(html).toContain("Unknown");
  });
});
