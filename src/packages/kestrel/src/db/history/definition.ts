import {
  getTableColumns,
  sql,
} from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  getTableConfig,
  index,
  isPgEnum,
  pgSchema,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
  type AnyPgTable,
  type ConvertCustomConfig,
  type CustomTypeValues,
  type ExtraConfigColumn,
  type PgCustomColumnBuilder,
} from "drizzle-orm/pg-core";

import { defineDatabaseSchemaContribution } from "../schema_contributions/definition.js";
import {
  createHistoryBaselineSql,
  createHistoryTriggerRemovalSql,
  createHistoryTriggerSql,
} from "./trigger_sql.js";

export const historyMetadataKeys = [
  "__sequence",
  "__operation",
  "__changedColumns",
  "__changedAt",
  "__actor",
  "__reason",
] as const;

export type HistoryOperation = "insert" | "update" | "delete";

const historyOperationType = customType<{
  data: HistoryOperation;
  driverData: number;
}>({
  dataType: () => "smallint",
  fromDriver: (value) => decodeHistoryOperation(value),
  toDriver: (value) => encodeHistoryOperation(value),
});

type TableColumn<Table extends AnyPgTable> =
  Table["_"]["columns"][keyof Table["_"]["columns"]];
type TableColumnKey<Table extends AnyPgTable> =
  Extract<keyof Table["_"]["columns"], string>;

type HistoryColumnBuilder<Column extends AnyPgColumn> =
  PgCustomColumnBuilder<ConvertCustomConfig<Column["_"]["name"], {
    data: Column["_"]["data"];
    driverData: Column["_"]["driverParam"];
  }>>;

type HistoryColumnBuilders<Table extends AnyPgTable> = {
  [Key in keyof Table["_"]["columns"]]:
    HistoryColumnBuilder<Table["_"]["columns"][Key]>;
};

export interface HistoryTableOptions<Table extends AnyPgTable> {
  /** Defaults to `<source table name>_history`. */
  readonly name?: string;
  /** Stable source columns used to retrieve one entity's event stream. */
  readonly identity?: readonly TableColumn<Table>[];
  /** Copies current rows once when history is enabled on an existing table. */
  readonly baseline?: "existing_rows";
}

export interface HistoryTableDefinition<
  Source extends AnyPgTable = AnyPgTable,
  History extends AnyPgTable = AnyPgTable,
> {
  readonly source: Source;
  readonly table: History;
  readonly identityKeys: readonly string[];
  readonly sourceColumnKeys: readonly string[];
  readonly baseline: "existing_rows" | undefined;
}

const historyTableDefinition = Symbol("database.historyTableDefinition");

type DefinedHistoryTable<Table extends AnyPgTable> = Table & {
  readonly [historyTableDefinition]: HistoryTableDefinition;
};

/**
 * Derives a sparse, append-only history table from one PostgreSQL table.
 *
 * Source constraints and defaults are deliberately omitted because update and
 * delete events contain only identity columns and changed values.
 */
