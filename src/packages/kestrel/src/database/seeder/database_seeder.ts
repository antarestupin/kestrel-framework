import { isDeepStrictEqual } from "node:util";
import { getTableColumns, sql } from "drizzle-orm";
import { getTableConfig, type PgDatabase } from "drizzle-orm/pg-core";
import { seed } from "drizzle-seed";

import { isObject } from "../../utils/definitions.js";
import type {
  DatabaseGeneratedSeedStep,
  DatabaseRecordSeedStep,
  DatabaseSeedDefinition,
  DatabaseSeedGenerators,
  DatabaseSeedOptions,
  DatabaseSeedRecordReference,
  DatabaseSeedStep,
} from "./definition.js";

/** Executes an ordered seed declaration and resolves generated references. */
export async function seedDatabase(
  database: PgDatabase<any, any>,
  definition: DatabaseSeedDefinition,
  options: DatabaseSeedOptions = {},
): Promise<void> {
  validateSteps(definition.steps);
  const operation = async (executor: PgDatabase<any, any>) => {
    await assertTablesAreEmpty(executor, definition.steps);
    await executeSeed(executor, definition, options.now ?? new Date());
  };

  if (options.transaction === false) {
    await operation(database);
    return;
  }

  await database.transaction(operation);
}

/** Checks each step's metadata before any seed writes, even for a reused physical table. */
function validateSteps(steps: readonly DatabaseSeedStep[]): void {
  const keys = new Set<string>();

  for (const step of steps) {
    if (keys.has(step.key)) {
      throw new Error(`Duplicate seed step '${step.key}'.`);
    }

    resolveIdentity(step);
    keys.add(step.key);
  }
}

/** Executes the already-validated seed graph inside the caller's boundary. */
async function executeSeed(
  database: PgDatabase<any, any>,
  definition: DatabaseSeedDefinition,
  now: Date,
): Promise<void> {
  const identities = new Map<string, unknown[]>();
  const recordIdentities = new Map<string, unknown>();

  for (const step of definition.steps) {
    if (step.type === "records") {
      const values = await insertRecords(
        database,
        step,
        now,
        recordIdentities,
      );

      identities.set(step.key, values);
      continue;
    }

    validateReferences(step, identities);
    // Prior steps or their triggers can populate this table after the empty-table preflight.
    const previousIdentities = await selectIdentities(database, step);
    const schema = { [step.key]: step.insertionTable };

    await seed(database, schema, {
      ...(definition.seed === undefined ? {} : { seed: definition.seed }),
      ...(definition.version === undefined ? {} : { version: definition.version }),
    }).refine((generators) => ({
      [step.key]: {
        count: step.count,
        columns: {
          ...step.columns?.(generators),
          ...createReferenceGenerators(step, identities, generators),
        },
      },
    }) as never);

    const insertedIdentities = await selectIdentities(database, step);
    identities.set(step.key, excludePreviousIdentities(insertedIdentities, previousIdentities));
  }
}

/** Rejects ambiguous incremental seeding before the first insert occurs. */
async function assertTablesAreEmpty(
  database: PgDatabase<any, any>,
  steps: readonly DatabaseSeedStep[],
): Promise<void> {
  const visited = new Set<string>();

  for (const step of steps) {
    const { schema = "public", name } = getTableConfig(step.table);
    // Quoted identifiers can contain dots, so preserve the schema and name boundaries.
    const tableKey = JSON.stringify([schema, name]);

    if (visited.has(tableKey)) {
      continue;
    }

    visited.add(tableKey);
    const rows = await database
      .select({ present: sql<number>`1` })
      .from(step.table)
      .limit(1);

    if (rows.length !== 0) {
      throw new Error(
        `Cannot seed non-empty table '${schema}.${name}'. Reset the database before seeding.`,
      );
    }
  }
}

/** Compares database identities by value, including decoded byte arrays and custom values. */
function excludePreviousIdentities(current: unknown[], previous: readonly unknown[]): unknown[] {
  if (previous.length === 0) return current;
  const existing = new Set(previous);
  const structured = previous.filter(isObject);
  return current.filter((value) => !existing.has(value)
    && (!isObject(value)
      || !structured.some((oldValue) => isDeepStrictEqual(oldValue, value))));
}

/** Inserts curated rows individually so returned identities keep their aliases. */
async function insertRecords(
  database: PgDatabase<any, any>,
  step: DatabaseRecordSeedStep,
  now: Date,
  identities: Map<string, unknown>,
): Promise<unknown[]> {
  const records = step.records({ now: new Date(now) });
  const insertedIdentities: unknown[] = [];
  const identity = resolveIdentity(step);

  for (const record of records) {
    const recordKey = recordIdentityKey(step.key, record.key);
    const recordLabel = `${step.key}.${record.key}`;

    if (identities.has(recordKey)) {
      throw new Error(`Duplicate seed record '${recordLabel}'.`);
    }

    const references = resolveRecordReferences(
      recordLabel,
      record.references,
      identities,
    );
    const inserted = await database
      .insert(step.table)
      .values({ ...record.values, ...references } as never)
      .returning({ value: identity });
    const value = inserted[0]?.value;

    if (value === undefined) {
      throw new Error(`Seed record '${recordLabel}' returned no identity.`);
    }

    identities.set(recordKey, value);
    insertedIdentities.push(value);
  }

  return insertedIdentities;
}

/** Resolves exact references to records completed by earlier seed steps. */
function resolveRecordReferences(
  record: string,
  references: Readonly<Record<string, DatabaseSeedRecordReference>> | undefined,
  identities: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(references ?? {}).map(([column, reference]) => {
      const value = identities.get(recordIdentityKey(reference.step, reference.record));

      if (value === undefined) {
        throw new Error(
          `Seed record '${record}' references unavailable record '${reference.step}.${reference.record}'.`,
        );
      }

      return [column, value];
    }),
  );
}

/** A record alias is unique within its step, including when either key contains dots. */
function recordIdentityKey(step: string, record: string): string {
  return JSON.stringify([step, record]);
}

/** Converts declarative references into Drizzle Seed value generators. */
function createReferenceGenerators(
  step: DatabaseGeneratedSeedStep,
  identities: ReadonlyMap<string, unknown[]>,
  generators: DatabaseSeedGenerators,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(step.references ?? {}).map(([column, reference]) => [
      column,
      generators.valuesFromArray({
        values: identities.get(reference)! as never[],
      }),
    ]),
  );
}

/** Fails before insertion when a declaration references a later or empty step. */
function validateReferences(
  step: DatabaseGeneratedSeedStep,
  identities: ReadonlyMap<string, unknown[]>,
): void {
  for (const reference of Object.values(step.references ?? {})) {
    const values = identities.get(reference);

    if (values === undefined || values.length === 0) {
      throw new Error(
        `Seed step '${step.key}' references unavailable step '${reference}'.`,
      );
    }
  }
}

/** Reads identities created by database defaults for downstream steps. */
async function selectIdentities(
  database: PgDatabase<any, any>,
  step: DatabaseSeedStep,
): Promise<unknown[]> {
  const identity = resolveIdentity(step);

  const rows = await database
    .select({ value: identity })
    .from(step.table);

  return rows.map(({ value }) => value);
}

/** Finds the default or explicitly configured identity for a seed table. */
function resolveIdentity(step: DatabaseSeedStep) {
  const identity = step.identity ?? getTableColumns(step.table).id;

  if (identity === undefined) {
    throw new Error(
      `Seed step '${step.key}' must declare an identity column.`,
    );
  }

  return identity;
}
