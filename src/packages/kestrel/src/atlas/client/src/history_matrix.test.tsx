import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
    expect(html.indexOf("#1")).toBeLessThan(html.indexOf("#3"));
  });
});
