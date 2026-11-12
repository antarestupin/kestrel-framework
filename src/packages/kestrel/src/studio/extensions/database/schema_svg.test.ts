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
    expect(svg).toContain('<title id="schema-0-title">public</title>');
    expect(svg).toMatch(/<desc id="diagram-description">2 tables grouped into 2 schemas\./u);
    expect(svg).toMatch(/<\/g>\s*<g id="schema-1"/u);
    expect(svg).toMatch(/<\/g>\s*<\/svg>$/u);
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
    expect(svg).toContain("&lt;/title&gt;&lt;script&gt;bad()&lt;/script&gt;</title>");
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
    const emptyDiagram = renderDatabaseSchemaSvg({ schemas: [] });
    const height = Number(/viewBox="0 0 \d+ (\d+)"/u.exec(emptyDiagram)?.[1]);
    expect(emptyDiagram).toContain(`<text x="20" y="${height - 20}" font-family="system-ui, sans-serif" font-size="12" fill="#475569">No application tables found.</text>`);
    const emptySchema = renderDatabaseSchemaSvg({ schemas: [{ name: "empty", tables: [] }] });
    expect(emptySchema).toContain("No tables");
    expect(emptySchema).not.toMatch(/NaN|Infinity/);
    const svg = renderDatabaseSchemaSvg({ schemas: [{ name: "public", tables: [
      { name: "marker", kind: "partitioned-table", columns: [] }, table("member"),
    ] }] });

    expect(svg).toContain('<text x="7" y="35" fill="#64748b">No columns</text>');
    expect(svg).toContain("partitioned");
    expect(svg).toContain("0 foreign keys");
    expect(svg).toMatch(/<\/g>\s*<g id="table-0-1"/u);
    expect(svg).toContain(">2 tables</text>");
    expect(svg).toMatch(/<\/g>\s*<\/g>\s*<\/g>\s*<\/g>\s*<\/svg>$/u);
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it("does not split an astral character at the label truncation boundary", () => {
    const prefix = "x".repeat(46);
    const name = `${prefix}🧪more`;
    const svg = renderDatabaseSchemaSvg({ schemas: [{ name: "lab", tables: [table(name)] }] });

    expect(svg).toContain(`>${prefix}🧪…</text>`);
    expect(svg).toContain(`<title>lab.${name}</title>`);
  });

  it("renders accessible labels, partitioned tables, and both row states", () => {
    const name = "a".repeat(48);
    const svg = renderDatabaseSchemaSvg({ schemas: [{
      name: "public", description: "Research & test",
      tables: [{ ...table(name), kind: "partitioned-table", description: "Quoted 'name' and <labels>", foreignKeys: [{
        name: "fk_parent", columns: ["parent_id"], referencedSchema: "public",
        referencedTable: name, referencedColumns: ["id"],
      }] }],
    }] });

    expect(svg).toContain('aria-labelledby="diagram-title diagram-description"');
    expect(svg).toMatch(/<desc id="diagram-description">1 tables? grouped into 1 schemas?\. 1 foreign keys?\./u);
    expect(svg).toContain('<title id="schema-0-title">public\nResearch &amp; test</title>');
    expect(svg).toContain(`<title>public.${name} (partitioned)\nQuoted &apos;name&apos; and &lt;labels&gt;</title>`);
    expect(svg).toContain(`>${name}</text>`);
    const frame = /<rect class="database-schema-frame" width="(\d+)"/u.exec(svg);
    expect(svg).toContain(`<text x="${Number(frame?.[1]) - 12}" y="19" text-anchor="end" font-family="system-ui, sans-serif" font-size="10" fill="#64748b">1 table</text>`);
    expect(svg).toContain('<rect x="1" y="1" width="354" height="23"');
    const rows = svg.split(/<g id="table-0-0-column-\d+">/u).slice(1);
    expect(rows).toHaveLength(3);
    expect(svg).toMatch(/<\/g>\s*<g id="table-0-0-column-1">/u);
    expect(rows[0]).toContain("tenant_id: uuid; not null");
    expect(rows[0]).toContain('y="24" width="354"');
    expect(rows[0]).toContain('height="16" fill="#fff"');
    expect(rows[0]).toContain('<text x="6" y="35"');
    expect(rows[0]).toContain('<text x="38" y="35" fill="#0f172a">tenant_id</text>');
    expect(rows[0]).toContain('<text x="349" y="35" text-anchor="end" fill="#64748b">uuid</text>');
    expect(rows[0]).toContain(">PK</text>");
    expect(rows[0]).not.toContain(">PK FK</text>");
    expect(rows[1]).toContain('y="40"');
    expect(rows[1]).toContain('height="16" fill="#f1f5f9"');
    expect(rows[1]).toContain('y="51"');
    expect(rows[2]).toContain(">FK</text>");
    expect(rows[2]).toContain('<rect x="1" y="56" width="354" height="16" fill="#fff"/>');
    expect(rows[2]).toContain("parent_id: uuid; nullable\nfk_parent:");
    expect(svg).not.toMatch(/No tables|No columns|No application tables/);
  });
});
