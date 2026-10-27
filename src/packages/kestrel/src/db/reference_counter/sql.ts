import { createHash } from "node:crypto";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import type { ReferenceCounterDefinition } from "./types.js";

/** Shared naming and quoting keep generated identifiers bounded and schema-qualified. */
export function counterObjectName(definition: ReferenceCounterDefinition): string {
  return `__counter_${createHash("sha256").update(definition.id).digest("hex").slice(0, 32)}`;
}
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
export function tableIdentifier(table: AnyPgTable): string {
  const config = getTableConfig(table);
  return `${quoteIdentifier(config.schema ?? "public")}.${quoteIdentifier(config.name)}`;
}

/** Resolve unqualified Drizzle tables to their migration schema explicitly. */
export function schemaIdentifier(table: AnyPgTable): string {
  return quoteIdentifier(getTableConfig(table).schema ?? "public");
}
