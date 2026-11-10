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

// Exercise URL-shaped strings and direct router values without invoking browser components.
describe("atlas collection URL boundaries", () => {
  const invalidNumbers: ReadonlyArray<readonly [string, unknown]> = [
    ["numeric zero", 0], ["numeric negative", -1], ["numeric fraction", 1.5],
    ["string zero", "0"], ["string negative", "-1"], ["string fraction", "1.5"],
    ["empty string", ""], ["invalid string", "not-a-number"], ["null", null],
    ["undefined", undefined], ["boolean", true], ["array", [2]], ["object", {}],
    ["NaN", Number.NaN], ["infinity", Number.POSITIVE_INFINITY],
  ];

  for (const field of ["page", "pageSize"] as const) {
    it.each(invalidNumbers)(`defaults ${field} for %s`, (_label, value) => {
      expect(parseAtlasCollectionSearch({ [field]: value })).toEqual({
        pagination: { type: "page", page: 1, pageSize: 20 },
      });
    });

    it.each([1, 2, 73])(`accepts positive ${field} values as numbers and strings: %s`, (value) => {
      for (const input of [value, String(value)]) {
        expect(parseAtlasCollectionSearch({ [field]: input })).toEqual({
          pagination: { type: "page", page: 1, pageSize: 20, [field]: value },
        });
      }
    });
  }

  it("serializes defaults and explicit empty optional state as cleared URL entries", () => {
    const defaults = parseAtlasCollectionSearch({});
    const cleared = { page: undefined, pageSize: undefined, q: undefined, filters: undefined, sort: undefined };
    expect(serializeAtlasCollectionSearch(defaults)).toStrictEqual(cleared);
    expect(serializeAtlasCollectionSearch({ ...defaults, search: "", filters: [], sorting: [] })).toStrictEqual(cleared);
    expect(parseAtlasCollectionSearch(cleared)).toEqual(defaults);
    for (const q of ["", undefined, null, 1, false, {}]) {
      expect(parseAtlasCollectionSearch({ q })).toEqual(defaults);
    }
  });

  // All declared portable operators must survive URL decoding; Resource-specific policy is validated later.
  it.each([
    "contains", "equals", "greater-than", "greater-than-or-equal", "in",
    "is-not-null", "is-null", "less-than", "less-than-or-equal",
    "not-equals", "not-in", "starts-with",
  ] as const)("retains the %s filter operator", (operator) => {
    const filter = { field: "score", operator, ...(operator === "is-null" || operator === "is-not-null"
      ? {} : { value: operator === "in" || operator === "not-in" ? [1] : 1 }) };
    const decoded = parseAtlasCollectionSearch({ filters: JSON.stringify([filter]) });
    expect(decoded.filters).toEqual([filter]);
    expect(parseAtlasCollectionSearch(serializeAtlasCollectionSearch(decoded))).toEqual(decoded);
  });

  it("keeps valid filter entries while discarding malformed neighbors", () => {
    const accepted = { field: "name", operator: "equals", value: "Ada" };
    expect(parseAtlasCollectionSearch({ filters: JSON.stringify([
      null, 1, "invalid", [], {}, { field: 1, operator: "equals" },
      { field: "name", operator: 1 }, { field: "name", operator: "unsupported" }, accepted,
    ]) }).filters).toEqual([accepted]);
  });

  it("ignores non-string, invalid JSON and non-array filter payloads", () => {
    const encodedFilters = JSON.stringify([{ field: "name", operator: "equals", value: "Ada" }]);
    // Repeated query parameters can be arrays. JSON.parse would coerce a one-item
    // array into its valid JSON string, so enforce the URL value type before parsing.
    for (const filters of [undefined, null, 1, false, [], [encodedFilters], {}, "not-json", "null", "{}", "42", '"string"']) {
      expect(parseAtlasCollectionSearch({ filters })).toEqual({ pagination: { type: "page", page: 1, pageSize: 20 } });
    }
  });

  it("retains ordered sorting while dropping empty or malformed segments", () => {
    const decoded = parseAtlasCollectionSearch({
      sort: "name:asc,,score:desc,:asc,name:up,name:asc:extra,invalid,tail:desc",
    });
    expect(decoded.sorting).toEqual([
      { field: "name", direction: "asc" },
      { field: "score", direction: "desc" },
      { field: "tail", direction: "desc" },
    ]);
    expect(serializeAtlasCollectionSearch(decoded).sort).toBe("name:asc,score:desc,tail:desc");
    expect(parseAtlasCollectionSearch(serializeAtlasCollectionSearch(decoded))).toEqual(decoded);
  });

  it("omits sorting when its URL value has no valid criteria", () => {
    for (const sort of [undefined, null, 1, false, [], {}, "", ",", ":asc", "name", "name:ASC", "name:desc:extra"]) {
      expect(parseAtlasCollectionSearch({ sort })).toEqual({ pagination: { type: "page", page: 1, pageSize: 20 } });
    }
  });
});
