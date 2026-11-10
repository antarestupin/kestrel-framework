import { describe, expect, it } from "vitest";

import { collectionFilterOperatorSchema, createCollectionQueryInputSchema } from "./collection.js";

// Keep this explicit public allowlist independent from the schema implementation.
const operators = [
  "contains", "equals", "greater-than", "greater-than-or-equal", "in", "is-not-null",
  "is-null", "less-than", "less-than-or-equal", "not-equals", "not-in", "starts-with",
] as const;

describe("collection action input contracts", () => {
  it.each(operators)("accepts the documented %s filter operator", (operator) => {
    expect(collectionFilterOperatorSchema.parse(operator)).toBe(operator);
    const filter = { field: "name", operator, value: "Ada" };
    expect(createCollectionQueryInputSchema().parse({ filters: [filter] }).filters).toEqual([filter]);
  });

  for (const mode of ["typed", "json", "repeated-json"] as const) {
    it(`preserves collection fields supplied as ${mode}`, () => {
      const search = { term: "Ada" };
      const filters = [{ field: "name", operator: "contains", value: "Ada" }, { field: "deletedAt", operator: "is-null" }];
      const sort = [{ field: "name", direction: "desc" }, { field: "id", direction: "asc" }];
      const value = mode === "typed" ? { search, filters, sort }
        : mode === "json" ? { search: JSON.stringify(search), filters: JSON.stringify(filters), sort: JSON.stringify(sort) }
          : { search: JSON.stringify(search), filters: filters.map((filter) => JSON.stringify(filter)), sort: sort.map((criterion) => JSON.stringify(criterion)) };
      expect(createCollectionQueryInputSchema().parse(value)).toStrictEqual({
        pagination: { type: "page", page: 1, pageSize: 20 }, search, filters, sort,
      });
    });
  }

  it("rejects empty or unsupported filter and sort fields without changing the allowlist", () => {
    const schema = createCollectionQueryInputSchema();
    for (const operator of ["", "unsupported", "CONTAINS"]) {
      expect(collectionFilterOperatorSchema.safeParse(operator).success).toBe(false);
    }
    for (const value of [
      { filters: [{ field: "", operator: "equals" }] },
      { sort: [{ field: "", direction: "asc" }] },
      { sort: [{ field: "name", direction: "unsupported" }] },
    ]) expect(schema.safeParse(value).success).toBe(false);
  });

  for (const field of ["search", "filters", "sort"] as const) {
    it(`reports malformed ${field} JSON as a structured custom validation issue`, () => {
      const result = createCollectionQueryInputSchema().safeParse({ [field]: "{" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0]!;
        expect(issue.path).toEqual([field]);
        // The union retains each candidate's errors: malformed wire JSON is a custom
        // decoding issue, rather than silently falling through as an undefined value.
        expect(issue.code).toBe("invalid_union");
        if (issue.code === "invalid_union") {
          expect(issue.errors.flat()).toContainEqual(expect.objectContaining({ code: "custom" }));
        }
      }
    });
  }
});
