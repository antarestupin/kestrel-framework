import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgSchema } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineUnloggedTable } from "../../db/schema_contributions/index.js";
import { LocalDatabaseMaintenance } from "./database_maintenance.js";
import { resetDatabase } from "./database_resetter.js";
import { defineDatabaseMaintenance } from "./definition.js";

let migrationsFolder: string | undefined;

beforeEach(async () => {
  // Let the real migrator read a journal while keeping all destructive SQL on a test double.
  migrationsFolder = await mkdtemp(join(tmpdir(), "kestrel-reset-"));
  await mkdir(join(migrationsFolder, "meta"));
  await writeFile(join(migrationsFolder, "meta", "_journal.json"), JSON.stringify({
    entries: [{ tag: "0000_initial", when: 1_000, breakpoints: false }],
  }));
  await writeFile(join(migrationsFolder, "0000_initial.sql"), "SELECT 1;");
});

afterEach(async () => {
  vi.doUnmock("drizzle-kit/api");
  if (migrationsFolder !== undefined) await rm(migrationsFolder, { recursive: true, force: true });
  migrationsFolder = undefined;
});

function resetFixture() {
  const events: string[] = [];
  const query = vi.fn(async (statement: string) => { events.push(statement); });
  const migrate = vi.fn(async () => { events.push("migrate"); });
  const database = { dialect: { migrate }, session: {} } as unknown as NodePgDatabase;
  const pool = { query } as unknown as Pool;
  return { database, events, migrate, pool, query };
}

describe("resetDatabase", () => {
  it("quotes exactly the declared schemas and recreates public before running migrations", async () => {
    const { pool, database, events, migrate } = resetFixture();
    const pushSchema = vi.fn();
    vi.doMock("drizzle-kit/api", () => ({ pushSchema }));
    const definition = { migrationsFolder: migrationsFolder! };

    await resetDatabase(pool, database, { schemas: ['local"archive', "public"] }, definition);

    expect(events).toEqual([
      'DROP SCHEMA IF EXISTS "local""archive" CASCADE;\nDROP SCHEMA IF EXISTS "public" CASCADE;\nCREATE SCHEMA public;',
      "migrate",
    ]);
    expect(migrate).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ sql: ["SELECT 1;"], folderMillis: 1_000 }),
    ], expect.any(Object), definition);
    expect(pushSchema).not.toHaveBeenCalled();
  });

  it.each([
    { filters: { schemaFilter: ["development"], tablesFilter: ["entry"] } },
    { filters: {} },
  ])("pushes local tables before replaying schema contributions ($filters)", async ({ filters }) => {
    const { pool, database, events } = resetFixture();
    const entry = defineUnloggedTable(pgSchema("development").table("entry", { id: integer().primaryKey() }));
    const apply = vi.fn(async () => { events.push("apply push"); });
    const pushSchema = vi.fn(async () => {
      events.push("plan push");
      return { apply };
    });
    vi.doMock("drizzle-kit/api", () => ({ pushSchema }));

    await resetDatabase(pool, database, {
      schemas: ["development"],
      push: { schema: { entry }, ...filters },
    }, { migrationsFolder: migrationsFolder! });

    expect(pushSchema).toHaveBeenCalledExactlyOnceWith({ entry }, database, filters.schemaFilter, filters.tablesFilter);
    expect(events).toEqual([
      'DROP SCHEMA IF EXISTS "development" CASCADE;',
      "migrate", "plan push", "apply push",
      'ALTER TABLE "development"."entry" SET UNLOGGED;',
    ]);
  });

  it("does not apply table contributions when the local push fails", async () => {
    const { pool, database, query } = resetFixture();
    const entry = defineUnloggedTable(pgSchema("development").table("entry", { id: integer().primaryKey() }));
    const failure = new Error("local schema push failed");
    vi.doMock("drizzle-kit/api", () => ({
      pushSchema: async () => ({ apply: async () => { throw failure; } }),
    }));

    await expect(resetDatabase(pool, database, {
      schemas: ["development"], push: { schema: { entry } },
    }, { migrationsFolder: migrationsFolder! })).rejects.toBe(failure);
    expect(query).toHaveBeenCalledExactlyOnceWith('DROP SCHEMA IF EXISTS "development" CASCADE;');
  });
});

describe("LocalDatabaseMaintenance", () => {
  it("runs migrations outside the local environment without resetting or seeding", async () => {
    const { pool, database, events } = resetFixture();
    const definition = {
      migration: { migrationsFolder: migrationsFolder! },
      reset: { schemas: ["public"] },
      seed: { steps: [] },
    };
    expect(defineDatabaseMaintenance(definition)).toBe(definition);
    const maintenance = new LocalDatabaseMaintenance({ database, environment: "prod", pool }, definition);

    await maintenance.migrate();

    // Deployment migrations are permitted in every environment.
    expect(events).toEqual(["migrate"]);
  });

  it("resets and migrates before opening the seed transaction", async () => {
    const { pool, database, events } = resetFixture();
    const executor = Object.assign(database, {
      async transaction(operation: (executor: NodePgDatabase) => Promise<void>) {
        events.push("seed");
        await operation(database);
      },
    });
    const maintenance = new LocalDatabaseMaintenance({ database: executor, environment: "local", pool }, {
      migration: { migrationsFolder: migrationsFolder! },
      reset: { schemas: ["development"] },
      seed: { steps: [] },
    });

    await maintenance.resetAndSeed();

    expect(events).toEqual(['DROP SCHEMA IF EXISTS "development" CASCADE;', "migrate", "seed"]);
  });
});
