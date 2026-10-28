import { describe, expect, it } from "vitest";

import type { StudioDatabaseLayout, StudioDatabaseTable } from "./contract.js";
import { renderDatabaseSchemaSvg } from "./schema_svg.js";

/** Small fixtures expose schema grouping and metadata without a database connection. */
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
  it("groups schemas while keeping composite and self references in column tooltips", () => {
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
    expect(svg).not.toContain("marker-end=");
    expect(svg).toContain("team_fk: (tenant_id, parent_id) → organization.team(tenant_id, id)");
    expect(svg).toContain("parent_fk: (parent_id) → public.member(id)");
    expect(svg.match(/class="database-schema-frame"/g)).toHaveLength(2);
    const sections = svg.split(/<g id="schema-\d+"/).slice(1);
    expect(sections[0]).toContain("public.member");
    expect(sections[0]).not.toContain('id="table-1-0"');
    expect(sections[1]).toContain("organization.team");
    expect(sections[1]).not.toContain('id="table-0-0"');
    expect(svg).toContain("PK FK");
    expect(svg).toContain("parent_id ?");
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

  it("keeps qualified names distinct and retains references outside the overview", () => {
    const source: StudioDatabaseTable = { ...table("c"), foreignKeys: [
      { name: "valid", columns: ["parent_id"], referencedSchema: "a", referencedTable: "b.c", referencedColumns: ["id"] },
      { name: "missing_table", columns: ["id"], referencedSchema: "hidden", referencedTable: "c", referencedColumns: ["id"] },
      { name: "missing_column", columns: ["absent"], referencedSchema: "a", referencedTable: "b.c", referencedColumns: ["id"] },
    ] };
    const svg = renderDatabaseSchemaSvg({ schemas: [
      { name: "a.b", tables: [source] },
      { name: "a", tables: [table("b.c")] },
    ] });

    expect(svg).toContain("3 foreign keys");
    expect(svg).toContain('id="table-0-0"');
    expect(svg).toContain('id="table-1-0"');
    expect(svg).toContain("missing_table: (id) → hidden.c(id)");
    expect(svg).not.toContain("missing_column:");
  });

  it("packs uneven schema groups and tables without overlaps or unused row bands", () => {
    const layout: StudioDatabaseLayout = { schemas: Array.from({ length: 8 }, (_, schema) => ({
      name: `schema_${schema}`,
      tables: Array.from({ length: schema === 0 ? 9 : 2 }, (_, index) => ({
        ...table(`table_${index}`),
        columns: Array.from({ length: index === 0 ? 16 : 3 }, (_, column) => ({
          name: `column_${column}`, type: "timestamp with time zone", nullable: false, primaryKey: column === 0,
        })),
      })),
    })) };
    const svg = renderDatabaseSchemaSvg(layout);
    const groups = [...svg.matchAll(/<g id="schema-\d+" transform="translate\((\d+) (\d+)\)"[^>]*>\s*<title[^>]*>[^<]*<\/title>\s*<rect class="database-schema-frame" width="(\d+)" height="(\d+)"/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }));
    expect(groups).toHaveLength(8);
    const bounds = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
    const width = Number(bounds[1]);
    const height = Number(bounds[2]);
    // This fixture should fit on an overview-sized canvas rather than a long strip.
    expect(width * height).toBeLessThan(1_600_000);
    groups.forEach((group, index) => {
      expect(group.x + group.width).toBeLessThanOrEqual(width);
      expect(group.y + group.height).toBeLessThanOrEqual(height);
      for (const other of groups.slice(index + 1)) {
        expect(group.x < other.x + other.width && group.x + group.width > other.x
          && group.y < other.y + other.height && group.y + group.height > other.y).toBe(false);
      }
      const section = svg.split(`<g id="schema-${index}"`)[1]!.split(/<g id="schema-\d+"/)[0]!;
      const tables = [...section.matchAll(/<g id="table-\d+-\d+" transform="translate\((\d+) (\d+)\)">\s*<title>[^<]*<\/title>\s*<rect class="database-table-frame" width="(\d+)" height="(\d+)"/g)]
        .map((match) => ({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }));
      expect(tables).toHaveLength(layout.schemas[index]!.tables.length);
      tables.forEach((node, tableIndex) => {
        expect(node.x + node.width).toBeLessThan(group.width);
        expect(node.y + node.height).toBeLessThan(group.height);
        for (const other of tables.slice(tableIndex + 1)) {
          expect(node.x < other.x + other.width && node.x + node.width > other.x
            && node.y < other.y + other.height && node.y + node.height > other.y).toBe(false);
        }
      });
    });
  });

  it("shortens SQL types and long labels while keeping complete tooltip values", () => {
    const name = "an_unusually_long_column_name_that_should_stay_in_the_tooltip";
    const svg = renderDatabaseSchemaSvg({ schemas: [{ name: "public", tables: [{
      ...table("member"),
      columns: [
        { name, type: "timestamp(3) with time zone[]", primaryKey: false, nullable: false },
        { name: "label", type: "character varying(255)", primaryKey: false, nullable: true },
      ],
    }] }] });

    expect(svg).toContain(">timestamptz(3)[]</text>");
    expect(svg).toContain(">varchar(255)</text>");
    expect(svg).toContain(`${name}: timestamp(3) with time zone[]; not null`);
    expect(svg).not.toContain(`>${name}</text>`);
    expect(svg).toContain("…</text>");
  });

  it("keeps a large schema balanced instead of producing a narrow vertical strip", () => {
    const svg = renderDatabaseSchemaSvg({ schemas: [{
      name: "public",
      tables: Array.from({ length: 48 }, (_, index) => table(`record_${index}`)),
    }] });
    const bounds = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
    expect(Number(bounds[1]) / Number(bounds[2])).toBeGreaterThan(0.7);
    expect(Number(bounds[1]) / Number(bounds[2])).toBeLessThan(1.5);
    expect(svg.match(/class="database-table-frame"/g)).toHaveLength(48);
  });

  it("supports empty layouts, zero-column tables and sources without foreign keys", () => {
    expect(renderDatabaseSchemaSvg({ schemas: [] })).toContain("No application tables found.");
    const emptySchema = renderDatabaseSchemaSvg({ schemas: [{ name: "empty", tables: [] }] });
    expect(emptySchema).toContain("No tables");
    expect(emptySchema).not.toMatch(/NaN|Infinity/);
    const svg = renderDatabaseSchemaSvg({ schemas: [{ name: "public", tables: [
      { name: "marker", kind: "partitioned-table", columns: [] }, table("member"),
    ] }] });

    expect(svg).toContain("No columns");
    expect(svg).toContain("partitioned");
    expect(svg).toContain("0 foreign keys");
    expect(svg).not.toMatch(/NaN|undefined/);
  });
});
