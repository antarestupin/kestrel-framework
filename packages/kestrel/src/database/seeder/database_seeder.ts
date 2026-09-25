import {
  getTableColumns,
  getTableUniqueName,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { seed } from "drizzle-seed";

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
  validateStepKeys(definition.steps);
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

/** Rejects ambiguous definition keys before opening the transaction. */
function validateStepKeys(steps: readonly DatabaseSeedStep[]): void {
  const keys = new Set<string>();

  for (const step of steps) {
    if (keys.has(step.key)) {
      throw new Error(`Duplicate seed step '${step.key}'.`);
    }

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
    const schema = { [step.key]: step.insertionTable };

    await seed(database, schema, {
      ...(definition.seed === undefined ? {} : { seed: definition.seed }),
      ...(definition.version === undefined
        ? {}
        : { version: definition.version }),
    }).refine((generators) => ({
      [step.key]: {
        count: step.count,
        columns: {
          ...step.columns?.(generators),
          ...createReferenceGenerators(step, identities, generators),
        },
      },
    }) as never);

    identities.set(step.key, await selectIdentities(database, step));
  }
}

/** Rejects ambiguous incremental seeding before the first insert occurs. */
async function assertTablesAreEmpty(
  database: PgDatabase<any, any>,
  steps: readonly DatabaseSeedStep[],
): Promise<void> {
  const visited = new Set<string>();

  for (const step of steps) {
    const tableName = getTableUniqueName(step.table);

    if (visited.has(tableName)) {
      continue;
    }

    visited.add(tableName);
    const identity = resolveIdentity(step);
    const rows = await database
      .select({ value: identity })
      .from(step.table)
      .limit(1);

    if (rows.length !== 0) {
      throw new Error(
        `Cannot seed non-empty table '${tableName}'. Reset the database before seeding.`,
      );
    }
  }
}

/** Inserts curated rows individually so returned identities keep their aliases. */
async function insertRecords(
  database: PgDatabase<any, any>,
  step: DatabaseRecordSeedStep,
  now: Date,
  identities: Map<string, unknown>,
): Promise<unknown[]> {
  const records = step.records({ now: new Date(now) });
  const recordKeys = new Set<string>();
  const insertedIdentities: unknown[] = [];
  const identity = resolveIdentity(step);

  for (const record of records) {
    const qualifiedKey = qualifyRecord(step.key, record.key);

    if (recordKeys.has(record.key) || identities.has(qualifiedKey)) {
      throw new Error(`Duplicate seed record '${qualifiedKey}'.`);
    }

    recordKeys.add(record.key);
    const references = resolveRecordReferences(
      qualifiedKey,
      record.references,
      identities,
    );
    const inserted = await database
      .insert(step.table)
      .values({ ...record.values, ...references } as never)
      .returning({ value: identity });
    const value = inserted[0]?.value;

    if (value === undefined) {
      throw new Error(`Seed record '${qualifiedKey}' returned no identity.`);
    }

    identities.set(qualifiedKey, value);
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
      const qualifiedReference = qualifyRecord(
        reference.step,
        reference.record,
      );
      const value = identities.get(qualifiedReference);

      if (value === undefined) {
        throw new Error(
          `Seed record '${record}' references unavailable record '${qualifiedReference}'.`,
        );
      }

      return [column, value];
    }),
  );
}

function qualifyRecord(step: string, record: string): string {
  return `${step}.${record}`;
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
