import {
  getTableConfig,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";

import { quoteSqlBody } from "../sql_dollar_quote.js";
import type { HistoryTableDefinition } from "./definition.js";

/** Generates the complete PostgreSQL function and trigger DDL for one history table. */
export function createHistoryTriggerSql(
  definition: HistoryTableDefinition,
): string {
  const sourceConfig = getTableConfig(definition.source);
  const historyConfig = getTableConfig(definition.table);
  const sourceColumns = getTableColumns(definition.source);
  const entries = definition.sourceColumnKeys.map((key) => {
    const column = sourceColumns[key];
    if (column === undefined) {
      throw new TypeError(`Missing history source column "${key}".`);
    }
    return [key, column] as const;
  });
  const identityKeys = new Set(definition.identityKeys);
  const functionName = managedIdentifier(
    `__history_${sourceConfig.name}_${historyConfig.name}_write`,
  );
  const functionIdentifier = qualifiedIdentifier(
    historyConfig.schema,
    functionName,
  );
  const sourceIdentifier = qualifiedIdentifier(
    sourceConfig.schema,
    sourceConfig.name,
  );
  const historyIdentifier = qualifiedIdentifier(
    historyConfig.schema,
    historyConfig.name,
  );
  const insertColumns = [
    ...entries.map(([, column]) => quoteIdentifier(column.name)),
    quoteIdentifier("__operation"),
    quoteIdentifier("__changed_columns"),
    quoteIdentifier("__changed_at"),
    quoteIdentifier("__actor"),
    quoteIdentifier("__reason"),
  ].join(", ");
  const allColumnNames = createTextArray(entries.map(([key]) => key));
  const updateChangedColumns = createChangedColumnsExpression(entries);
  const anyColumnChanged = entries
    .map(([, column]) => distinctComparison(column))
    .join(" OR ");
  const insertValues = [
    ...entries.map(([, column]) => recordColumn("NEW", column)),
    "1",
    allColumnNames,
    "statement_timestamp()",
    historyContextSetting("actor"),
    historyContextSetting("reason"),
  ].join(", ");
  const updateValues = [
    ...entries.map(([key, column]) => identityKeys.has(key)
      ? recordColumn("NEW", column)
      : `CASE WHEN ${distinctComparison(column)} THEN ${recordColumn("NEW", column)} ELSE NULL END`),
    "2",
    updateChangedColumns,
    "statement_timestamp()",
    historyContextSetting("actor"),
    historyContextSetting("reason"),
  ].join(", ");
  const deleteValues = [
    ...entries.map(([key, column]) => identityKeys.has(key)
      ? recordColumn("OLD", column)
      : "NULL"),
    "3",
    "ARRAY[]::text[]",
    "statement_timestamp()",
    historyContextSetting("actor"),
    historyContextSetting("reason"),
  ].join(", ");
  const identityMutationCondition = entries
    .filter(([key]) => identityKeys.has(key))
    .map(([, column]) => distinctComparison(column))
    .join(" OR ");

  // A percent in an identifier must stay literal in the RAISE format string.
  const immutableMessage = escapeLiteral(sourceConfig.name).replaceAll("%", "%%");
  const body = `BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO ${historyIdentifier} (${insertColumns}) VALUES (${insertValues});
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF ${identityMutationCondition} THEN
      RAISE EXCEPTION 'History identity columns of ${immutableMessage} are immutable';
    END IF;
    IF NOT (${anyColumnChanged}) THEN
      RETURN NEW;
    END IF;
    INSERT INTO ${historyIdentifier} (${insertColumns}) VALUES (${updateValues});
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO ${historyIdentifier} (${insertColumns}) VALUES (${deleteValues});
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Unsupported history operation %', TG_OP;
END`;

  return `CREATE OR REPLACE FUNCTION ${functionIdentifier}()
RETURNS trigger
LANGUAGE plpgsql
AS ${quoteSqlBody(body, "history")};

DROP TRIGGER IF EXISTS ${quoteIdentifier("__history_insert")} ON ${sourceIdentifier};
CREATE TRIGGER ${quoteIdentifier("__history_insert")}
AFTER INSERT ON ${sourceIdentifier}
FOR EACH ROW EXECUTE FUNCTION ${functionIdentifier}();

DROP TRIGGER IF EXISTS ${quoteIdentifier("__history_update")} ON ${sourceIdentifier};
CREATE TRIGGER ${quoteIdentifier("__history_update")}
AFTER UPDATE ON ${sourceIdentifier}
FOR EACH ROW
EXECUTE FUNCTION ${functionIdentifier}();

DROP TRIGGER IF EXISTS ${quoteIdentifier("__history_delete")} ON ${sourceIdentifier};
CREATE TRIGGER ${quoteIdentifier("__history_delete")}
AFTER DELETE ON ${sourceIdentifier}
FOR EACH ROW EXECUTE FUNCTION ${functionIdentifier}();`;
}

/** Removes trigger objects before their source or history tables change. */
export function createHistoryTriggerRemovalSql(
  definition: HistoryTableDefinition,
): string {
  const sourceConfig = getTableConfig(definition.source);
  const historyConfig = getTableConfig(definition.table);
  const functionName = managedIdentifier(
    `__history_${sourceConfig.name}_${historyConfig.name}_write`,
  );
  const sourceIdentifier = qualifiedIdentifier(
    sourceConfig.schema,
    sourceConfig.name,
  );
  const functionIdentifier = qualifiedIdentifier(
    historyConfig.schema,
    functionName,
  );

  return `DROP TRIGGER IF EXISTS ${quoteIdentifier("__history_insert")} ON ${sourceIdentifier};
DROP TRIGGER IF EXISTS ${quoteIdentifier("__history_update")} ON ${sourceIdentifier};
DROP TRIGGER IF EXISTS ${quoteIdentifier("__history_delete")} ON ${sourceIdentifier};
DROP FUNCTION IF EXISTS ${functionIdentifier}();`;
}

/**
 * Generates the one-time copy stored in the migration that enables history.
 * The lock is held until the migration transaction installs the triggers.
 */
export function createHistoryBaselineSql(
  definition: HistoryTableDefinition,
): string | undefined {
  if (definition.baseline !== "existing_rows") {
    return undefined;
  }

  const sourceConfig = getTableConfig(definition.source);
  const historyConfig = getTableConfig(definition.table);
  const sourceColumns = getTableColumns(definition.source);
  const entries = definition.sourceColumnKeys.map((key) => {
    const column = sourceColumns[key];
    if (column === undefined) {
      throw new TypeError(`Missing history source column "${key}".`);
    }
    return [key, column] as const;
  });
  const sourceIdentifier = qualifiedIdentifier(
    sourceConfig.schema,
    sourceConfig.name,
  );
  const historyIdentifier = qualifiedIdentifier(
    historyConfig.schema,
    historyConfig.name,
  );
  const insertColumns = [
    ...entries.map(([, column]) => quoteIdentifier(column.name)),
    quoteIdentifier("__operation"),
    quoteIdentifier("__changed_columns"),
    quoteIdentifier("__changed_at"),
    quoteIdentifier("__actor"),
    quoteIdentifier("__reason"),
  ].join(", ");
  const selectValues = [
    ...entries.map(([, column]) => `source.${quoteIdentifier(column.name)}`),
    "1",
    createTextArray(entries.map(([key]) => key)),
    "statement_timestamp()",
    "NULL",
    "NULL",
  ].join(", ");

  return `LOCK TABLE ${sourceIdentifier} IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO ${historyIdentifier} (${insertColumns})
SELECT ${selectValues}
FROM ${sourceIdentifier} AS source;`;
}

function createChangedColumnsExpression(
  entries: readonly (readonly [string, AnyPgColumn])[],
): string {
  const values = entries.map(([key, column]) =>
    `CASE WHEN ${distinctComparison(column)} THEN '${escapeLiteral(key)}' END`
  );
  return `array_remove(ARRAY[${values.join(", ")}], NULL)`;
}

/** PostgreSQL json has no equality operator, unlike jsonb. */
function distinctComparison(column: AnyPgColumn): string {
  const oldValue = recordColumn("OLD", column);
  const newValue = recordColumn("NEW", column);
  if (/^json(?:\[[0-9]*\])*$/u.test(column.getSQLType())) {
    return `to_jsonb(${oldValue}) IS DISTINCT FROM to_jsonb(${newValue})`;
  }
  return `${oldValue} IS DISTINCT FROM ${newValue}`;
}

function createTextArray(values: readonly string[]): string {
  return `ARRAY[${values.map((value) => `'${escapeLiteral(value)}'`).join(", ")}]::text[]`;
}

function recordColumn(record: "OLD" | "NEW", column: AnyPgColumn): string {
  return `${record}.${quoteIdentifier(column.name)}`;
}

function historyContextSetting(name: "actor" | "reason"): string {
  return `nullif(current_setting('kestrel.history.${name}', true), '')`;
}

function qualifiedIdentifier(schema: string | undefined, name: string): string {
  // Default-schema Drizzle tables belong to public even when the writer uses a different search path.
  return `${quoteIdentifier(schema ?? "public")}.${quoteIdentifier(name)}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function escapeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

/** Keep generated identifiers within PostgreSQL's UTF-8 byte budget. */
export function managedIdentifier(identifier: string): string {
  if (Buffer.byteLength(identifier, "utf8") <= 63) {
    return identifier;
  }

  let hash = 0;
  let prefixEnd = 0;
  let bytesLeft = 54; // The underscore and hexadecimal suffix use nine ASCII bytes.
  for (const character of identifier) {
    hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
    bytesLeft -= Buffer.byteLength(character, "utf8");
    if (bytesLeft >= 0) prefixEnd += character.length;
  }
  const suffix = hash.toString(16).padStart(8, "0");
  return `${identifier.slice(0, prefixEnd)}_${suffix}`;
}
