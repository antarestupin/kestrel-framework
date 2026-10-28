import type {
  StudioDatabaseLayout,
} from "./contract.js";
import { formatDatabaseColumnType } from "./presentation.js";
import { createDatabaseDiagramLayout, type SchemaGroup, type TableNode } from "./schema_layout.js";

const TABLE_HEADER = 24;
const ROW = 16;
const INSET = 12;

const MARGIN = 20;
/** Generates a compact, standalone overview without external layout services. */
export function renderDatabaseSchemaSvg(layout: StudioDatabaseLayout): string {
  const diagram = createDatabaseDiagramLayout(layout);
  const { groups } = diagram;
  const width = diagram.width + MARGIN * 2;
  const height = diagram.height + 66 + MARGIN;
  const tableCount = groups.reduce((count, group) => count + group.tables.length, 0);
  const constraintCount = groups.reduce((count, group) => count + group.tables.reduce(
    (sum, node) => sum + (node.table.foreignKeys?.length ?? 0), 0,
  ), 0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="diagram-title diagram-description">
  <title id="diagram-title">Database schema</title>
  <desc id="diagram-description">${tableCount} tables grouped into ${groups.length} schemas. ${constraintCount} foreign keys. Foreign-key references are available in column tooltips.</desc>
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <g font-family="system-ui, sans-serif" fill="#0f172a">
    <text x="${MARGIN}" y="28" font-size="18" font-weight="700">Database schema</text>
    <text x="${MARGIN}" y="47" font-size="11" fill="#475569">${tableCount} tables · ${groups.length} schemas · PK: primary key · FK: foreign key · ?: nullable</text>
  </g>
  ${groups.map(renderSchemaGroup).join("")}
  ${groups.length === 0 ? `<text x="${MARGIN}" y="${height - 20}" font-family="system-ui, sans-serif" font-size="12" fill="#475569">No application tables found.</text>` : ""}
</svg>`;
}

function columnType(type: string): string {
  return compact(formatDatabaseColumnType(type), 24);
}

function renderSchemaGroup(group: SchemaGroup): string {
  const { schema, color } = group;
  return `<g id="${group.id}" transform="translate(${group.x + MARGIN} ${group.y + 66})" role="group" aria-labelledby="${group.id}-title">
    <title id="${group.id}-title">${xml(`${schema.name}${schema.description === undefined ? "" : `\n${schema.description}`}`)}</title>
    <rect class="database-schema-frame" width="${group.width}" height="${group.height}" rx="6" fill="#fff" stroke="${color}" stroke-opacity="0.35"/>
    <rect width="${group.width}" height="28" rx="6" fill="${color}" fill-opacity="0.08"/>
    <text x="${INSET}" y="19" font-family="monospace" font-size="12" font-weight="700" fill="${color}">${xml(compact(schema.name, 48))}</text>
    <text x="${group.width - INSET}" y="19" text-anchor="end" font-family="system-ui, sans-serif" font-size="10" fill="#64748b">${schema.tables.length} ${schema.tables.length === 1 ? "table" : "tables"}</text>
    <g font-family="monospace" font-size="10">${group.tables.map((node) => renderTable(node, schema.name, color)).join("")}</g>
    ${schema.tables.length === 0 ? `<text x="${INSET}" y="49" font-family="system-ui, sans-serif" font-size="10" fill="#64748b">No tables</text>` : ""}
  </g>`;
}

/** Dense table rows retain keys, full comments and foreign-key metadata on hover. */
function renderTable(node: TableNode, schema: string, color: string): string {
  const { table, width, height } = node;
  const columns = table.columns.map((column, index) => {
    const top = TABLE_HEADER + index * ROW;
    const references = (table.foreignKeys ?? []).filter((key) => key.columns.includes(column.name));
    const flags = [column.primaryKey ? "PK" : "", references.length > 0 ? "FK" : ""].filter(Boolean).join(" ");
    const title = [
      `${column.name}: ${column.type}; ${column.nullable ? "nullable" : "not null"}`,
      ...(column.description === undefined ? [] : [column.description]),
      ...references.map((key) => `${key.name}: (${key.columns.join(", ")}) → ${key.referencedSchema}.${key.referencedTable}(${key.referencedColumns.join(", ")})`),
    ].join("\n");
    return `<g id="${node.id}-column-${index}">
      <title>${xml(title)}</title>
      <rect x="1" y="${top}" width="${width - 2}" height="${ROW}" fill="${index % 2 === 0 ? "#fff" : "#f1f5f9"}"/>
      <text x="6" y="${top + 11}" fill="${color}" font-size="8" font-weight="700">${flags}</text>
      <text x="38" y="${top + 11}" fill="#0f172a">${xml(compact(column.name, 32))}${column.nullable ? " ?" : ""}</text>
      <text x="${width - 7}" y="${top + 11}" text-anchor="end" fill="#64748b">${xml(columnType(column.type))}</text>
    </g>`;
  });

  return `<g id="${node.id}" transform="translate(${node.x} ${node.y})">
    <title>${xml(`${schema}.${table.name}${table.kind === "partitioned-table" ? " (partitioned)" : ""}${table.description === undefined ? "" : `\n${table.description}`}`)}</title>
    <rect class="database-table-frame" width="${width}" height="${height}" rx="3" fill="#fff" stroke="#cbd5e1"/>
    <rect x="1" y="1" width="${width - 2}" height="${TABLE_HEADER - 1}" fill="${color}" fill-opacity="0.12"/>
    <text x="7" y="16" fill="#0f172a" font-size="11" font-weight="700">${xml(compact(table.name, 48))}</text>
    ${columns.join("")}
    ${columns.length === 0 ? `<text x="7" y="${TABLE_HEADER + 11}" fill="#64748b">No columns</text>` : ""}
  </g>`;
}

/** Keep unusually long identifiers compact while preserving full tooltip values. */
function compact(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

/** Escape all catalog text and remove characters XML 1.0 cannot represent. */
function xml(value: string): string {
  return value
    .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "")
    .replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    })[character]!);
}
