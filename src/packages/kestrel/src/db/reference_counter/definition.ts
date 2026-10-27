import { getTableColumns, is, SQL, sql } from "drizzle-orm";
import { alias, getTableConfig, PgColumn, PgDialect, type AnyPgTable } from "drizzle-orm/pg-core";

import { defineDatabaseSchemaContribution } from "../schema_contributions/definition.js";
import { createReferenceCounterRemovalSql, createReferenceCounterTriggerSql } from "./trigger_sql.js";
import { quoteIdentifier, tableIdentifier } from "./sql.js";

import type { ReferenceCounterDefinition, ReferenceCounterOptions } from "./types.js";

const metadata = Symbol("database.referenceCounters");
const destinationOwner = Symbol("database.referenceCounterOwner");
type CounterTable = AnyPgTable & { readonly [metadata]?: ReferenceCounterDefinition[] };

/** Declares synchronous reference counting without performing a baseline scan. */
export function defineReferenceCounter<Source extends AnyPgTable>(
  source: Source,
  options: ReferenceCounterOptions<Source>,
): ReferenceCounterDefinition {
  if (options.id.trim() === "") throw new TypeError("A reference counter requires a stable id.");
  if (!Object.values(getTableColumns(source)).includes(options.reference)) {
    throw new TypeError("The reference column must belong to the source table.");
  }
  const foreignKey = getTableConfig(source).foreignKeys.some((key) => {
    const reference = key.reference();
    return reference.columns.length === 1 && reference.columns[0] === options.reference
      && reference.foreignColumns.length === 1 && reference.foreignColumns[0] === options.target;
  });
  if (!foreignKey) throw new TypeError("The reference must declare a single-column foreign key to the target.");
  const target = getTableConfig(options.target.table);
  const primaryKeys = target.primaryKeys.flatMap((key) => key.columns);
  const singlePrimary = options.target.primary
    ? target.columns.filter((column) => column.primary).length === 1 && primaryKeys.length === 0
    : primaryKeys.length === 1 && primaryKeys[0] === options.target;
  if (!singlePrimary || !options.target.notNull) {
    throw new TypeError("The counter target must be a single-column primary key.");
  }
  if (!["uuid", "text", "varchar", "integer", "bigint", "smallint"].some((type) =>
    options.target.getSQLType() === type || options.target.getSQLType().startsWith(`${type}(`)
  ) || options.target.getSQLType() !== options.reference.getSQLType()) {
    throw new TypeError("Reference and target must have matching UUID, text or integer SQL types.");
  }
  if (options.counter.table !== options.target.table || source === options.target.table
    || options.counter === options.target || !options.counter.notNull
    || !["integer", "bigint"].includes(options.counter.getSQLType())
    || options.counter.generated !== undefined || options.counter.generatedIdentity !== undefined
    || options.counter.onUpdateFn !== undefined || options.counter.defaultFn !== undefined
    || !options.counter.hasDefault) {
    throw new TypeError("The counter must be a dedicated NOT NULL integer/bigint column with a zero default on another table.");
  }
  const defaultValue = options.counter.default;
  if (defaultValue !== 0 && defaultValue !== 0n
    && !(is(defaultValue, SQL) && new PgDialect().sqlToQuery(sql`${defaultValue}`.inlineParams()).sql.trim() === "0")) {
    throw new TypeError("The reference counter column default must be zero.");
  }
  const table = source as CounterTable;
  if (destinationOwner in options.counter || table[metadata]?.some(({ id }) => id === options.id)) {
    throw new TypeError("Duplicate reference counter id or destination column.");
  }
  const predicate = (name: "old" | "new" | "source") => {
    const row = getTableColumns(alias(source, name)) as Source["_"]["columns"];
    const condition = options.where?.(row) ?? sql`true`;
    assertSourcePredicate(condition, new Set(Object.values(row)));
    const query = new PgDialect().sqlToQuery(sql`${condition}`.inlineParams());
    if (query.params.length !== 0) throw new TypeError("Counter predicates cannot contain placeholders.");
    return query.sql;
  };
  const definition: ReferenceCounterDefinition = Object.freeze({
    id: options.id, source, reference: options.reference, target: options.target,
    counter: options.counter,
    predicates: Object.freeze({ old: predicate("old"), new: predicate("new"), source: predicate("source") }),
  });
  const installSql = createReferenceCounterTriggerSql(definition);
  defineDatabaseSchemaContribution(source, {
    id: `postgres.reference-counter:${options.id}`,
    installSql,
    updateSql: installSql,
    uninstallBeforeSql: createReferenceCounterRemovalSql(definition),
  });
  if (table[metadata] === undefined) Object.defineProperty(table, metadata, { value: [], enumerable: false });
  table[metadata]!.push(definition);
  Object.defineProperty(options.counter, destinationOwner, { value: definition, enumerable: false });
  return definition;
}

/** Discovers counters through exported source tables, deduplicating schema aliases. */
export function getReferenceCounterDefinitions(schema: Readonly<Record<string, unknown>>): readonly ReferenceCounterDefinition[] {
  const counters = new Map<string, ReferenceCounterDefinition>();
  const destinations = new Set<string>();
  for (const value of Object.values(schema)) {
    if (typeof value !== "object" || value === null || !(metadata in value)) continue;
    for (const definition of (value as CounterTable)[metadata] ?? []) {
      const previous = counters.get(definition.id);
      if (previous === definition) continue;
      const destination = `${tableIdentifier(definition.target.table)}.${quoteIdentifier(definition.counter.name)}`;
      if (previous !== undefined || destinations.has(destination)) {
        throw new TypeError(`Duplicate reference counter id or destination: "${definition.id}".`);
      }
      counters.set(definition.id, definition);
      destinations.add(destination);
    }
  }
  return [...counters.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Reject accidental closed-over columns; raw SQL remains trusted schema code. */
function assertSourcePredicate(value: unknown, columns: ReadonlySet<unknown>): void {
  if (is(value, PgColumn)) {
    if (!columns.has(value)) throw new TypeError("Counter filters must use the supplied source columns only.");
  } else if (is(value, SQL)) {
    for (const chunk of value.queryChunks) assertSourcePredicate(chunk, columns);
  } else if (Array.isArray(value)) {
    for (const chunk of value) assertSourcePredicate(chunk, columns);
  }
}
