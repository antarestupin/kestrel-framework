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
  readFormValue,
} from "./pages.js";

describe("atlas record Action dialogs", () => {
  it("distinguishes empty form values from user-entered content", () => {
    expect(hasAtlasFormContent([undefined, null, "", false, []]))
      .toBe(false);
    expect(hasAtlasFormContent([undefined, "Destination space"]))
      .toBe(true);
    expect(hasAtlasFormContent([0])).toBe(true);
  });
});

describe("atlas table overflow", () => {
  it("shows the sticky-column shadow only while content remains to the right", () => {
    expect(hasHorizontallyHiddenContentToRight(800, 800, 0)).toBe(false);
    expect(hasHorizontallyHiddenContentToRight(1200, 800, 0)).toBe(true);
    expect(hasHorizontallyHiddenContentToRight(1200, 800, 250)).toBe(true);
    expect(hasHorizontallyHiddenContentToRight(1200, 800, 400)).toBe(false);
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
});