export function defineHistoryTable<const Source extends AnyPgTable>(
  source: Source,
  options: HistoryTableOptions<Source> = {},
) {
  const sourceConfig = getTableConfig(source);
  assertReservedNamesAvailable(sourceConfig.columns);
  const sourceColumns = getTableColumns(source);
  const sourceEntries = Object.entries(sourceColumns);
  assertReservedKeysAvailable(sourceEntries.map(([key]) => key));
  const identityKeys = resolveIdentityKeys(
    source,
    options.identity,
    sourceEntries,
  );
  const tableName = options.name ?? `${sourceConfig.name}_history`;
  const clonedColumns = cloneHistoryColumns(source, sourceConfig.columns);
  const historyColumnsDefinition = {
    ...clonedColumns,
    __sequence: bigint("__sequence", { mode: "bigint" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    __operation: historyOperationType("__operation").notNull(),
    __changedColumns: text("__changed_columns")
      .array()
      .$type<TableColumnKey<Source>[]>()
      .notNull(),
    __changedAt: timestamp("__changed_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    __actor: text("__actor"),
    __reason: text("__reason"),
  };
  const extraConfig = (historyColumns: Record<string, ExtraConfigColumn>) => {
    const firstIdentity = historyColumns[identityKeys[0]!]!;
    const remainingIdentity = identityKeys.slice(1)
      .map((key) => historyColumns[key]!);
    return [
      index(createIndexName(sourceConfig.schema, tableName)).on(
        firstIdentity,
        ...remainingIdentity,
        historyColumns.__sequence!.desc(),
      ),
      check(
        createOperationCheckName(sourceConfig.schema, tableName),
        sql`${historyColumns.__operation} IN (1, 2, 3)`,
      ),
    ];
  };
  const table = sourceConfig.schema === undefined
    ? pgTable(tableName, historyColumnsDefinition, extraConfig)
    : pgSchema(sourceConfig.schema).table(
      tableName,
      historyColumnsDefinition,
      extraConfig,
    );

  const definition: HistoryTableDefinition<Source, typeof table> = {
    source,
    table,
    identityKeys,
    sourceColumnKeys: sourceEntries.map(([key]) => key),
    baseline: options.baseline,
  };

  Object.defineProperty(table, historyTableDefinition, {
    configurable: false,
    enumerable: false,
    value: definition,
    writable: false,
  });

  const triggerSql = createHistoryTriggerSql(definition);
  const baselineSql = createHistoryBaselineSql(definition);
  defineDatabaseSchemaContribution(table, {
    id: createContributionId(sourceConfig.schema, sourceConfig.name, tableName),
    installSql: baselineSql === undefined
      ? triggerSql
      : `${baselineSql}\n\n${triggerSql}`,
    updateSql: triggerSql,
    uninstallBeforeSql: createHistoryTriggerRemovalSql(definition),
  });

  return table as DefinedHistoryTable<typeof table>;
}

/** Collects history declarations from an aggregated Drizzle schema. */
export function getHistoryTableDefinitions(
  schema: Readonly<Record<string, unknown>>,
): readonly HistoryTableDefinition[] {
  const definitions = new Set<HistoryTableDefinition>();

  for (const value of Object.values(schema)) {
    if (isDefinedHistoryTable(value)) {
      definitions.add(value[historyTableDefinition]);
    }
  }

  return [...definitions];
}

function isDefinedHistoryTable(value: unknown): value is DefinedHistoryTable<AnyPgTable> {
  return typeof value === "object"
    && value !== null
    && historyTableDefinition in value;
}

function cloneHistoryColumns<Source extends AnyPgTable>(
  source: Source,
  columns: readonly AnyPgColumn[],
): HistoryColumnBuilders<Source> {
  const sourceColumns = getTableColumns(source);
  const supportedColumns = new Set(columns);
  const clonedEntries = Object.entries(sourceColumns).map(([key, column]) => {
    if (!supportedColumns.has(column)) {
      throw new TypeError(
        `History column ${getTableConfig(source).name}.${key} is not part of the source table.`,
      );
    }

    const sqlType = getHistorySqlType(column, getTableConfig(source).name, key);
    const historyType = customType<CustomTypeValues>({
      dataType: () => sqlType,
      fromDriver: (value) => column.mapFromDriverValue(value),
      toDriver: (value) => column.mapToDriverValue(value),
    });

    return [key, historyType(column.name)] as const;
  });

  return Object.fromEntries(clonedEntries) as HistoryColumnBuilders<Source>;
}

/**
 * Keeps the initial implementation explicit and rejects extension-backed or
 * otherwise unknown types instead of generating a subtly incompatible table.
 */
function getHistorySqlType(
  column: AnyPgColumn,
  tableName: string,
  key: string,
): string {
  const possibleEnumColumn = column as AnyPgColumn & {
    readonly enum?: unknown;
  };
  if (isPgEnum(possibleEnumColumn.enum)) {
    const enumSchema = possibleEnumColumn.enum.schema;
    return enumSchema === undefined
      ? quoteSqlIdentifier(possibleEnumColumn.enum.enumName)
      : `${quoteSqlIdentifier(enumSchema)}.${quoteSqlIdentifier(possibleEnumColumn.enum.enumName)}`;
  }

  const sqlType = column.getSQLType();
  const normalizedType = normalizeSerialType(sqlType);

  if (!isSupportedSqlType(normalizedType)) {
    throw new TypeError(
      `History does not support PostgreSQL type "${sqlType}" for ${tableName}.${key}.`,
    );
  }

  return normalizedType;
}

function normalizeSerialType(sqlType: string): string {
  switch (sqlType) {
    case "smallserial":
      return "smallint";
    case "serial":
      return "integer";
    case "bigserial":
      return "bigint";
    default:
      return sqlType;
  }
}

function isSupportedSqlType(sqlType: string): boolean {
  const scalar = sqlType.replace(/\[[0-9]*\]$/u, "");
  return /^(?:smallint|integer|bigint|real|double precision|boolean|text|uuid|json|jsonb|bytea|date|inet|cidr|macaddr|macaddr8)$/u.test(scalar)
    || /^(?:character varying|varchar|character|char|bit|bit varying)(?:\([0-9]+\))?$/u.test(scalar)
    || /^(?:numeric|decimal)(?:\([0-9]+(?:,[0-9]+)?\))?$/u.test(scalar)
    || /^(?:timestamp|time)(?:\([0-6]\))?(?: with(?:out)? time zone)?$/u.test(scalar)
    || /^interval(?: [a-z ]+)?(?:\([0-6]\))?$/u.test(scalar);
}

function resolveIdentityKeys<Source extends AnyPgTable>(
  source: Source,
  configuredIdentity: readonly TableColumn<Source>[] | undefined,
  sourceEntries: readonly [string, AnyPgColumn][],
): readonly string[] {
  const identity = configuredIdentity ?? inferPrimaryKeyColumns(source);

  if (identity.length === 0) {
    throw new TypeError(
      `History table ${getTableConfig(source).name} requires at least one identity column.`,
    );
  }

  const keys = identity.map((identityColumn) => {
    const entry = sourceEntries.find(([, column]) => column === identityColumn);
    if (entry === undefined) {
      throw new TypeError("Every history identity column must belong to the source table.");
    }
    return entry[0];
  });

  if (new Set(keys).size !== keys.length) {
    throw new TypeError("History identity columns must be unique.");
  }

  return keys;
}

function inferPrimaryKeyColumns(source: AnyPgTable): readonly AnyPgColumn[] {
  const config = getTableConfig(source);
  const inlinePrimaryKeys = config.columns.filter((column) => column.primary);
  const compositePrimaryKeys = config.primaryKeys.flatMap((key) => key.columns);
  return [...new Set([...inlinePrimaryKeys, ...compositePrimaryKeys])];
}

function assertReservedNamesAvailable(columns: readonly AnyPgColumn[]): void {
  for (const column of columns) {
    if (column.name.startsWith("__")) {
      throw new TypeError(
        `Source column "${column.name}" uses the reserved history prefix "__".`,
      );
    }
  }
}

function assertReservedKeysAvailable(keys: readonly string[]): void {
  for (const key of keys) {
    if (key.startsWith("__")) {
      throw new TypeError(
        `Source property "${key}" uses the reserved history prefix "__".`,
      );
    }
  }
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function encodeHistoryOperation(operation: HistoryOperation): number {
  switch (operation) {
    case "insert":
      return 1;
    case "update":
      return 2;
    case "delete":
      return 3;
  }
}

function decodeHistoryOperation(value: number): HistoryOperation {
  switch (value) {
    case 1:
      return "insert";
    case 2:
      return "update";
    case 3:
      return "delete";
    default:
      throw new TypeError(`Unknown database history operation code "${value}".`);
  }
}

function createIndexName(schema: string | undefined, table: string): string {
  const prefix = schema === undefined ? table : `${schema}_${table}`;
  return truncateIdentifier(`${prefix}_identity_sequence_idx`);
}

function createContributionId(
  schema: string | undefined,
  sourceTable: string,
  historyTable: string,
): string {
  return `postgres.history:${schema ?? "public"}.${sourceTable}:${historyTable}`;
}

function createOperationCheckName(
  schema: string | undefined,
  table: string,
): string {
  const prefix = schema === undefined ? table : `${schema}_${table}`;
  return truncateIdentifier(`${prefix}_operation_check`);
}

function truncateIdentifier(identifier: string): string {
  if (identifier.length <= 63) {
    return identifier;
  }

  let hash = 0;
  for (const character of identifier) {
    hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  }
  const suffix = hash.toString(16).padStart(8, "0");
  return `${identifier.slice(0, 54)}_${suffix}`;
}
