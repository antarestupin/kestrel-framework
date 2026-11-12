import { describe, expect, it } from "vitest";

import {
  atlasCollectionQuerySchema,
  createResourceCollectionQuerySchema,
  mapAtlasCollectionQueryToCatalog,
} from "./collection.js";
import type { AtlasCollectionQuery, AtlasFieldManifest, AtlasFilterOperator } from "./contract.js";

const pagination = { type: "page", page: 1, pageSize: 12 } as const;
const fields: readonly AtlasFieldManifest[] = [
  { id: "owner", label: "Owner", kind: "text", schema: { type: "string" }, hidden: false,
    readOnly: false, searchable: false, filterOperators: ["in", "not-in", "is-null", "is-not-null"], sortable: false },
  { id: "name", label: "Name", kind: "text", schema: { type: "string" }, hidden: false,
    readOnly: false, searchable: true, filterOperators: ["contains", "equals"], sortable: true },
  { id: "title", label: "Title", kind: "text", schema: { type: "string" }, hidden: false,
    readOnly: false, searchable: false, filterOperators: [], sortable: true },
];

describe("portable Atlas collection queries", () => {
  it("accepts each published filter operator and both pagination boundaries", () => {
    const operators = [
      "contains", "equals", "greater-than", "greater-than-or-equal", "in", "is-not-null", "is-null",
      "less-than", "less-than-or-equal", "not-equals", "not-in", "starts-with",
    ] as const satisfies readonly AtlasFilterOperator[];
    const query = {
      pagination: { ...pagination, page: 2, pageSize: 100 },
      search: "needle",
      filters: operators.map((operator) => ({ field: "owner", operator, value: [1] })),
      sorting: [{ field: "name", direction: "asc" }, { field: "title", direction: "desc" }],
    };
    expect(atlasCollectionQuerySchema.parse(query)).toStrictEqual(query);
    expect(atlasCollectionQuerySchema.parse({ pagination: { ...pagination, pageSize: 1 } })).toStrictEqual({
      pagination: { ...pagination, pageSize: 1 },
    });
  });

  it.each([
    [{ pagination: { ...pagination, type: "cursor" } }, ["pagination", "type"]],
    [{ pagination: { ...pagination, page: 0 } }, ["pagination", "page"]],
    [{ pagination: { ...pagination, page: 1.5 } }, ["pagination", "page"]],
    [{ pagination: { ...pagination, pageSize: 0 } }, ["pagination", "pageSize"]],
    [{ pagination: { ...pagination, pageSize: 1.5 } }, ["pagination", "pageSize"]],
    [{ pagination: { ...pagination, pageSize: 101 } }, ["pagination", "pageSize"]],
    [{ search: 1 }, ["search"]],
    [{ filters: [{ field: "", operator: "equals" }] }, ["filters", 0, "field"]],
    [{ filters: [{ field: "name", operator: "unsupported" }] }, ["filters", 0, "operator"]],
    [{ sorting: [{ field: "", direction: "asc" }] }, ["sorting", 0, "field"]],
    [{ sorting: [{ field: "name", direction: "sideways" }] }, ["sorting", 0, "direction"]],
  ])("rejects the invalid portable query at %j", (override, path) => {
    const result = atlasCollectionQuerySchema.safeParse({ pagination, ...override });
    expect(result.error?.issues.map((issue) => issue.path)).toStrictEqual([path]);
  });

  it("maps search, filters and ordered sorting to the catalog contract", () => {
    const query: AtlasCollectionQuery = {
      pagination,
      search: " display term ",
      filters: [{ field: "name", operator: "equals", value: false }],
      sorting: [{ field: "title", direction: "desc" }, { field: "name", direction: "asc" }],
    };
    expect(mapAtlasCollectionQueryToCatalog(query)).toStrictEqual({
      pagination, search: { term: " display term " }, filters: query.filters, sort: query.sorting,
    });
    // An explicit empty list is preserved, while an empty search does not reach catalog storage.
    expect(mapAtlasCollectionQueryToCatalog({ pagination, search: "", filters: [], sorting: [] })).toStrictEqual({
      pagination, filters: [], sort: [],
    });
    expect(mapAtlasCollectionQueryToCatalog({ pagination })).toStrictEqual({ pagination });
  });
});

