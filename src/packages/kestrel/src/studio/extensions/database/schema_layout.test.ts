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
