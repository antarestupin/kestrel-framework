import { readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import pg from "pg";

import { resolvePostgresTestDestination } from "./postgres-destination-guard.mjs";

/** Keep ownership names short, SQL-safe and unique across Stryker worker restarts. */
export function mutationDatabaseName(runId, workerId) {
  if (!/^[a-f0-9]{16}$/u.test(runId) || !/^(?:0|[1-9]\d{0,8})$/u.test(workerId)) {
    throw new Error("Invalid mutation database ownership identifiers.");
  }
  return `kestrel_test_mutation_${runId}_${workerId}`;
}

function adminConfig(environment) {
  const destination = resolvePostgresTestDestination(environment);
  const ssl = environment.DB_SSL ?? "false";
  if (!/^(?:true|false|1|0|yes|no|on|off|y|n|enabled|disabled)$/iu.test(String(ssl))) {
    throw new Error("Invalid PostgreSQL test TLS setting.");
  }
  return {
    ...destination, database: "postgres", password: environment.DB_PASSWORD ?? "postgres",
    ssl: /^(?:true|1|yes|on|y|enabled)$/iu.test(String(ssl)),
    connectionTimeoutMillis: 5_000, query_timeout: 10_000,
  };
}

function ownership(environment) {
  const runId = environment.KESTREL_MUTATION_RUN_ID;
  const directory = environment.KESTREL_MUTATION_DATABASE_MANIFEST;
  mutationDatabaseName(runId, "0");
  if (!directory || !isAbsolute(directory)) throw new Error("Missing mutation database ownership manifest.");
  return { runId, directory };
}

/** Provision through postgres only; the manifest survives failed or killed test workers. */
export async function provisionMutationDatabase(environment = process.env, createClient = (config) => new pg.Client(config)) {
  const { runId, directory } = ownership(environment);
  const database = mutationDatabaseName(runId, environment.STRYKER_MUTATOR_WORKER);
  const manifest = join(directory, `${database}.json`);
  const client = createClient(adminConfig(environment));
  try {
    await client.connect();
    let recorded = false;
    try {
      recorded = (await readFile(manifest, "utf8")) === JSON.stringify({ runId, database });
      if (!recorded) throw new Error("Invalid mutation database ownership record.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (existing.rowCount > 0 && !recorded) throw new Error("Refusing to adopt an existing mutation database.");
    if (!recorded) {
      // Record before CREATE so interruption after successful provisioning remains recoverable.
      await writeFile(manifest, JSON.stringify({ runId, database }), { flag: "wx", mode: 0o600 });
    }
    if (existing.rowCount === 0) {
      try { await client.query(`CREATE DATABASE "${database}"`); }
      catch (error) {
        // A competing creator must never turn a new record into ownership of its database.
        if (!recorded && error.code === "42P04") await unlink(manifest);
        throw error;
      }
    }
    return database;
  } finally { await client.end(); }
}

/** Drop only exact databases recorded by this wrapper run, never a prefix scan. */
export async function cleanupMutationDatabases(environment, createClient = (config) => new pg.Client(config)) {
  const { runId, directory } = ownership(environment);
  const records = await Promise.all((await readdir(directory)).map(async (file) => {
    const record = JSON.parse(await readFile(join(directory, file), "utf8"));
    const workerId = record.database?.slice(`kestrel_test_mutation_${runId}_`.length);
    if (record.runId !== runId || record.database !== mutationDatabaseName(runId, workerId)
      || file !== `${record.database}.json`) throw new Error("Invalid mutation database ownership record.");
    return { database: record.database, file };
  }));
  if (records.length) {
    const client = createClient(adminConfig(environment));
    try {
      await client.connect();
      for (const { database, file } of records) {
        await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await unlink(join(directory, file));
      }
    } finally { await client.end(); }
  }
  await rmdir(directory);
}
