import type {
  StudioDatabaseLayout,
  StudioDatabaseTable,
} from "./contract.js";

const MARGIN = 64;
const GAP = 100;
const HEADER = 58;
const ROW = 28;
const COLORS = ["#2563eb", "#0f766e", "#9333ea", "#b45309", "#be123c"];

interface TableNode {
  id: string;
  schema: string;
  table: StudioDatabaseTable;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Generates a standalone, script-free diagram without external layout services. */
export function renderDatabaseSchemaSvg(layout: StudioDatabaseLayout): string {
  const { nodes, width, height } = positionTables(layout);
  const byName = new Map(nodes.map((node) => [tableKey(node.schema, node.table.name), node]));
  const relationships: string[] = [];
  let constraintCount = 0;

  for (const source of nodes) {
    for (const foreignKey of source.table.foreignKeys ?? []) {
      const target = byName.get(tableKey(foreignKey.referencedSchema, foreignKey.referencedTable));
      // Custom sources may omit a referenced table; never infer missing relations.
      if (target === undefined) continue;
      const paths: string[] = [];

      foreignKey.columns.forEach((column, index) => {
        const from = source.table.columns.findIndex((entry) => entry.name === column);
        const to = target.table.columns.findIndex((entry) => entry.name === foreignKey.referencedColumns[index]);
        if (from < 0 || to < 0) return;

        const title = `${foreignKey.name}: ${source.schema}.${source.table.name}.${column} → ${target.schema}.${target.table.name}.${foreignKey.referencedColumns[index]}`;
        paths.push(renderRelationship(source, target, from, to, constraintCount, title));
      });

      if (paths.length > 0) {
        relationships.push(...paths);
        constraintCount += 1;
      }
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="diagram-title diagram-description">
  <title id="diagram-title">Database schema</title>
  <desc id="diagram-description">${nodes.length} tables across ${layout.schemas.length} schemas. ${constraintCount} foreign keys. Arrows point from foreign-key columns to referenced columns.</desc>
  <defs>
    <marker id="reference-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"/></marker>
  </defs>
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <g font-family="system-ui, sans-serif" fill="#0f172a">
    <text x="${MARGIN}" y="42" font-size="24" font-weight="700">Database schema</text>
    <text x="${MARGIN}" y="68" font-size="13" fill="#475569">${nodes.length} tables · ${constraintCount} foreign keys · PK: primary key · FK: foreign key · ?: nullable · arrows point to referenced columns</text>
  </g>
  <g fill="none" stroke="#64748b" stroke-width="1.5" stroke-linejoin="round">${relationships.join("")}</g>
  <g font-family="monospace" font-size="12">${nodes.map(renderTable).join("")}</g>
  ${nodes.length === 0 ? '<text x="64" y="130" font-family="system-ui, sans-serif" fill="#475569">No application tables found.</text>' : ""}
</svg>`;
}

/** Packs schema groups into rows, reserving clear gutters for relationship paths. */
function positionTables(layout: StudioDatabaseLayout) {
  const tables = layout.schemas.flatMap((schema) => schema.tables);
  const columnCount = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(tables.length))));
  // Monospace sizing keeps long identifiers and SQL types readable without clipping.
  const width = Math.max(340, ...layout.schemas.flatMap((schema) => schema.tables.flatMap((table) => [
    32 + Math.max(schema.name.length, table.name.length) * 8,
    ...table.columns.map((column) => 112 + (column.name.length + column.type.length) * 8),
  ])));
  const nodes: TableNode[] = [];
  let y = 140;

  layout.schemas.forEach((schema, schemaIndex) => {
    for (let start = 0; start < schema.tables.length; start += columnCount) {
      const row = schema.tables.slice(start, start + columnCount);
      let rowHeight = 0;
      row.forEach((table, columnIndex) => {
        const height = HEADER + Math.max(1, table.columns.length) * ROW + 8;
        nodes.push({
          id: `table-${nodes.length}`,
          schema: schema.name,
          table,
          color: COLORS[schemaIndex % COLORS.length]!,
          x: MARGIN + columnIndex * (width + GAP),
          y,
          width,
          height,
        });
        rowHeight = Math.max(rowHeight, height);
      });
      y += rowHeight + GAP;
    }
  });

  return {
    nodes,
    width: Math.max(1000, MARGIN * 2 + columnCount * width + (columnCount - 1) * GAP),
    height: Math.max(200, y - GAP + MARGIN),
  };
}

/** Routes each column pair through row/column gutters, including self references. */
function renderRelationship(
  source: TableNode,
  target: TableNode,
  from: number,
  to: number,
  index: number,
  title: string,
): string {
  const rightward = target.x >= source.x;
  const sameColumn = target.x === source.x;
  const sourceX = source.x + (rightward ? source.width : 0);
  const targetX = target.x + (sameColumn || !rightward ? target.width : 0);
  const sourceY = source.y + HEADER + from * ROW + ROW / 2;
  const targetY = target.y + HEADER + to * ROW + ROW / 2;
  const offset = 16 + (index % 7) * 5;
  const sourceLane = sourceX + (rightward ? offset : -offset);
  const targetLane = targetX + (sameColumn || !rightward ? offset : -offset);
  const corridorY = Math.min(source.y, target.y) - offset;
  const path = sameColumn
    ? `M ${sourceX} ${sourceY} H ${sourceLane} V ${targetY} H ${targetX}`
    : `M ${sourceX} ${sourceY} H ${sourceLane} V ${corridorY} H ${targetLane} V ${targetY} H ${targetX}`;

  return `<a href="#${target.id}-column-${to}"><title>${xml(title)}</title><path d="${path}" marker-end="url(#reference-arrow)"/><circle cx="${sourceX}" cy="${sourceY}" r="3" fill="#f8fafc"/></a>`;
}

/** Numeric fragment identifiers avoid collisions and unsafe identifiers in markup. */
function renderTable(node: TableNode): string {
  const { table, x, y, width, height, color } = node;
  const foreignColumns = new Set((table.foreignKeys ?? []).flatMap((key) => [...key.columns]));
  const columns = table.columns.map((column, index) => {
    const top = y + HEADER + index * ROW;
    const flags = [column.primaryKey ? "PK" : "", foreignColumns.has(column.name) ? "FK" : ""].filter(Boolean).join(" ");
    const label = `${column.name}${column.nullable ? " ?" : ""}`;
    return `<g id="${node.id}-column-${index}">
      <title>${xml(`${column.name}: ${column.type}; ${column.nullable ? "nullable" : "not null"}${column.description === undefined ? "" : `\n${column.description}`}`)}</title>
      <rect x="${x + 1}" y="${top}" width="${width - 2}" height="${ROW}" fill="${index % 2 === 0 ? "#fff" : "#f1f5f9"}"/>
      <text x="${x + 12}" y="${top + 19}" fill="${color}" font-size="10" font-weight="700">${flags}</text>
      <text x="${x + 64}" y="${top + 19}" fill="#0f172a">${xml(label)}</text>
      <text x="${x + width - 14}" y="${top + 19}" text-anchor="end" fill="#475569">${xml(column.type)}</text>
    </g>`;
  });

  return `<g id="${node.id}">
    <title>${xml(`${node.schema}.${table.name}${table.description === undefined ? "" : `\n${table.description}`}`)}</title>
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="#fff" stroke="#cbd5e1"/>
    <rect x="${x}" y="${y}" width="${width}" height="${HEADER}" rx="8" fill="${color}"/>
    <rect x="${x}" y="${y + HEADER - 8}" width="${width}" height="8" fill="${color}"/>
    <text x="${x + 14}" y="${y + 20}" fill="#fff" font-size="11">${xml(node.schema)}${table.kind === "partitioned-table" ? " · partitioned" : ""}</text>
    <text x="${x + 14}" y="${y + 43}" fill="#fff" font-size="15" font-weight="700">${xml(table.name)}</text>
    ${columns.join("")}
    ${columns.length === 0 ? `<text x="${x + 14}" y="${y + HEADER + 20}" fill="#64748b">No columns</text>` : ""}
  </g>`;
}

/** Tuple keys distinguish quoted SQL names containing dots or separators. */
function tableKey(schema: string, table: string): string {
  return JSON.stringify([schema, table]);
}

/** Escape all catalog text and remove characters XML 1.0 cannot represent. */
function xml(value: string): string {
  return value
    .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "")
    .replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    })[character]!);
}
