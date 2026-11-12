import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasConfirmationProvider } from "./confirmation.js";
import { ResourceRead } from "./pages.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AtlasFieldManifest, AtlasManifest, AtlasResourceManifest } from "../../contract.js";
import { FieldValue } from "./field_value.js";
import { AtlasRendererRegistryProvider } from "./renderer_registry.js";
import { Icon } from "./ui/icon.js";

const field: AtlasFieldManifest = {
  id: "title", label: "Title", kind: "text", schema: { type: "string" },
  hidden: false, readOnly: true, searchable: false, filterOperators: [], sortable: false,
};
// Only the presentation metadata is used by the field renderer.
const resource: AtlasResourceManifest = {
  id: "example", label: "Examples", labelSingular: "Example", identity: "id",
  displayField: "title", sourceId: "application", fields: [field], views: [], recordActions: [],
  capabilities: {
    list: { id: "list", sourceId: "application", effect: "read", inputs: [] },
    read: { id: "read", sourceId: "application", effect: "read", inputs: [] },
    readMany: { id: "readMany", sourceId: "application", effect: "read", inputs: [] },
  },
};
const text = "A".repeat(51);

describe("Atlas list text presentation", () => {
  it("distinguishes absent values, zero and boolean values", () => {
    for (const value of [null, undefined, ""]) {
      expect(renderToStaticMarkup(<FieldValue field={field} value={value} />)).toContain('class="empty-value"');
    }
    expect(renderToStaticMarkup(<FieldValue field={{ ...field, kind: "number" }} value={0} />)).toBe("0");
    const flag = { ...field, kind: "boolean" } as const;
    expect(renderToStaticMarkup(<FieldValue field={flag} value={false} />))
      .toBe(`<span class="boolean-value false">${renderToStaticMarkup(<Icon name="cancel" />)}No</span>`);
    expect(renderToStaticMarkup(<FieldValue field={flag} value={true} />))
      .toBe(`<span class="boolean-value true">${renderToStaticMarkup(<Icon name="success" />)}Yes</span>`);
  });

  it("renders dates and structured values without losing invalid text or escaping", () => {
    const date = "2026-01-10T12:00:00Z";
    expect(renderToStaticMarkup(<FieldValue field={{ ...field, kind: "datetime" }} value={date} />))
      .toBe(new Date(date).toLocaleString());
    const day = "2026-01-10";
    expect(renderToStaticMarkup(<FieldValue field={{ ...field, kind: "date" }} value={day} />))
      .toBe(new Date(day).toLocaleString());
    expect(renderToStaticMarkup(<FieldValue field={{ ...field, kind: "date" }} value="invalid date" />)).toBe("invalid date");
    expect(renderToStaticMarkup(<FieldValue field={{ ...field, kind: "json" }} value={{ token: "<unsafe>" }} />))
      .toBe("<code>{&quot;token&quot;:&quot;&lt;unsafe&gt;&quot;}</code>");
  });

  it("renders related fallback values and limits links to records with a route", () => {
    const relation = { ...field, kind: "relation" } as const;
    const fallback = renderToStaticMarkup(<FieldValue field={relation} value={["first", "second"]} />);
    expect(fallback).toContain("<span>first</span><span>, second</span>");

    const references = [{ resourceId: "target", recordId: "t/1", label: "First" }, { resourceId: "target", label: "Missing" }];
    const links = renderToStaticMarkup(<FieldValue basePath="/" field={relation} value="t/1" relationReferences={references} />);
    expect(links).toContain('href="/target/t%2F1"');
    expect(links).toContain("<span>Missing</span>");
    expect(renderToStaticMarkup(<FieldValue field={relation} value="t/1" relationReferences={references} />)).not.toContain("href=");
  });

  it("limits lists to 50 graphemes including the ellipsis and retains the full tooltip", () => {
    expect(renderToStaticMarkup(<FieldValue context="list" field={field} value={text} />))
      .toBe(`<span title="${text}">${"A".repeat(49)}…</span>`);
    const boundary = "👩🏽‍💻".repeat(50);
    expect(renderToStaticMarkup(<FieldValue context="list" field={field} value={boundary} />)).toBe(boundary);
    expect(renderToStaticMarkup(<FieldValue context="list" field={field} value={boundary + "é"} />))
      .toContain("👩🏽‍💻".repeat(49) + "…");
  });

  it("inherits global limits and gives the containing resource precedence", () => {
    expect(renderToStaticMarkup(<FieldValue context="list" textMaxLength={4} field={field} value={text} />)).toContain(">AAA…</span>");
    expect(renderToStaticMarkup(<FieldValue context="list" textMaxLength={4} resource={{ ...resource, textMaxLength: 2 }} field={field} value={text} />)).toContain(">A…</span>");
    expect(renderToStaticMarkup(<FieldValue context="list" textMaxLength={false} field={field} value={text} />)).toBe(text);
    expect(renderToStaticMarkup(<FieldValue context="list" textMaxLength={4} resource={{ ...resource, textMaxLength: false }} field={field} value={text} />)).toBe(text);
    expect(renderToStaticMarkup(<FieldValue context="list" textMaxLength={false} resource={{ ...resource, textMaxLength: 1 }} field={field} value={text} />)).toContain(">…</span>");
  });

  it.each([undefined, "record", "history"] as const)("keeps full text in %s context", (context) => {
    expect(renderToStaticMarkup(<FieldValue {...(context === undefined ? {} : { context })} field={field} value={text} />)).toBe(text);
  });

  it("shortens relation labels individually while preserving their links", () => {
    const markup = renderToStaticMarkup(<FieldValue context="list" textMaxLength={4}
      basePath="/atlas" field={{ ...field, kind: "relation" }} value="id"
      relationReferences={[{ label: text, recordId: "id", resourceId: "target" }]} />);
    expect(markup).toContain('href="/atlas/target/id"');
    expect(markup).toContain(`<span title="${text}">AAA…</span>`);
  });

  it("keeps identifiers and custom renderer inputs intact", () => {
    expect(renderToStaticMarkup(<FieldValue context="list" field={{ ...field, kind: "id" }} value={text} />)).toBe(text);
    expect(renderToStaticMarkup(<AtlasRendererRegistryProvider registries={{ fields: { text: ({ value }) => <mark>{String(value)}</mark> } }}>
      <FieldValue context="list" field={field} value={text} />
    </AtlasRendererRegistryProvider>)).toBe(`<mark>${text}</mark>`);
    expect(renderToStaticMarkup(<AtlasRendererRegistryProvider registries={{ fields: { default: () => <mark>Fallback</mark> } }}>
      <FieldValue field={field} value={text} />
    </AtlasRendererRegistryProvider>)).toBe("<mark>Fallback</mark>");
  });

  it.each(["email", "relation"] as const)("shortens string values for the %s field family", (kind) => {
    expect(renderToStaticMarkup(<FieldValue context="list" field={{ ...field, kind }} value={text} />))
      .toBe(`<span title="${text}">${"A".repeat(49)}…</span>`);
  });

  it("preserves structured values when a text field receives a non-string", () => {
    expect(renderToStaticMarkup(<FieldValue context="list" field={field} value={{ name: "Ada" }} />))
      .toBe("<code>{&quot;name&quot;:&quot;Ada&quot;}</code>");
  });
});