describe("Atlas Resource collection capabilities", () => {
  it("applies each exposure constraint independently and accepts its exact bounds", () => {
    const constrained = createResourceCollectionQuerySchema(fields, {
      firstPageOnly: true, maximumPageSize: 12, minimumSearchLength: 2,
    });
    expect(constrained.parse({ pagination, search: " ab " })).toStrictEqual({ pagination, search: " ab " });
    expect(constrained.safeParse({ pagination: { ...pagination, page: 2, pageSize: 13 }, search: " a " })
      .error?.issues).toStrictEqual([
      { path: ["pagination", "page"], message: "This collection exposure only supports its first page." },
      { path: ["pagination", "pageSize"], message: "This collection exposure supports at most 12 records per page." },
      { path: ["search"], message: "This collection exposure requires at least 2 search characters." },
    ].map((issue) => ({ code: "custom", ...issue })));
    expect(constrained.safeParse({ pagination }).error?.issues.map(({ path }) => path)).toStrictEqual([["search"]]);
    const open = createResourceCollectionQuerySchema(fields, { firstPageOnly: false, minimumSearchLength: 0 });
    expect(open.parse({ pagination: { ...pagination, page: 2, pageSize: 100 } })).toStrictEqual({
      pagination: { ...pagination, page: 2, pageSize: 100 },
    });
  });

  it("accepts declared filters and keeps the caller's ordered sorting", () => {
    const schema = createResourceCollectionQuerySchema(fields);
    const query: AtlasCollectionQuery = { pagination, filters: [
      { field: "name", operator: "equals", value: 0 },
      { field: "owner", operator: "in", value: ["one"] },
      { field: "owner", operator: "not-in", value: ["two"] },
      { field: "owner", operator: "is-null" },
      { field: "owner", operator: "is-not-null" },
    ], sorting: [{ field: "title", direction: "desc" }, { field: "name", direction: "asc" }] };
    expect(schema.parse(query)).toStrictEqual(query);
  });

  it("reports unsupported fields and operands at their own indices", () => {
    const schema = createResourceCollectionQuerySchema(fields.filter(({ searchable }) => !searchable));
    const result = schema.safeParse({ pagination, search: "unsupported", filters: [
      { field: "absent", operator: "equals" },
      { field: "owner", operator: "equals", value: 0 },
      { field: "owner", operator: "in", value: "one" },
      { field: "owner", operator: "not-in", value: [] },
      { field: "owner", operator: "not-in" },
    ], sorting: [
      { field: "owner", direction: "asc" }, { field: "title", direction: "desc" },
      { field: "title", direction: "asc" }, { field: "absent", direction: "asc" },
    ] });
    // The Atlas gateway returns these structured validation issues to the caller.
    expect(result.error?.issues).toStrictEqual([
      { path: ["search"], message: "This Resource does not support search." },
      { path: ["filters", 0], message: 'Filter "absent.equals" is not supported.' },
      { path: ["filters", 1], message: 'Filter "owner.equals" is not supported.' },
      { path: ["filters", 2, "value"], message: 'Filter "owner.in" requires a non-empty array.' },
      { path: ["filters", 3, "value"], message: 'Filter "owner.not-in" requires a non-empty array.' },
      { path: ["filters", 4, "value"], message: 'Filter "owner.not-in" requires a value.' },
      { path: ["filters", 4, "value"], message: 'Filter "owner.not-in" requires a non-empty array.' },
      { path: ["sorting", 0], message: 'Sorting by "owner" is not supported.' },
      { path: ["sorting", 2], message: 'Sorting field "title" is duplicated.' },
      { path: ["sorting", 3], message: 'Sorting by "absent" is not supported.' },
    ].map((issue) => ({ code: "custom", ...issue })));
  });
});
