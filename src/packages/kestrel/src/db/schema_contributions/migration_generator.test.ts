import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integer, pgSchema } from "drizzle-orm/pg-core";
import {
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { defineDatabaseSchemaContribution } from "./definition.js";
import { defineDatabaseTableDescriptions } from "./descriptions.js";
import { defineUnloggedTable } from "./unlogged_table.js";
import {
  createMigrationSqlPlan,
  generateDatabaseMigration,
} from "./migration_generator.js";

describe("createMigrationSqlPlan", () => {
  it("orders old cleanup around Drizzle before applying the new definition", () => {
    const plan = createMigrationSqlPlan([
      {
        id: "test:object",
        installSql: "INSTALL OLD;",
        uninstallBeforeSql: "DROP OLD BEFORE;",
        uninstallAfterSql: "DROP OLD AFTER;",
      },
    ], [
      {
        id: "test:object",
        installSql: "INSTALL NEW;",
        updateSql: "UPDATE NEW;",
      },
    ]);

    expect(plan).toEqual({
      before: ["DROP OLD BEFORE;"],
      after: ["DROP OLD AFTER;", "UPDATE NEW;"],
    });
  });
});

describe("generateDatabaseMigration", () => {
  it("generates the first migration without an existing folder or journal", async () => {
    const root = await createMigrationFixture(false);
    const table = createDisposableTable("entry");
    const result = await generateDatabaseMigration({
      cwd: root,
      drizzleKitExecutable: "drizzle-kit",
      migrationsFolder: join(root, "migrations"),
      schema: { table },
      runCommand: async () => {
        // Drizzle owns creation of its output directory and first journal.
        await writeGeneratedMigration(root, "0000_initial", 'CREATE TABLE "storage"."entry" (id integer);');
      },
    });

    expect(result).toEqual({
      customContributionsChanged: true,
      migrationTag: "0000_initial",
      source: "drizzle",
    });
    const sql = await readMigration(root, "0000_initial");
    expect(sql).toContain('ALTER TABLE "storage"."entry" SET UNLOGGED;');
    expect(sql.indexOf("CREATE TABLE")).toBeLessThan(sql.indexOf("SET UNLOGGED"));
  });

  it("requires Drizzle to create the journal after the initial read", async () => {
    const root = await createMigrationFixture(false);
    await expect(generateDatabaseMigration({
      cwd: root,
      drizzleKitExecutable: "drizzle-kit",
      migrationsFolder: join(root, "migrations"),
      schema: {},
      // A successful command that leaves no journal cannot be treated as a diff.
      runCommand: async () => {},
    })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an invalid existing journal before invoking Drizzle", async () => {
    const root = await createMigrationFixture();
    await writeFile(join(root, "migrations", "meta", "_journal.json"), "invalid JSON");
    const invocations: string[][] = [];

    await expect(generateDatabaseMigration({
      cwd: root,
      drizzleKitExecutable: "drizzle-kit",
      migrationsFolder: join(root, "migrations"),
      schema: {},
      runCommand: async (_executable, arguments_) => { invocations.push([...arguments_]); },
    })).rejects.toThrow(SyntaxError);
    expect(invocations).toEqual([]);
  });

  it("does not create or rewrite migrations on repeated unchanged generations", async () => {
    const root = await createMigrationFixture();
    const options = await installDisposableTable(root);
    const originalSql = await readMigration(root, "0000_initial");
    const snapshotPath = join(root, "migrations", "custom-meta", "0000_initial.json");
    const originalSnapshot = await readFile(snapshotPath, "utf8");
    const originalJournal = await readFile(join(root, "migrations", "meta", "_journal.json"), "utf8");
    const invocations: string[][] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await generateDatabaseMigration({
        ...options,
        runCommand: async (_executable, arguments_) => { invocations.push([...arguments_]); },
      });
      expect(result).toEqual({ customContributionsChanged: false, source: "none" });
    }

    expect(invocations).toEqual([["generate"], ["generate"]]);
    expect(await readMigration(root, "0000_initial")).toBe(originalSql);
    expect(await readFile(snapshotPath, "utf8")).toBe(originalSnapshot);
    expect(await readFile(join(root, "migrations", "meta", "_journal.json"), "utf8"))
      .toBe(originalJournal);
  });

  it("removes contributions while retaining the table and records the empty state", async () => {
    const root = await createMigrationFixture();
    const options = await installDisposableTable(root);
    const invocations: string[][] = [];
    // Keep the same physical table but remove its Kestrel annotations.
    const schema = { table: pgSchema("storage").table("entry", { id: integer("id") }) };
    const result = await generateDatabaseMigration({
      ...options,
      schema,
      runCommand: async (_executable, arguments_) => {
        invocations.push([...arguments_]);
        if (arguments_.includes("--custom")) {
          await writeGeneratedMigration(root, "0001_remove", "-- Custom migration");
        }
      },
    });

    expect(result.source).toBe("custom");
    expect(invocations).toHaveLength(2);
    const sql = await readMigration(root, "0001_remove");
    expect(sql).toContain('COMMENT ON TABLE "storage"."entry" IS NULL;');
    expect(sql).toContain('ALTER TABLE "storage"."entry" SET LOGGED;');
    expect(sql).not.toContain("SET UNLOGGED");
    expect(JSON.parse(await readFile(join(root, "migrations", "custom-meta", "0001_remove.json"), "utf8")))
      .toEqual({ version: 1, contributions: [] });
    expect(await generateDatabaseMigration({
      ...options,
      schema,
      runCommand: async (_executable, arguments_) => { invocations.push([...arguments_]); },
    })).toEqual({ customContributionsChanged: false, source: "none" });
    expect(invocations).toHaveLength(3);
  });

  it.each(["rename", "drop"] as const)("orders contribution cleanup around a table %s", async (operation) => {
    const root = await createMigrationFixture();
    const options = await installDisposableTable(root);
    const schema = operation === "rename" ? { table: createDisposableTable("renamed_entry") } : {};
    const drizzleSql = operation === "rename"
      ? 'ALTER TABLE "storage"."entry" RENAME TO "renamed_entry";'
      : 'DROP TABLE "storage"."entry";';

    const result = await generateDatabaseMigration({
      ...options,
      schema,
      runCommand: async () => {
        // Supply Drizzle's rename/drop decision; the wrapper must preserve it.
        await writeGeneratedMigration(root, "0001_change", drizzleSql);
      },
    });

    expect(result.source).toBe("drizzle");
    const sql = await readMigration(root, "0001_change");
    const cleanup = 'COMMENT ON TABLE "storage"."entry" IS NULL;';
    expect(sql).toContain(cleanup);
    expect(sql).toContain(drizzleSql);
    expect(sql.indexOf(cleanup)).toBeLessThan(sql.indexOf(drizzleSql));
    // The old name may no longer exist after Drizzle's DDL.
    const guardedCleanup = `IF to_regclass('"storage"."entry"') IS NOT NULL THEN`;
    expect(sql).toContain(guardedCleanup);
    expect(sql.indexOf(drizzleSql)).toBeLessThan(sql.indexOf(guardedCleanup));
    if (operation === "rename") {
      const installation = 'ALTER TABLE "storage"."renamed_entry" SET UNLOGGED;';
      expect(sql).toContain(installation);
      expect(sql.indexOf(guardedCleanup)).toBeLessThan(sql.indexOf(installation));
      expect(sql).toContain('COMMENT ON TABLE "storage"."renamed_entry" IS');
    } else {
      expect(sql).not.toContain("SET UNLOGGED");
    }
    expect(await generateDatabaseMigration({ ...options, schema, runCommand: async () => {} }))
      .toEqual({ customContributionsChanged: false, source: "none" });
  });

  it("appends contributions to the schema migration Drizzle just created", async () => {
    const root = await createMigrationFixture();
    const target = defineDatabaseSchemaContribution({}, {
      id: "test:alongside-drizzle",
      installSql: "CREATE FUNCTION custom_function();",
    });
    const invocations: string[][] = [];

    const result = await generateDatabaseMigration({
      cwd: root,
      drizzleKitExecutable: "drizzle-kit",
      migrationsFolder: join(root, "migrations"),
      schema: { target },
      runCommand: async (_executable, arguments_) => {
        invocations.push([...arguments_]);
        await writeJournal(root, [{ idx: 0, tag: "0000_schema_change" }]);
        await writeFile(
          join(root, "migrations", "0000_schema_change.sql"),
          "CREATE TABLE example (id integer);\n",
        );
      },
    });

    expect(result.source).toBe("drizzle");
    expect(invocations).toEqual([["generate"]]);
    const migrationSql = await readFile(
      join(root, "migrations", "0000_schema_change.sql"),
      "utf8",
    );
    expect(migrationSql.indexOf("CREATE TABLE example"))
      .toBeLessThan(migrationSql.indexOf("CREATE FUNCTION custom_function"));
  });

  it("creates and fills a custom migration when Drizzle has no table diff", async () => {
    const root = await createMigrationFixture();
    const target = defineDatabaseSchemaContribution({}, {
      id: "test:custom",
      installSql: "SELECT 'installed';",
    });
    const invocations: string[][] = [];

    const result = await generateDatabaseMigration({
      cwd: root,
      drizzleKitExecutable: "drizzle-kit",
      migrationsFolder: join(root, "migrations"),
      schema: { target },
      runCommand: async (_executable, arguments_) => {
        invocations.push([...arguments_]);
        if (arguments_.includes("--custom")) {
          await writeJournal(root, [{
            idx: 0,
            tag: "0000_database_schema_contributions",
          }]);
          await writeFile(
            join(root, "migrations", "0000_database_schema_contributions.sql"),
            "-- Custom SQL migration file, put your code below! --\n",
          );
        }
      },
    });

    expect(result).toEqual({
      customContributionsChanged: true,
      migrationTag: "0000_database_schema_contributions",
      source: "custom",
    });
    expect(invocations).toEqual([
      ["generate"],
      [
        "generate",
        "--custom",
        "--name=database_schema_contributions",
      ],
    ]);
    const migrationSql = await readFile(
      join(root, "migrations", "0000_database_schema_contributions.sql"),
      "utf8",
    );
    expect(migrationSql).toContain("custom schema changes after Drizzle");
    expect(migrationSql).toContain("SELECT 'installed';");
    expect(migrationSql).toContain("-- database-schema-contributions: ");
    await expect(readFile(
      join(
        root,
        "migrations",
        "custom-meta",
        "0000_database_schema_contributions.json",
      ),
      "utf8",
    )).resolves.toContain('"id": "test:custom"');
  });
});

async function createMigrationFixture(withJournal = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "database-migration-"));
  // Keep cleanup scoped to each test, including when isolation is disabled.
  onTestFinished(async () => { await rm(root, { force: true, recursive: true }); });
  if (withJournal) await writeJournal(root, []);
  return root;
}