// Exercise the actual record page so heading limits cannot leak into detail values.
describe("Atlas record label presentation", () => {
  it.each([
    [undefined, undefined, 50],
    [4, undefined, 4],
    [4, 2, 2],
    [false, 2, 2],
    [4, false, false],
    [false, undefined, false],
  ] as const)("resolves global %s and resource %s limits in record titles", (globalLimit, resourceLimit, expected) => {
    const target = { ...resource, ...(resourceLimit === undefined ? {} : { textMaxLength: resourceLimit }) };
    const manifest: AtlasManifest = {
      basePath: "/atlas", title: "Atlas", icons: {},
      defaults: { recordActionsInList: "all", textMaxLength: globalLimit ?? 50 },
      notifications: { position: "bottom-left" }, resources: [target],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData([target.id, "read", manifest.basePath, "record"], { data: { id: "record", title: text } });
    try {
      const markup = renderToStaticMarkup(<QueryClientProvider client={client}>
        <AtlasConfirmationProvider>
          <ResourceRead manifest={manifest} resource={target} recordId="record"
            onDeleted={() => {}} onEdit={() => {}} onOpenAction={() => {}}
            onEditRelated={() => {}} onOpenRelatedAction={() => {}} onOpenRelation={() => {}} />
        </AtlasConfirmationProvider>
      </QueryClientProvider>);
      const heading = expected === false ? text : `<span title="${text}">${"A".repeat(expected - 1)}…</span>`;
      expect(markup).toContain(`<h1>${heading}</h1>`);
      expect(markup).toContain(`<dd>${text}</dd>`);
      expect(client.getQueryData([target.id, "read", manifest.basePath, "record"])).toEqual({ data: { id: "record", title: text } });
    } finally {
      client.clear();
    }
  });
});
