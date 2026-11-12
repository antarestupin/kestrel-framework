import { describe, expect, it } from "vitest";

import type { StudioDatabaseLayout } from "./contract.js";
import { createDatabaseDiagramLayout } from "./schema_layout.js";

/** Uneven table heights exercise the same packing used by both renderers. */
const layout: StudioDatabaseLayout = { schemas: ["identity", "audit"].map((name) => ({
  name,
  tables: Array.from({ length: 12 }, (_, index) => ({
    name: `record_${index}`, kind: "table" as const,
    columns: Array.from({ length: index % 2 === 0 ? 16 : 4 }, (_, column) => ({
      name: `column_${column}`, type: "text", nullable: false, primaryKey: column === 0,
    })),
  })),
})) };

describe("shared database diagram geometry", () => {
  it("reserves enough width for a long schema heading even with no tables", () => {
    const diagram = createDatabaseDiagramLayout({ schemas: [{ name: "schema_" + "x".repeat(55), tables: [] }] });
    expect(diagram.groups[0]).toMatchObject({ x: 0, y: 0, width: 484, tables: [] });
    expect(diagram.width).toBe(484);
  });

  it("packs unequal blocks across both axes with deterministic gaps and size overrides", () => {
    const table = (name: string, count: number, type = "text", column = "value") => ({
      name, kind: "table" as const,
      columns: Array.from({ length: count }, () => ({
        name: column, type, nullable: false, primaryKey: false,
      })),
    });
    const diagram = createDatabaseDiagramLayout({ schemas: [
      { name: "compact", tables: [table("tiny", 1)] },
      { name: "wide", tables: [table("n".repeat(48), 1)] },
      { name: "tall", tables: [table("messages", 13), table("deliveries", 2), table("history", 2)] },
      { name: "empty", tables: [] },
      { name: "other", tables: [table("other", 2)] },
      { name: "matrix", tables: [table("data", 2, "timestamp(3) with time zone[]", `column_${"n".repeat(45)}`)] },
    ] }, { tableWidthExtra: 10, groupHeaderHeight: 28, tableHeaderHeight: 20, rowHeight: 18 });
    expect({ width: diagram.width, height: diagram.height }).toEqual({ width: 620, height: 492 });
    expect(diagram.groups.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
      { x: 230, y: 330, width: 214, height: 82 },
      { x: 230, y: 232, width: 390, height: 82 },
      { x: 0, y: 0, width: 214, height: 442 },
      { x: 230, y: 428, width: 204, height: 64 },
      { x: 230, y: 116, width: 214, height: 100 },
      { x: 230, y: 0, width: 384, height: 100 },
    ]);
    expect(diagram.groups[2]?.tables.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
      { x: 12, y: 28, width: 190, height: 258 },
      { x: 12, y: 298, width: 190, height: 60 },
      { x: 12, y: 370, width: 190, height: 60 },
    ]);
    expect(diagram.groups.map(({ color }) => color)).toEqual([
      "#2563eb", "#0f766e", "#9333ea", "#b45309", "#be123c", "#2563eb",
    ]);
  });

  it("reflows measured comments without overlapping tables or schema groups", () => {
    const diagram = createDatabaseDiagramLayout(layout, {
      minimumTableWidth: 300,
      measurements: { "table-0-0": 900, "schema-0": 120 },
    });
    const first = diagram.groups[0]!;
    expect(first.tables[0]?.y).toBeGreaterThanOrEqual(132);
    expect(first.tables[0]?.height).toBe(900);
    for (const group of diagram.groups) {
      expect(group.x + group.width).toBeLessThanOrEqual(diagram.width);
      expect(group.y + group.height).toBeLessThanOrEqual(diagram.height);
      group.tables.forEach((node, index) => {
        expect(node.y + node.height).toBeLessThan(group.height);
        expect(node.x + node.width).toBeLessThan(group.width);
        for (const other of group.tables.slice(index + 1)) {
          expect(node.x < other.x + other.width && node.x + node.width > other.x
            && node.y < other.y + other.height && node.y + node.height > other.y).toBe(false);
        }
      });
    }
    const second = diagram.groups[1]!;
    expect(first.x < second.x + second.width && first.x + first.width > second.x
      && first.y < second.y + second.height && first.y + first.height > second.y).toBe(false);
    // Closing comments returns to the original deterministic layout.
    const collapsed = createDatabaseDiagramLayout(layout);
    expect(collapsed.groups[0]!.tables[0]!.height).toBeLessThan(900);
    expect(collapsed.groups[0]!.tables[0]!.y).toBeLessThan(first.tables[0]!.y);
  });
});