function createDisposableTable(name: string) {
  return defineDatabaseTableDescriptions(
    defineUnloggedTable(pgSchema("storage").table(name, { id: integer("id") })),
    { description: "Disposable entries." },
  );
}

async function installDisposableTable(root: string) {
  const options = {
    cwd: root,
    drizzleKitExecutable: "drizzle-kit",
    migrationsFolder: join(root, "migrations"),
    schema: { table: createDisposableTable("entry") },
  };
  await generateDatabaseMigration({
    ...options,
    runCommand: async () => {
      await writeGeneratedMigration(root, "0000_initial", 'CREATE TABLE "storage"."entry" (id integer);');
    },
  });
  return options;
}

async function readMigration(root: string, tag: string): Promise<string> {
  return readFile(join(root, "migrations", `${tag}.sql`), "utf8");
}

async function writeGeneratedMigration(root: string, tag: string, sql: string): Promise<void> {
  // Model only the files emitted by Drizzle, without running a database server.
  const entries = tag.startsWith("0000_")
    ? [{ idx: 0, tag }]
    : [{ idx: 0, tag: "0000_initial" }, { idx: 1, tag }];
  await writeJournal(root, entries);
  await writeFile(join(root, "migrations", `${tag}.sql`), `${sql}\n`);
}

async function writeJournal(
  root: string,
  entries: readonly { readonly idx: number; readonly tag: string }[],
): Promise<void> {
  await mkdir(join(root, "migrations", "meta"), { recursive: true });
  await writeFile(
    join(root, "migrations", "meta", "_journal.json"),
    JSON.stringify({ entries }),
    "utf8",
  );
}
