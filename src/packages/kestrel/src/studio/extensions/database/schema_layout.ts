import type { StudioDatabaseLayout, StudioDatabaseSchema, StudioDatabaseTable } from "./contract.js";
import { formatDatabaseColumnType } from "./presentation.js";

const GROUP_GAP = 16;
const INSET = 12;
const TABLE_GAP = 12;
const GROUP_HEADER = 34;
const TABLE_HEADER = 24;
const ROW = 16;
const COLORS = ["#2563eb", "#0f766e", "#9333ea", "#b45309", "#be123c"];

export interface TableNode {
  id: string;
  table: StudioDatabaseTable;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SchemaGroup {
  id: string;
  schema: StudioDatabaseSchema;
  color: string;
  tables: TableNode[];
  columnCount: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Optional HTML measurements keep expanded comments inside the shared geometry. */
export interface DatabaseDiagramOptions {
  minimumTableWidth?: number;
  tableWidthExtra?: number;
  tableHeaderHeight?: number;
  rowHeight?: number;
  groupHeaderHeight?: number;
  measurements?: Readonly<Record<string, number>>;
}

/** Browser-safe geometry shared by the SVG and the interactive HTML canvas. */
export function createDatabaseDiagramLayout(layout: StudioDatabaseLayout, options: DatabaseDiagramOptions = {}) {
  const groups = layout.schemas.map((schema, index) => positionSchemaTables(schema, index, options));
  return { groups, ...packSchemaGroups(groups) };
}

/** Keep each schema together and stack tables in the shortest available column. */
function positionSchemaTables(schema: StudioDatabaseSchema, schemaIndex: number, options: DatabaseDiagramOptions): SchemaGroup {
  const widths = schema.tables.map(tableWidth);
  const width = Math.max(options.minimumTableWidth ?? 180, ...widths.map((value) => value + (options.tableWidthExtra ?? 0)));
  const heights = schema.tables.map((table, index) => options.measurements?.[`table-${schemaIndex}-${index}`] ?? ((options.tableHeaderHeight ?? TABLE_HEADER) + Math.max(1, table.columns.length) * (options.rowHeight ?? ROW) + 4));
  const headerHeight = options.measurements?.[`schema-${schemaIndex}`] === undefined
    ? (options.groupHeaderHeight ?? GROUP_HEADER)
    : options.measurements[`schema-${schemaIndex}`]! + INSET;
  const totalHeight = heights.reduce((sum, height) => sum + height + TABLE_GAP, 0);
  // Near-square schema blocks pack well without forcing unrelated tables into rows.
  const columnCount = Math.max(1, Math.min(schema.tables.length, Math.round(Math.sqrt(totalHeight / width))));
  const bottoms = Array<number>(columnCount).fill(headerHeight);
  const tables = schema.tables.map((table, index): TableNode => {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const y = bottoms[column]!;
    const height = heights[index]!;
    bottoms[column] = y + height + TABLE_GAP;
    return { id: `table-${schemaIndex}-${index}`, table, x: INSET + column * (width + TABLE_GAP), y, width, height };
  });

  return {
    id: `schema-${schemaIndex}`,
    schema,
    color: COLORS[schemaIndex % COLORS.length]!,
    tables,
    columnCount,
    x: 0,
    y: 0,
    width: Math.max(INSET * 2 + columnCount * width + (columnCount - 1) * TABLE_GAP, compactDatabaseLabel(schema.name, 48).length * 8 + 100),
    height: Math.max(...bottoms) + (tables.length === 0 ? 24 : -TABLE_GAP) + INSET,
  };
}

/** Pack whole schema rectangles, filling spaces alongside taller groups first. */
function packSchemaGroups(groups: SchemaGroup[]) {
  const area = groups.reduce((sum, group) => sum + (group.width + GROUP_GAP) * (group.height + GROUP_GAP), 0);
  const targetWidth = Math.max(480, ...groups.map((group) => group.width), Math.ceil(Math.sqrt(area * 1.5)));
  const placed: SchemaGroup[] = [];

  for (const group of [...groups].sort((a, b) => b.height - a.height || b.width - a.width)) {
    const xs = [...new Set([0, ...placed.map((entry) => entry.x + entry.width + GROUP_GAP)])].sort((a, b) => a - b);
    const ys = [...new Set([0, ...placed.map((entry) => entry.y + entry.height + GROUP_GAP)])].sort((a, b) => a - b);
    // A candidate directly below every existing block always provides a fit.
    findPosition: for (const y of ys) {
      for (const x of xs) {
        if (x + group.width > targetWidth) continue;
        const overlaps = placed.some((entry) =>
          x < entry.x + entry.width + GROUP_GAP && x + group.width + GROUP_GAP > entry.x
          && y < entry.y + entry.height + GROUP_GAP && y + group.height + GROUP_GAP > entry.y
        );
        if (overlaps) continue;
        group.x = x;
        group.y = y;
        break findPosition;
      }
    }
    placed.push(group);
  }

  return {
    width: Math.max(480, ...groups.map((group) => group.x + group.width)),
    height: Math.max(60, ...groups.map((group) => group.y + group.height)),
  };
}

/** Short SQL aliases reduce visual noise; tooltips retain the complete type. */
function columnType(type: string): string {
  return compactDatabaseLabel(formatDatabaseColumnType(type), 24);
}

/** Size each schema independently so one long type cannot widen the entire DB. */
function tableWidth(table: StudioDatabaseTable): number {
  return Math.max(180, compactDatabaseLabel(table.name, 48).length * 7 + 20, ...table.columns.map((column) =>
    62 + (compactDatabaseLabel(column.name, 32).length + columnType(column.type).length) * 6
  ));
}

/** Keep labels compact without discarding the complete transport value. */
function compactDatabaseLabel(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
