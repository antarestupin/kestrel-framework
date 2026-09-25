import type {
  AnyPgColumn,
  AnyPgTable,
  PgDatabase,
} from "drizzle-orm/pg-core";
import { seed } from "drizzle-seed";

import type { DatabaseMigrationDefinition } from "../migrator/index.js";

type SeedResult = ReturnType<typeof seed<
  PgDatabase<any, any>,
  { table: AnyPgTable },
  "2"
>>;

/** Generator collection exposed by the installed Drizzle Seed version. */
export type DatabaseSeedGenerators = Parameters<
  Parameters<SeedResult["refine"]>[0]
>[0];

/** Shared values available while materializing explicit seed records. */
export interface DatabaseSeedContext {
  readonly now: Date;
}

/** Points to one explicit record declared by an earlier seed step. */
export interface DatabaseSeedRecordReference {
  readonly step: string;
  readonly record: string;
}

/** Declares one named record and its exact relationships. */
export interface DatabaseSeedRecord {
  readonly key: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly references?: Readonly<
    Record<string, DatabaseSeedRecordReference>
  >;
}

interface DatabaseSeedStepBase {
  /** Stable definition key used by later foreign-key references. */
  readonly key: string;
  /** Actual table queried after insertion to collect generated identities. */
  readonly table: AnyPgTable;
  /** Generated identity collected for later references. Defaults to `id`. */
  readonly identity?: AnyPgColumn;
}

/** Generates interchangeable records with Drizzle Seed. */
export interface DatabaseGeneratedSeedStep extends DatabaseSeedStepBase {
  readonly type?: "generated";
  /** Projection of the table containing only values Drizzle Seed inserts. */
  readonly insertionTable: AnyPgTable;
  readonly count: number;
  readonly columns?: (
    generators: DatabaseSeedGenerators,
  ) => Record<string, unknown>;
  /** Maps insertion columns to previously completed step keys. */
  readonly references?: Readonly<Record<string, string>>;
}

/** Inserts curated records whose relationships must remain exact. */
export interface DatabaseRecordSeedStep extends DatabaseSeedStepBase {
  readonly type: "records";
  readonly records: (
    context: DatabaseSeedContext,
  ) => readonly DatabaseSeedRecord[];
}

export type DatabaseSeedStep =
  | DatabaseGeneratedSeedStep
  | DatabaseRecordSeedStep;

export interface DatabaseSeedDefinition {
  readonly seed?: number;
  readonly version?: "1" | "2";
  readonly steps: readonly DatabaseSeedStep[];
}

export interface DatabaseSeedOptions {
  /** Reference time shared by every explicit record. Defaults to now. */
  readonly now?: Date;
  /** Disable the internal transaction when the caller already owns one. */
  readonly transaction?: boolean;
}

/** Defines a deterministic, ordered PostgreSQL seed plan. */
export function defineDatabaseSeed<
  const Definition extends DatabaseSeedDefinition,
>(definition: Definition): Definition {
  return definition;
}

export interface DatabaseResetDefinition {
  readonly schemas: readonly string[];
  readonly push?: {
    readonly schema: Readonly<Record<string, unknown>>;
    readonly schemaFilter?: readonly string[];
    readonly tablesFilter?: readonly string[];
  };
}

export interface DatabaseMaintenanceDefinition {
  readonly migration: DatabaseMigrationDefinition;
  readonly reset: DatabaseResetDefinition;
  readonly seed: DatabaseSeedDefinition;
}

/** Combines application declarations used by generic maintenance workflows. */
export function defineDatabaseMaintenance<
  const Definition extends DatabaseMaintenanceDefinition,
>(definition: Definition): Definition {
  return definition;
}
