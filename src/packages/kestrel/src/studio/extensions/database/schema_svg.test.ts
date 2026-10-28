import { describe, expect, it } from "vitest";

import type { StudioDatabaseLayout, StudioDatabaseTable } from "./contract.js";
import { renderDatabaseSchemaSvg } from "./schema_svg.js";

/** Small fixtures expose column pairing and routes without a database connection. */
function table(name: string): StudioDatabaseTable {
  return {
    name,
    kind: "table",
    columns: [
      { name: "tenant_id", type: "uuid", nullable: false, primaryKey: true },
      { name: "id", type: "uuid", nullable: false, primaryKey: true },
      { name: "parent_id", type: "uuid", nullable: true, primaryKey: false },
    ],
  };
}

describe("renderDatabaseSchemaSvg", () => {
  it("draws composite cross-schema and self references at their column rows", () => {
    const member = table("member");
    const layout: StudioDatabaseLayout = { schemas: [
      { name: "public", tables: [{ ...member, foreignKeys: [
        {
          name: "team_fk", columns: ["tenant_id", "parent_id"],
          referencedSchema: "organization", referencedTable: "team",
          referencedColumns: ["tenant_id", "id"],
        },
        {
          name: "parent_fk", columns: ["parent_id"],
          referencedSchema: "public", referencedTable: "member", referencedColumns: ["id"],
        },
      ] }] },
      { name: "organization", tables: [table("team")] },
    ] };

    const svg = renderDatabaseSchemaSvg(layout);

    expect(svg).toContain("2 foreign keys");
    expect(svg.match(/marker-end=/g)).toHaveLength(3);
    expect(svg).toContain("team_fk: public.member.tenant_id → organization.team.tenant_id");
    expect(svg).toContain("team_fk: public.member.parent_id → organization.team.id");
    expect(svg).toContain("parent_fk: public.member.parent_id → public.member.id");
    expect(svg).toContain('href="#table-1-column-1"');
    expect(svg).toContain('href="#table-0-column-1"');
    expect(svg).toContain("PK FK");
    expect(svg).toContain("parent_id ?");
    expect(svg).toContain('d="M 404 268 H 425 V 240 H 404"');
    expect(svg).not.toMatch(/NaN|undefined/);
    expect(renderDatabaseSchemaSvg(layout)).toBe(svg);
  });

  it("escapes catalog values without allowing markup or invalid XML characters", () => {
    const svg = renderDatabaseSchemaSvg({ schemas: [{ name: 'a&"b', tables: [{
      name: "<script>alert('table')</script>",
      description: "</title><script>bad()</script>\u0000",
      kind: "table",
      columns: [{ name: "<id>", type: 'custom."<type>"', description: "A & B", nullable: false, primaryKey: true }],
    }] }] });

    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("a&amp;&quot;b");
    expect(svg).toContain("A &amp; B");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("\u0000");
    expect(svg).not.toMatch(/<foreignObject|<style|<image|(?:href|src)="https?:\/\//);
  });

  it("keeps qualified names distinct and skips missing tables or columns", () => {
    const source: StudioDatabaseTable = { ...table("c"), foreignKeys: [
      { name: "valid", columns: ["parent_id"], referencedSchema: "a", referencedTable: "b.c", referencedColumns: ["id"] },
      { name: "missing_table", columns: ["id"], referencedSchema: "hidden", referencedTable: "c", referencedColumns: ["id"] },
      { name: "missing_column", columns: ["absent"], referencedSchema: "a", referencedTable: "b.c", referencedColumns: ["id"] },
    ] };
    const svg = renderDatabaseSchemaSvg({ schemas: [
      { name: "a.b", tables: [source] },
      { name: "a", tables: [table("b.c")] },
    ] });

    expect(svg).toContain("1 foreign keys");
    expect(svg.match(/marker-end=/g)).toHaveLength(1);
    expect(svg).toContain('href="#table-1-column-1"');
    expect(svg).not.toContain("missing_table:");
    expect(svg).not.toContain("missing_column:");
  });

  it("supports empty layouts, zero-column tables and sources without foreign keys", () => {
    expect(renderDatabaseSchemaSvg({ schemas: [] })).toContain("No application tables found.");
    const svg = renderDatabaseSchemaSvg({ schemas: [{ name: "public", tables: [
      { name: "marker", kind: "partitioned-table", columns: [] }, table("member"),
    ] }] });

    expect(svg).toContain("No columns");
    expect(svg).toContain("partitioned");
    expect(svg).toContain("0 foreign keys");
    expect(svg).not.toMatch(/NaN|undefined/);
  });
});
