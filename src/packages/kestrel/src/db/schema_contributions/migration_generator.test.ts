import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integer, pgSchema, text } from "drizzle-orm/pg-core";
import {
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { defineDatabaseSchemaContribution, getDatabaseSchemaContributions, type DatabaseSchemaContribution } from "./definition.js";
import { defineDatabaseSchemaDescription, defineDatabaseTableDescriptions } from "./descriptions.js";
import { descriptionContributionsEqual } from "./description_diff.js";
import { defineUnloggedTable } from "./unlogged_table.js";
import {
  createMigrationSqlPlan,
  generateDatabaseMigration,
} from "./migration_generator.js";

describe("createMigrationSqlPlan", () => {
  it("adds only a new column comment and directly replaces a changed comment", () => {
    const previous = describedTable({ description: "Entries.", columns: { title: "Old title.", body: "Unchanged body." } });
    const current = describedTable({ description: "Entries.", columns: { title: "New title.", body: "Unchanged body.", added: "New column." } });
    expect(createMigrationSqlPlan(previous, current)).toEqual({
      before: [],
      after: [
        'COMMENT ON COLUMN "content"."entry"."title" IS \'New title.\';',
        'COMMENT ON COLUMN "content"."entry"."added" IS \'New column.\';',
      ],
    });
  });

  it("clears only removed descriptions, including the table description", () => {
    const previous = describedTable({ description: "Entries.", columns: { title: "Title.", body: "Body." } });
    const current = describedTable({ columns: { title: "Title." } });
    expect(createMigrationSqlPlan(previous, current)).toEqual({
      before: ['COMMENT ON TABLE "content"."entry" IS NULL;', 'COMMENT ON COLUMN "content"."entry"."body" IS NULL;'],
      after: [],
    });
    expect(createMigrationSqlPlan(previous, [])).toEqual({ before: [previous[0]!.uninstallBeforeSql], after: [] });
  });

  it("handles added, removed and changed targets together without touching stable comments", () => {
    expect(createMigrationSqlPlan(
      describedTable({ description: "Entries.", columns: { title: "Old title.", body: "Removed body." } }),
      describedTable({ description: "Entries.", columns: { title: "New title.", added: "Added column." } }),
    )).toEqual({
      before: ['COMMENT ON COLUMN "content"."entry"."body" IS NULL;'],
      after: ['COMMENT ON COLUMN "content"."entry"."title" IS \'New title.\';', 'COMMENT ON COLUMN "content"."entry"."added" IS \'Added column.\';'],
    });
  });

  it("updates schema descriptions directly and ignores harmless statement ordering", () => {
    const before = getDatabaseSchemaContributions({ schema: defineDatabaseSchemaDescription(pgSchema("content"), "Old description.") });
    const after = getDatabaseSchemaContributions({ schema: defineDatabaseSchemaDescription(pgSchema("content"), "New description.") });
    expect(createMigrationSqlPlan(before, after)).toEqual({ before: [], after: [after[0]!.installSql] });
    expect(createMigrationSqlPlan(
      describedTable({ description: "Old table description.", columns: { title: "Stable title." } }),
      describedTable({ description: "New table description.", columns: { title: "Stable title." } }),
    )).toEqual({ before: [], after: ['COMMENT ON TABLE "content"."entry" IS \'New table description.\';'] });
    const [original] = describedTable({ description: "Entries.", columns: { title: "Title.", body: "Body." } });
    const reordered = reorderDescriptions(original!);
    expect(createMigrationSqlPlan([original!], [reordered])).toEqual({ before: [], after: [] });
  });

  it("recognizes escaped identifiers and literals without splitting on embedded SQL", () => {
    const create = (description: string) => {
      const table = pgSchema('content.schema"').table('entry.name"', { title: text('title"') });
      defineDatabaseTableDescriptions(table, { description: "Stable table.", columns: { title: description } });
      return getDatabaseSchemaContributions({ table });
    };
    const previous = create("Owner's title;\nCOMMENT ON TABLE is literal text.");
    const current = create("New owner's title;\nStill literal text.");
    expect(createMigrationSqlPlan(previous, current)).toEqual({
      before: [], after: ['COMMENT ON COLUMN "content.schema"""."entry.name"""."title""" IS \'New owner\'\'s title;\nStill literal text.\';'],
    });
  });

  it("preserves replacement cleanup for customized SQL even under a description id", () => {
    const [original] = describedTable({ description: "Entries." });
    const customized = { ...original!, installSql: `${original!.installSql}\nSELECT 1;`, updateSql: "SELECT 2;" };
    expect(createMigrationSqlPlan([original!], [customized])).toEqual({ before: [original!.uninstallBeforeSql], after: ["SELECT 2;"] });
    // The recognizer must not silently discard statements after a valid comment.
    const appended = { ...customized, updateSql: customized.installSql };
    expect(createMigrationSqlPlan([original!], [appended])).toEqual({ before: [original!.uninstallBeforeSql], after: [appended.installSql] });
    const oldCustom = { ...original!, id: "application:custom-comments" };
    const newCustom = { ...oldCustom, installSql: "SELECT 3;", updateSql: "SELECT 3;" };
    expect(createMigrationSqlPlan([oldCustom], [newCustom])).toEqual({ before: [oldCustom.uninstallBeforeSql], after: [newCustom.updateSql] });
  });

  it("compares historical description bundles only when their lifecycle matches", () => {
    const [original] = describedTable({ description: "Entries." });
    const spaced = `${original!.installSql}\n `;
    expect(descriptionContributionsEqual(original!, { ...original!, installSql: spaced, updateSql: spaced })).toBe(true);

    // A duplicate statement could carry a contradictory value; preserve the full custom SQL.
    const duplicate = `${original!.installSql}\n${original!.installSql}`;
    const duplicatedCleanup = `${original!.uninstallBeforeSql}\n${original!.uninstallBeforeSql}`;
    const duplicatedBundle = { ...original!, installSql: duplicate, updateSql: duplicate, uninstallBeforeSql: duplicatedCleanup };
    expect(descriptionContributionsEqual(duplicatedBundle, duplicatedBundle)).toBe(false);
    expect(createMigrationSqlPlan([original!], [duplicatedBundle]))
      .toEqual({ before: [original!.uninstallBeforeSql], after: [duplicate] });
    const mismatchedCleanup = { ...original!, uninstallBeforeSql: "SELECT 1;" };
    expect(descriptionContributionsEqual(original!, mismatchedCleanup)).toBe(false);
    expect(descriptionContributionsEqual(original!, { ...original!, id: "postgres.table:content.other:descriptions" })).toBe(false);
  });

  it("recognizes descriptions only for managed ids and a matching cleanup lifecycle", () => {
    const [table] = describedTable({ description: "Entries." });
    const [schema] = getDatabaseSchemaContributions({
      schema: defineDatabaseSchemaDescription(pgSchema("content"), "Content."),
    });
    for (const contribution of [
      { ...table!, id: "custom.table:content.entry:descriptions" },
      { ...table!, id: "postgres.table:content.entry:custom" },
      { ...schema!, id: "custom.schema:content:description" },
      { ...schema!, id: "postgres.schema:content:custom" },
      { ...table!, uninstallAfterSql: "SELECT 1;" },
      { ...table!, uninstallBeforeSql: "SELECT 1;" },
      { ...table!, updateSql: "SELECT 1;" },
      { ...table!, installSql: "", uninstallBeforeSql: "", updateSql: "" },
    ]) {
      expect(descriptionContributionsEqual(contribution, contribution)).toBe(false);
    }
    const withoutUpdate = {
      id: table!.id, installSql: table!.installSql, uninstallBeforeSql: table!.uninstallBeforeSql!,
    };
    expect(descriptionContributionsEqual(withoutUpdate, table!)).toBe(true);
  });

  it("does not mistake a shared subset of comments for an unchanged bundle", () => {
    const [twoColumns] = describedTable({ columns: { title: "Title.", body: "Body." } });
    const [oneColumn] = describedTable({ columns: { title: "Title." } });
    const [changed] = describedTable({ columns: { title: "Title.", body: "Changed." } });
    expect(descriptionContributionsEqual(twoColumns!, oneColumn!)).toBe(false);
    expect(descriptionContributionsEqual(oneColumn!, twoColumns!)).toBe(false);
    expect(descriptionContributionsEqual(twoColumns!, changed!)).toBe(false);
  });

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

  it("reinstalls changed custom SQL when no dedicated update is defined", () => {
    const previous = { id: "test:object", installSql: "INSTALL OLD;", uninstallBeforeSql: "DROP OLD;" };
    const current = { id: previous.id, installSql: "INSTALL NEW;" };
    expect(createMigrationSqlPlan([previous], [current])).toEqual({ before: ["DROP OLD;"], after: ["INSTALL NEW;"] });
  });
});

describe("generateDatabaseMigration", () => {
  it("creates a comment-only migration for one edited description", async () => {
    const root = await createMigrationFixture();
    const previous = describedTable({ description: "Entries.", columns: { title: "Old title.", body: "Stable body." } });
    await writeGeneratedMigration(root, "0000_initial", "-- Initial migration");
    await mkdir(join(root, "migrations", "custom-meta"));
    await writeFile(join(root, "migrations", "custom-meta", "0000_initial.json"), JSON.stringify({ version: 1, contributions: previous }));
    const [current] = describedTable({ description: "Entries.", columns: { title: "New title.", body: "Stable body." } });
    const table = defineDatabaseSchemaContribution({}, current!);
    const options = { cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"), schema: { table } };
    const result = await generateDatabaseMigration({ ...options, runCommand: async (_command, args) => {
      if (args.includes("--custom")) await writeGeneratedMigration(root, "0001_comments", "-- Comment update");
    } });
    expect(result).toMatchObject({ source: "custom", customContributionsChanged: true });
    const sql = (await readMigration(root, "0001_comments")).split("-- database-schema-contributions:")[0]!;
    expect(sql.match(/COMMENT ON/gu)).toHaveLength(1);
    expect(sql).toContain('COMMENT ON COLUMN "content"."entry"."title" IS \'New title.\';');
    expect(sql).not.toContain("IS NULL");
    expect(await generateDatabaseMigration({ ...options, runCommand: async () => {} })).toEqual({ customContributionsChanged: false, source: "none" });
  });

  it.each(["embedded", "sidecar"] as const)("diffs historical bundled descriptions from a %s snapshot", async (storage) => {
    const root = await createMigrationFixture();
    const previous = describedTable({ description: "Entries.", columns: { title: "Title." } });
    await writeGeneratedMigration(root, "0000_initial", "-- Historical migration");
    const snapshot = JSON.stringify({ version: 1, contributions: previous });
    if (storage === "embedded") {
      await writeFile(join(root, "migrations", "0000_initial.sql"), `-- Historical migration\n-- database-schema-contributions: ${Buffer.from(snapshot).toString("base64url")}\n`);
    } else {
      await mkdir(join(root, "migrations", "custom-meta"));
      await writeFile(join(root, "migrations", "custom-meta", "0000_initial.json"), snapshot);
    }
    const originalSql = await readMigration(root, "0000_initial");
    const table = pgSchema("content").table("entry", { title: text("title"), added: text("added") });
    defineDatabaseTableDescriptions(table, { description: "Entries.", columns: { title: "Title.", added: "Added column." } });
    const options = { cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"), schema: { table } };
    const result = await generateDatabaseMigration({ ...options, runCommand: async () => {
      await writeGeneratedMigration(root, "0001_add", 'ALTER TABLE "content"."entry" ADD COLUMN added text;');
    } });
    expect(result.source).toBe("drizzle");
    const sql = (await readMigration(root, "0001_add")).split("-- database-schema-contributions:")[0]!;
    expect(sql.match(/COMMENT ON/gu)).toHaveLength(1);
    expect(sql).toContain('COMMENT ON COLUMN "content"."entry"."added" IS \'Added column.\';');
    expect(sql).not.toContain("IS NULL");
    expect(await readMigration(root, "0000_initial")).toBe(originalSql);
    expect(await generateDatabaseMigration({ ...options, runCommand: async () => {} })).toEqual({ customContributionsChanged: false, source: "none" });
  });

  it("does not create a metadata-only migration when comment statements are reordered", async () => {
    const root = await createMigrationFixture();
    const previous = describedTable({ description: "Entries.", columns: { title: "Title.", body: "Body." } });
    await writeGeneratedMigration(root, "0000_initial", "-- Initial migration");
    await mkdir(join(root, "migrations", "custom-meta"));
    await writeFile(join(root, "migrations", "custom-meta", "0000_initial.json"), JSON.stringify({ version: 1, contributions: previous }));
    const table = defineDatabaseSchemaContribution({}, reorderDescriptions(previous[0]!));
    const commands: string[][] = [];
    const result = await generateDatabaseMigration({ cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"), schema: { table },
      runCommand: async (_command, args) => { commands.push([...args]); },
    });
    expect(result).toEqual({ customContributionsChanged: false, source: "none" });
    expect(commands).toEqual([["generate"]]);
  });

  it.each(["rename", "drop"] as const)("clears only the affected column before its %s", async (operation) => {
    const root = await createMigrationFixture();
    const previous = describedTable({ description: "Entries.", columns: { title: "Title.", body: "Body." } });
    await writeGeneratedMigration(root, "0000_initial", "-- Initial migration");
    await mkdir(join(root, "migrations", "custom-meta"));
    await writeFile(join(root, "migrations", "custom-meta", "0000_initial.json"), JSON.stringify({ version: 1, contributions: previous }));
    const table = operation === "rename"
      ? defineDatabaseTableDescriptions(pgSchema("content").table("entry", { title: text("title"), renamed: text("renamed") }),
        { description: "Entries.", columns: { title: "Title.", renamed: "Body." } })
      : defineDatabaseTableDescriptions(pgSchema("content").table("entry", { title: text("title") }),
        { description: "Entries.", columns: { title: "Title." } });
    const ddl = operation === "rename" ? 'ALTER TABLE "content"."entry" RENAME COLUMN "body" TO "renamed";' : 'ALTER TABLE "content"."entry" DROP COLUMN "body";';
    await generateDatabaseMigration({ cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"), schema: { table }, runCommand: async () => { await writeGeneratedMigration(root, "0001_change", ddl); } });
    const sql = (await readMigration(root, "0001_change")).split("-- database-schema-contributions:")[0]!;
    const cleanup = 'COMMENT ON COLUMN "content"."entry"."body" IS NULL;';
    expect(sql).toContain(cleanup);
    expect(sql).toContain(ddl);
    expect(sql.indexOf(cleanup)).toBeLessThan(sql.indexOf(ddl));
    expect(sql).not.toContain('COMMENT ON TABLE');
    expect(sql).not.toContain('COMMENT ON COLUMN "content"."entry"."title"');
    if (operation === "rename") expect(sql.indexOf(ddl)).toBeLessThan(sql.indexOf('COMMENT ON COLUMN "content"."entry"."renamed" IS \'Body.\';'));
  });

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

  it.each([
    null, "journal", {}, { entries: {} }, { entries: [null] },
    { entries: ["tag"] }, { entries: [{ idx: "0", tag: "0000_initial" }] },
    ...["", " ", ".", "..", "nested/tag", "nested\\tag", "a\u0000b", 1].map((tag) => ({ entries: [{ idx: 0, tag }] })),
    { entries: [{ idx: 0, tag: "0000_initial" }, { idx: 1, tag: "0000_initial" }] },
  ])("rejects invalid journal shape or unsafe migration tags before invoking Drizzle (%j)", async (journal) => {
    const root = await createMigrationFixture();
    const migrationsFolder = join(root, "migrations");
    await writeFile(join(migrationsFolder, "meta", "_journal.json"), JSON.stringify(journal));
    const calls: unknown[] = [];

    await expect(generateDatabaseMigration({
      cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder, schema: {},
      runCommand: async (...args) => { calls.push(args); },
    })).rejects.toThrow(/Drizzle migration journal/u);
    expect(calls).toEqual([]);
  });

  it("rejects a generated journal tag that would rewrite a sibling file", async () => {
    const root = await createMigrationFixture();
    const outside = join(root, "outside.sql");
    const sentinel = "SELECT 'outside the migration folder';\n";
    await writeFile(outside, sentinel);

    await expect(generateDatabaseMigration({
      cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"),
      schema: { table: createDisposableTable("entry") },
      runCommand: async () => writeJournal(root, [{ idx: 0, tag: "../outside" }]),
    })).rejects.toThrow("Invalid Drizzle migration journal entry.");
    await expect(readFile(outside, "utf8")).resolves.toBe(sentinel);
  });

  it.each([false, true])("reads the managed snapshot when SQL contains a marker-like line (trailing SQL: %s)", async (appendSql) => {
    const root = await createMigrationFixture();
    const table = pgSchema("content").table("entry", { id: integer() });
    defineDatabaseTableDescriptions(table, {
      description: "A multiline description\n-- database-schema-contributions: ordinary comment text\ncontinues here.",
    });
    const options = {
      cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"),
      schema: { table },
    };
    await generateDatabaseMigration({
      ...options, runCommand: async () => writeGeneratedMigration(root, "0000_initial", "SELECT 1;"),
    });
    // An interrupted sidecar write must not prevent recovery from the SQL file.
    await rm(join(root, "migrations", "custom-meta", "0000_initial.json"));
    if (appendSql) {
      const path = join(root, "migrations", "0000_initial.sql");
      // Preserve both the delimiter and metadata when a maintainer appends a statement in a CRLF editor.
      const sql = (await readFile(path, "utf8")).replaceAll("\n", "\r\n");
      await writeFile(path, `${sql}--> statement-breakpoint\r\n-- Hand-edited migration note.\r\nSELECT 2;\r\n`);
    }
    await expect(generateDatabaseMigration({
      ...options, runCommand: async () => {},
    })).resolves.toEqual({ customContributionsChanged: false, source: "none" });
  });

  it("skips a newer migration without metadata and still reads the last managed snapshot", async () => {
    const root = await createMigrationFixture();
    const options = await installDisposableTable(root);
    await writeGeneratedMigration(root, "0001_manual", "SELECT 2;");

    await expect(generateDatabaseMigration({ ...options, runCommand: async () => {} }))
      .resolves.toEqual({ customContributionsChanged: false, source: "none" });
  });

  it("propagates an unreadable sidecar instead of generating against an empty snapshot", async () => {
    const root = await createMigrationFixture();
    await writeGeneratedMigration(root, "0000_initial", "SELECT 1;");
    // A directory at the expected snapshot path is a filesystem failure distinct from absence.
    await mkdir(join(root, "migrations", "custom-meta", "0000_initial.json"), { recursive: true });
    const calls: unknown[] = [];

    await expect(generateDatabaseMigration({
      cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"),
      schema: {}, runCommand: async (...args) => { calls.push(args); },
    })).rejects.toMatchObject({ code: "EISDIR" });
    expect(calls).toEqual([]);
  });

  it.each(["embedded", "sidecar"] as const)("rejects invalid %s metadata before Drizzle can write a migration", async (storage) => {
    const root = await createMigrationFixture();
    await writeGeneratedMigration(root, "0000_initial", "-- Historical migration");
    const invalidSnapshot = JSON.stringify({ version: 2, contributions: [] });
    const migrationsFolder = join(root, "migrations");
    if (storage === "embedded") {
      await writeFile(join(migrationsFolder, "0000_initial.sql"), `-- database-schema-contributions: ${Buffer.from(invalidSnapshot).toString("base64url")}\n`);
    } else {
      await mkdir(join(migrationsFolder, "custom-meta"));
      await writeFile(join(migrationsFolder, "custom-meta", "0000_initial.json"), invalidSnapshot);
    }
    const originalJournal = await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8");
    const commands: string[][] = [];

    // A generated DDL migration cannot be repaired on a simple retry once the journal advances.
    await expect(generateDatabaseMigration({
      cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder, schema: {},
      runCommand: async (_executable, args) => {
        commands.push([...args]);
        await writeGeneratedMigration(root, "0001_change", "-- New DDL");
      },
    })).rejects.toThrow(/Invalid (?:embedded )?custom schema snapshot for 0000_initial/u);
    expect(commands).toEqual([]);
    expect(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")).toBe(originalJournal);
    await expect(readMigration(root, "0001_change")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["--custom", "--custom=true"])("delegates %s without rewriting SQL or custom metadata", async (flag) => {
    const root = await createMigrationFixture();
    await writeGeneratedMigration(root, "0000_initial", "-- database-schema-contributions: invalid");
    const arguments_ = [flag, "--name=manual"];
    const manualSql = "SELECT 'manual';";

    const result = await generateDatabaseMigration({
      cwd: root, drizzleKitExecutable: "drizzle-kit", drizzleKitExecutableArguments: ["shim.mjs"],
      drizzleArguments: arguments_, migrationsFolder: join(root, "migrations"),
      schema: { target: defineDatabaseSchemaContribution({}, { id: "custom:managed", installSql: "SELECT 1;" }) },
      runCommand: async (executable, args, cwd) => {
        expect([executable, args, cwd]).toEqual(["drizzle-kit", ["shim.mjs", "generate", ...arguments_], root]);
        await writeGeneratedMigration(root, "0001_manual", manualSql);
      },
    });
    expect(result).toEqual({ customContributionsChanged: false, migrationTag: "0001_manual", source: "delegated" });
    expect(await readMigration(root, "0001_manual")).toBe(`${manualSql}\n`);
    await expect(readFile(join(root, "migrations", "custom-meta", "0001_manual.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports delegated generation without a migration tag when the journal is unchanged", async () => {
    const root = await createMigrationFixture();
    await expect(generateDatabaseMigration({
      cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"),
      schema: {}, drizzleArguments: ["--custom"], runCommand: async () => {},
    })).resolves.toStrictEqual({ customContributionsChanged: false, source: "delegated" });
  });

  it("reports a schema-only migration without creating custom metadata", async () => {
    const root = await createMigrationFixture();
    const sql = "CREATE TABLE entry (id integer);";
    const result = await generateDatabaseMigration({
      cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"), schema: {},
      runCommand: async () => writeGeneratedMigration(root, "0000_initial", sql),
    });

    expect(result).toEqual({ customContributionsChanged: false, migrationTag: "0000_initial", source: "drizzle" });
    expect(await readMigration(root, "0000_initial")).toBe(`${sql}\n`);
  });

  it.each([["--config=settings.ts"], ["--config", "settings.ts"]])("preserves the config flag for the generated custom migration (%j)", async (...config) => {
    const root = await createMigrationFixture();
    const commands: string[][] = [];
    const contribution = defineDatabaseSchemaContribution({}, { id: "custom:managed", installSql: "SELECT 1;" });
    await expect(generateDatabaseMigration({
      cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"),
      schema: { contribution }, drizzleArguments: [...config, "--name=table-change"],
      runCommand: async (_executable, args) => { commands.push([...args]); },
    })).rejects.toThrow("Drizzle Kit did not create the expected migration");

    // The generated migration receives configuration and its own managed name.
    expect(commands).toEqual([
      ["generate", ...config, "--name=table-change"],
      ["generate", ...config, "--custom", "--name=database_schema_contributions"],
    ]);
  });

  it("rejects ambiguous Drizzle output without selecting or rewriting a migration", async () => {
    const root = await createMigrationFixture();
    const contribution = defineDatabaseSchemaContribution({}, { id: "custom:managed", installSql: "SELECT 1;" });
    const first = "-- First migration";
    const second = "-- Second migration";

    await expect(generateDatabaseMigration({
      cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations"), schema: { contribution },
      runCommand: async () => {
        await writeGeneratedMigration(root, "0000_initial", first);
        await writeGeneratedMigration(root, "0001_change", second);
      },
    })).rejects.toThrow("Drizzle Kit generated more than one migration unexpectedly");
    expect(await readMigration(root, "0000_initial")).toBe(`${first}\n`);
    expect(await readMigration(root, "0001_change")).toBe(`${second}\n`);
  });

  it("reports subprocess failures and accepts normal exits", async () => {
    const root = await createMigrationFixture();
    const options = { cwd: root, migrationsFolder: join(root, "migrations"), schema: {} };
    const child = (source: string) => generateDatabaseMigration({
      ...options, drizzleKitExecutable: process.execPath, drizzleKitExecutableArguments: ["-e", source, "--"],
    });

    await expect(child(`process.exit(process.cwd() === ${JSON.stringify(await realpath(root))} ? 0 : 8)`))
      .resolves.toEqual({ customContributionsChanged: false, source: "none" });
    await expect(child("process.exit(7)")).rejects.toThrow("Drizzle Kit exited with code 7");
    await expect(child("process.kill(process.pid, 'SIGTERM')")).rejects.toThrow("Drizzle Kit exited after signal SIGTERM");
    await expect(generateDatabaseMigration({ ...options, drizzleKitExecutable: join(root, "missing-executable") }))
      .rejects.toMatchObject({ code: "ENOENT" });
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

  it("records removal of a contribution with no cleanup SQL", async () => {
    const root = await createMigrationFixture();
    const options = { cwd: root, drizzleKitExecutable: "drizzle-kit", migrationsFolder: join(root, "migrations") };
    const target = defineDatabaseSchemaContribution({}, { id: "custom:one-way", installSql: "SELECT 1;" });
    await generateDatabaseMigration({
      ...options, schema: { target }, runCommand: async () => writeGeneratedMigration(root, "0000_initial", "SELECT 2;"),
    });

    // Removing the contribution still needs a snapshot so adding it back can install it again.
    const result = await generateDatabaseMigration({
      ...options, schema: {}, runCommand: async (_executable, args) => {
        if (args.includes("--custom")) await writeGeneratedMigration(root, "0001_remove", "");
      },
    });
    expect(result).toEqual({ customContributionsChanged: true, migrationTag: "0001_remove", source: "custom" });
    expect(JSON.parse(await readFile(join(root, "migrations", "custom-meta", "0001_remove.json"), "utf8")))
      .toEqual({ version: 1, contributions: [] });
    expect((await readMigration(root, "0001_remove")).trimEnd()).toMatch(/^-- database-schema-contributions: [\w-]+$/u);
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
            "\n  \n",
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
    // A custom-only migration has no empty DDL section between its SQL and metadata.
    expect(migrationSql.split("\n--> statement-breakpoint\n")).toHaveLength(2);
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

/** Keep tests on the same bundled SQL format used by existing application snapshots. */
function describedTable(descriptions: { description?: string; columns?: Partial<Record<"title" | "body" | "added", string>> }) {
  const table = pgSchema("content").table("entry", { title: text("title"), body: text("body"), added: text("added") });
  defineDatabaseTableDescriptions(table, descriptions);
  return getDatabaseSchemaContributions({ table });
}

function reorderDescriptions(contribution: DatabaseSchemaContribution): DatabaseSchemaContribution {
  const installSql = contribution.installSql.split("\n").reverse().join("\n");
  return { ...contribution, installSql, updateSql: installSql, uninstallBeforeSql: contribution.uninstallBeforeSql!.split("\n").reverse().join("\n") };
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
