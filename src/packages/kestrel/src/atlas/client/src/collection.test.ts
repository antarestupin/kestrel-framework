import { describe, expect, it } from "vitest";

import {
  parseAtlasCollectionSearch,
  serializeAtlasCollectionSearch,
} from "./collection.js";

describe("atlas collection URL state", () => {
  it("round-trips search, flat filters, ordered sorting and pagination", () => {
    const query = parseAtlasCollectionSearch({
      page: "3",
      pageSize: "10",
      q: "Ada",
      filters: JSON.stringify([
        { field: "email", operator: "contains", value: "example.com" },
      ]),
      sort: "name:asc,email:desc",
    });

    expect(query).toEqual({
      pagination: { type: "page", page: 3, pageSize: 10 },
      search: "Ada",
      filters: [
        { field: "email", operator: "contains", value: "example.com" },
      ],
      sorting: [
        { field: "name", direction: "asc" },
        { field: "email", direction: "desc" },
      ],
    });
    expect(serializeAtlasCollectionSearch(query)).toEqual({
      page: 3,
      pageSize: 10,
      q: "Ada",
      filters: JSON.stringify(query.filters),
      sort: "name:asc,email:desc",
    });
  });

  it("falls back safely when URL values are invalid", () => {
    expect(parseAtlasCollectionSearch({
      page: "zero",
      filters: "not-json",
      sort: "invalid",
    })).toEqual({
      pagination: { type: "page", page: 1, pageSize: 20 },
    });
  });
});
