import { and, desc, eq, getTableColumns, lt } from "drizzle-orm";
import type { PostgresDrizzleManager } from "../database_manager.js";
import { getHistoryTableDefinitions, type HistoryOperation } from "./definition.js";
import type { AnyPgTable } from "drizzle-orm/pg-core";

export interface HistoryPageRequest {
  readonly identity: Readonly<Record<string, unknown>>;
  /** Explicit field allowlist; identity columns are not automatically exposed. */
  readonly fields: readonly string[];
  readonly before?: string;
  readonly pageSize?: number;
}

/** Reads bounded sparse events without reconstructing or exposing unselected values.
 * Authorization belongs to the calling application operation.
 */
export async function readHistoryPage(
  database: PostgresDrizzleManager["database"],
  table: AnyPgTable,
  request: HistoryPageRequest,
) {
  const definition = getHistoryTableDefinitions({ table })[0];
  if (!definition) throw new TypeError("Expected a table created with defineHistoryTable.");
  const columns = getTableColumns(table);
  const pageSize = request.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError("Invalid history page size.");
  if (request.before !== undefined && (!/^[1-9][0-9]*$/.test(request.before) || BigInt(request.before) > 9223372036854775807n)) throw new TypeError("Invalid history cursor.");
  const fields = [...new Set(request.fields)];
  if (fields.some((key) => !definition.sourceColumnKeys.includes(key))) throw new TypeError("Unknown history field.");
  const conditions = definition.identityKeys.map((key) => {
    if (!Object.hasOwn(request.identity, key) || request.identity[key] == null) throw new TypeError("Missing history identity.");
    return eq(columns[key]!, request.identity[key]);
  });
  if (request.before !== undefined) conditions.push(lt(columns.__sequence!, BigInt(request.before)));
  // Select only allowlisted business values, while retaining event metadata.
  const selection = Object.fromEntries([...fields, "__sequence", "__operation", "__changedColumns", "__changedAt", "__actor", "__reason"].map((key) => [key, columns[key]!]));
  const rows = await database.select(selection).from(table).where(and(...conditions))
    .orderBy(desc(columns.__sequence!)).limit(pageSize + 1);
  const events = rows.slice(0, pageSize).map((row) => ({
    sequence: String(row.__sequence),
    changedAt: (row.__changedAt as Date).toISOString(),
    operation: row.__operation as HistoryOperation,
    actor: row.__actor as string | null,
    reason: row.__reason as string | null,
    // Presence, rather than truthiness, distinguishes unchanged values from NULL.
    values: JSON.parse(JSON.stringify(Object.fromEntries(fields
      .filter((key) => row.__operation !== "delete" && (row.__changedColumns as string[]).includes(key))
      .map((key) => [key, row[key]])), (_key, value) => typeof value === "bigint" ? String(value) : value)) as Record<string, unknown>,
  }));
  return { fields, events, nextCursor: rows.length > pageSize ? events.at(-1)!.sequence : null };
}
