import { expect, it } from "vitest";
import { filterDatabaseLayout } from "./filter.js";
import type { StudioDatabaseLayout } from "./contract.js";

const mixedLayout: StudioDatabaseLayout = { schemas: [
  { name: "mixed", tables: [
    { name: "internal", kind: "table", origin: "framework", columns: [] },
    { name: "note", kind: "table", columns: [] },
  ] },
  { name: "dev", tables: [{ name: "log", kind: "table", origin: "framework", columns: [] }] },
  { name: "custom", tables: [{ name: "log", kind: "table", columns: [] }] },
  { name: "drizzle", tables: [{ name: "__drizzle_migrations", kind: "table", columns: [] }] },
] };

it("filters only tagged tables, drops empty schemas and preserves mixed/unknown tables", () => {
  expect(filterDatabaseLayout(mixedLayout, false)).toBe(mixedLayout);
  const filtered = filterDatabaseLayout(mixedLayout, true);
  expect(filtered.schemas.map((schema) => [schema.name, schema.tables.map((table) => table.name)])).toEqual([
    ["mixed", ["note"]], ["custom", ["log"]],
  ]);
  expect(mixedLayout.schemas[0]?.tables).toHaveLength(2);
  expect(filterDatabaseLayout({ schemas: [mixedLayout.schemas[1]!] }, true).schemas).toEqual([]);
});

it("excludes the exact Drizzle schema only while filtering and retains similarly named application objects", () => {
  const layout: StudioDatabaseLayout = { schemas: [
    { name: "drizzle", tables: [{ name: "__drizzle_migrations", kind: "table", columns: [] }] },
    { name: "drizzle_app", tables: [{ name: "__drizzle_migrations", kind: "table", columns: [] }] },
  ] };
  expect(filterDatabaseLayout(layout, false).schemas).toHaveLength(2);
  expect(filterDatabaseLayout(layout, true).schemas.map((schema) => schema.name)).toEqual(["drizzle_app"]);
});
