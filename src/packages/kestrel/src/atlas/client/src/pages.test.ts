import { Menu } from "@base-ui/react/menu";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  hasAtlasFormContent,
  hasHorizontallyHiddenContentToRight,
  createScopedCollectionQuery,
  getNextSorting,
  OperationInput,
  PageHeader,
  OperationControl,
  readFormValue,
  RecordLinks,
  RecordLinkItem,
} from "./pages.js";
import type { AtlasFieldManifest } from "../../contract.js";

describe("atlas record Action dialogs", () => {
  it("distinguishes empty form values from user-entered content", () => {
    expect(hasAtlasFormContent([undefined, null, "", false, []]))
      .toBe(false);
    expect(hasAtlasFormContent([undefined, "Destination space"]))
      .toBe(true);
    expect(hasAtlasFormContent([0])).toBe(true);
    expect(hasAtlasFormContent([["first"]])).toBe(true);
  });
});

describe("atlas table overflow", () => {
  it("shows the sticky-column shadow only while content remains to the right", () => {
    expect(hasHorizontallyHiddenContentToRight(800, 800, 0)).toBe(false);
    expect(hasHorizontallyHiddenContentToRight(1200, 800, 0)).toBe(true);
    expect(hasHorizontallyHiddenContentToRight(1200, 800, 250)).toBe(true);
    expect(hasHorizontallyHiddenContentToRight(1200, 800, 400)).toBe(false);
    expect(hasHorizontallyHiddenContentToRight(1200, 800, 399)).toBe(false);
    expect(hasHorizontallyHiddenContentToRight(1200, 800, 399.5)).toBe(false);
  });
});

describe("atlas collection sorting", () => {
  it("cycles sorting and preserves ordered criteria only when appending", () => {
    expect(getNextSorting([], "name", false)).toEqual([
      { field: "name", direction: "asc" },
    ]);
    expect(getNextSorting([
      { field: "email", direction: "asc" },
      { field: "name", direction: "asc" },
    ], "name", true)).toEqual([
      { field: "email", direction: "asc" },
      { field: "name", direction: "desc" },
    ]);
    expect(getNextSorting([
      { field: "email", direction: "asc" },
      { field: "name", direction: "desc" },
    ], "name", true)).toEqual([
      { field: "email", direction: "asc" },
    ]);
  });
});

describe("atlas scoped collections", () => {
  it("leaves an unscoped query free of synthetic filters", () => {
    const query = { pagination: { type: "page" as const, page: 2, pageSize: 10 } };
    expect(createScopedCollectionQuery(query, [])).toStrictEqual(query);
  });

  it("keeps parent filters ahead of user-controlled collection filters", () => {
    const query = {
      pagination: { type: "page" as const, page: 2, pageSize: 10 },
      filters: [{ field: "topic", operator: "contains" as const, value: "AI" }],
    };

    expect(createScopedCollectionQuery(query, [{
      field: "authorId",
      operator: "equals",
      value: "user-1",
    }])).toEqual({
      ...query,
      filters: [
        { field: "authorId", operator: "equals", value: "user-1" },
        { field: "topic", operator: "contains", value: "AI" },
      ],
    });
    expect(query.filters).toEqual([
      { field: "topic", operator: "contains", value: "AI" },
    ]);
  });
});

