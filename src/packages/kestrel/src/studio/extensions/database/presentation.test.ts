import { expect, it } from "vitest";

import { compactDatabaseLabel, formatDatabaseColumnType } from "./presentation.js";

it.each([
  ["timestamp with time zone", "timestamptz"],
  ["timestamp(12) with time zone[][]", "timestamptz(12)[][]"],
  ["timestamp without time zone", "timestamp"],
  ["timestamp(12) without time zone[][]", "timestamp(12)[][]"],
  ["time with time zone", "timetz"],
  ["time(12) with time zone[][]", "timetz(12)[][]"],
  ["time without time zone", "time"],
  ["time(12) without time zone[][]", "time(12)[][]"],
  ["character varying", "varchar"],
  ["character varying(255)[][]", "varchar(255)[][]"],
  ["double precision", "float8"],
  ["double precision[][]", "float8[][]"],
] as const)("formats the complete PostgreSQL type %s", (type, label) => {
  expect(formatDatabaseColumnType(type)).toBe(label);
});

it.each([
  "timestamp with time zone", "timestamp without time zone",
  "time with time zone", "time without time zone", "character varying", "double precision",
])("preserves unrelated custom type labels containing %s", (type) => {
  expect(formatDatabaseColumnType(`custom ${type}`)).toBe(`custom ${type}`);
  expect(formatDatabaseColumnType(`${type} label`)).toBe(`${type} label`);
});

it("preserves labels that exactly fit and truncates at a Unicode code-point boundary", () => {
  expect(compactDatabaseLabel("a🧪b", 3)).toBe("a🧪b");
  expect(compactDatabaseLabel("a🧪bc", 3)).toBe("a🧪…");
});