describe("atlas operation forms", () => {
  it("applies page title truncation and omits an unused actions container", () => {
    const plain = renderToStaticMarkup(createElement(PageHeader, { eyebrow: "Record", title: "A long title" }));
    expect(plain).not.toContain("heading-actions");
    expect(plain).toContain("A long title");
    const withActions = renderToStaticMarkup(createElement(PageHeader, {
      eyebrow: "Record", title: "A long title", textMaxLength: 4, actions: createElement("button", {}, "Edit"),
    }));
    expect(withActions).toContain('class="heading-actions"><button>Edit</button>');
    expect(withActions).toContain("A l…");
  });

  it.each([
    ["email", { type: "string", format: "email" }, "ada@example.test", "email"],
    ["due", { type: "string", format: "date" }, "2026-11-12", "date"],
    ["estimate", { type: "number" }, 2.5, "number"],
    ["count", { type: "integer" }, 0, "number"],
    ["title", { type: "string" }, "Ada", "text"],
  ] as const)("renders the standard %s input with its value and constraint", (id, schema, value, type) => {
    const html = renderToStaticMarkup(createElement(OperationInput, {
      definition: { id, schema, required: true }, value,
    }));
    expect(html).toContain(`type="${type}"`);
    expect(html).toContain(`value="${value}"`);
    expect(html).toContain("required");
    expect(html).toContain(" *</span>");
    if (schema.type === "number") expect(html).toContain('step="any"');
    if (schema.type === "integer") expect(html).not.toContain('step="any"');
  });

  it("renders checked booleans and uses required only for the true literal", () => {
    const input = (schema: { type: string; const?: boolean }, required: boolean, value: boolean) =>
      renderToStaticMarkup(createElement(OperationInput, { definition: { id: "enabled", schema, required }, value }));
    expect(input({ type: "boolean" }, true, true)).toContain('checked=""');
    expect(input({ type: "boolean" }, true, false)).not.toMatch(/checked|required/);
    expect(input({ type: "boolean", const: true }, true, false)).toContain('required=""');
    expect(input({ type: "boolean", const: true }, false, true)).not.toContain('required=""');
  });

  it.each(["longDescription", "bodyContent"])("renders %s as multiline input", (id) => {
    const html = renderToStaticMarkup(createElement(OperationInput, {
      definition: { id, required: false, schema: { type: "string" } }, value: "Draft",
    }));
    expect(html).toMatch(/<textarea[^>]+rows="5"[^>]*>Draft<\/textarea>/);
    expect(html).not.toContain(" *</span>");
  });

  it("roundtrips an ISO date-time through the browser's local time control", () => {
    const instant = new Date("2026-11-12T18:22:45.123Z");
    const local = new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
    const definition = { id: "startsAt", required: true, schema: { type: "string", format: "date-time" } };
    const html = renderToStaticMarkup(createElement(OperationInput, { definition, value: instant.toISOString() }));
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain(`value="${local}"`);
    expect(html).toContain('step="any"');
    const form = new FormData();
    form.append("startsAt", local);
    expect(readFormValue(form, definition)).toBe(instant.toISOString());
    form.set("startsAt", "unparseable");
    expect(readFormValue(form, definition)).toBe("unparseable");
  });

  it.each([
    [true, null],
    [false, undefined],
    [{ type: "null" }, null],
    [{ type: ["integer", "boolean"] }, undefined],
    [{ anyOf: [{ type: "null" }, { type: "string" }] }, null],
    [{ oneOf: [{ type: "boolean" }, { type: "null" }, { type: "integer" }] }, null],
    [{ anyOf: [{ type: "string" }, true] }, undefined],
  ] as const)("coerces an explicitly cleared relation for schema %j", (schema, result) => {
    const relation = { relation: { cardinality: "one" } } as AtlasFieldManifest;
    const form = new FormData();
    form.set("owner", "");
    expect(readFormValue(form, { id: "owner", schema, required: false }, relation)).toBe(result);
    form.delete("owner");
    expect(readFormValue(form, { id: "owner", schema, required: false }, relation)).toBeUndefined();
  });

  it("retains every submitted identifier for array relation inputs", () => {
    const form = new FormData();

    form.append("reviewerIds", "user-1");
    form.append("reviewerIds", "user-2");

    expect(readFormValue(form, {
      id: "reviewerIds",
      required: true,
      schema: { type: "array", items: { type: "string" } },
    })).toEqual(["user-1", "user-2"]);
  });

  it("preserves invalid numeric relation input without serializing it as a clear", () => {
    const single = { id: "owner", required: false, schema: { type: ["integer", "null"] } };
    const multiple = { id: "reviewers", required: false, schema: { type: "array", items: { type: "integer" } } };
    const relation = { relation: { cardinality: "one" } } as AtlasFieldManifest;
    const form = new FormData();
    form.set(single.id, "Infinity");
    form.append(multiple.id, "0");
    form.append(multiple.id, "not-a-number");
    form.append(multiple.id, "-Infinity");
    const input = {
      owner: readFormValue(form, single, relation),
      reviewers: readFormValue(form, multiple),
    };
    // An explicit null clears an optional relation, while invalid text must reach validation.
    expect(JSON.parse(JSON.stringify(input))).toStrictEqual({
      owner: "Infinity", reviewers: [0, "not-a-number", "-Infinity"],
    });
  });

  it("coerces populated nullable numeric inputs without guessing ambiguous unions", () => {
    const form = new FormData();
    form.append("count", "42");
    form.append("memberIds", "3");
    form.append("memberIds", "4");

    expect(readFormValue(form, {
      id: "count", required: false, schema: { type: ["integer", "null"] },
    })).toBe(42);
    expect(readFormValue(form, {
      id: "memberIds", required: false,
      schema: { anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }] },
    })).toEqual([3, 4]);
    expect(readFormValue(form, {
      id: "count", required: false, schema: { type: ["integer", "string", "null"] },
    })).toBe("42");
  });

  it("keeps unconstrained arrays and distinguishes required from absent optional values", () => {
    const form = new FormData();
    form.append("tags", "one");
    form.append("tags", new File(["ignored"], "note.txt"));
    form.append("tags", "");
    form.append("note", "");
    form.append("nullable", "literal");
    expect(readFormValue(form, { id: "tags", required: true, schema: { type: "array", items: true } })).toEqual(["one"]);
    expect(readFormValue(form, { id: "note", required: true, schema: { type: "string" } })).toBe("");
    expect(readFormValue(form, { id: "note", required: false, schema: { type: "string" } })).toBeUndefined();
    const optionalText = { id: "note", required: false, schema: { type: ["string", "null"] } } as const;
    expect(readFormValue(form, optionalText)).toBeUndefined();
    expect(readFormValue(form, optionalText, {
      id: "note", label: "Note", kind: "text", schema: optionalText.schema,
      hidden: false, readOnly: false, searchable: false, sortable: false, filterOperators: [],
    })).toBeUndefined();
    expect(readFormValue(form, { id: "missing", required: true, schema: { type: "string" } })).toBeNull();
    expect(readFormValue(form, { id: "nullable", required: true, schema: {
      oneOf: [{ type: "integer" }, { type: "string" }, { type: "null" }],
    } })).toBe("literal");
  });

  it("renders usable default controls when no icon is specified", () => {
    const control = (effect: "write" | "destructive") => renderToStaticMarkup(createElement(OperationControl, {
      label: "Run", operation: { id: "example", sourceId: "app", effect, inputs: [] }, pending: false,
    }));
    const destructive = control("destructive");
    const write = control("write");
    expect(destructive).toContain("Run");
    expect(write).toContain("Run");
    expect(destructive).toContain("<svg");
    expect(write).toContain("<svg");
    expect(destructive).not.toBe(write);
    const pending = renderToStaticMarkup(createElement(OperationControl, {
      label: "Pending", operation: { id: "example", sourceId: "app", effect: "write", inputs: [] }, pending: true,
    }));
    expect(pending).toContain('disabled=""');
    expect(pending).toContain("spin");
  });
});

describe("Atlas record link navigation", () => {
  it("groups even a single link behind one menu trigger and omits empty menus", () => {
    for (const count of [1, 50]) {
      const links = Array.from({ length: count }, (_, index) => ({ id: `link-${index}`, label: `Open page ${index}`, href: `/spaces/${index}` }));
      const html = renderToStaticMarkup(createElement(RecordLinks, { links }));
      expect(html).toContain("Links");
      expect(html).toContain('aria-haspopup="menu"');
      expect(html.match(/<button/g)).toHaveLength(1);
      expect(html).not.toContain("Open page");
    }
    expect(renderToStaticMarkup(createElement(RecordLinks, { links: [] }))).toBe("");
  });

  it("keeps menu entries as native links opening protected new tabs", () => {
    const html = renderToStaticMarkup(createElement(Menu.Root, { defaultOpen: true },
      createElement(RecordLinkItem, {
        link: { id: "public-page", label: "Open public page", href: "/spaces/test" },
      }),
    ));
    expect(html).toContain('<a ');
    expect(html).toContain('role="menuitem"');
    expect(html).toContain('href="/spaces/test"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open public page");
  });
});
