import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  contributionsEqual,
  getDatabaseSchemaContributions,
  type DatabaseSchemaContribution,
} from "./definition.js";

interface DrizzleJournal {
  readonly entries: readonly DrizzleJournalEntry[];
}

interface DrizzleJournalEntry {
  readonly idx: number;
  readonly tag: string;
}

interface ContributionSnapshot {
  readonly version: 1;
  readonly contributions: readonly DatabaseSchemaContribution[];
}

interface MigrationSqlPlan {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

const embeddedSnapshotPrefix = "-- database-schema-contributions: ";

type CommandRunner = (
  executable: string,
  arguments_: readonly string[],
  cwd: string,
) => Promise<void>;

export interface DatabaseMigrationGenerationOptions {
  readonly cwd: string;
  readonly drizzleKitExecutable: string;
  readonly drizzleKitExecutableArguments?: readonly string[];
  readonly drizzleArguments?: readonly string[];
  readonly migrationsFolder: string;
  readonly schema: Readonly<Record<string, unknown>>;
  /** Test seam for the interactive Drizzle Kit child process. */
  readonly runCommand?: CommandRunner;
}

export interface DatabaseMigrationGenerationResult {
  readonly customContributionsChanged: boolean;
  readonly migrationTag?: string;
  readonly source: "drizzle" | "custom" | "delegated" | "none";
}

/**
 * Runs Drizzle Kit, then merges declarative custom SQL into the migration it
 * just created. A custom-only migration is created when Drizzle has no diff.
 */
export async function generateDatabaseMigration(
  options: DatabaseMigrationGenerationOptions,
): Promise<DatabaseMigrationGenerationResult> {
  const arguments_ = options.drizzleArguments ?? [];
  const executableArguments = options.drizzleKitExecutableArguments ?? [];
  const runCommand = options.runCommand ?? runDrizzleKit;
  const beforeJournal = await readJournal(options.migrationsFolder, true);

  await runCommand(
    options.drizzleKitExecutable,
    [...executableArguments, "generate", ...arguments_],
    options.cwd,
  );

  // Explicit one-off custom migrations remain fully owned by their author.
  if (hasCustomFlag(arguments_)) {
    const afterJournal = await readJournal(options.migrationsFolder);
    const migrationTag = findNewEntry(beforeJournal, afterJournal)?.tag;
    return {
      customContributionsChanged: false,
      ...(migrationTag === undefined ? {} : { migrationTag }),
      source: "delegated",
    };
  }

  const current = getDatabaseSchemaContributions(options.schema);
  const previous = await readLatestContributionSnapshot(
    options.migrationsFolder,
    beforeJournal,
  );
  const plan = createMigrationSqlPlan(previous, current);
  const customContributionsChanged = plan.before.length > 0
    || plan.after.length > 0
    || !contributionCollectionsEqual(previous, current);
  let afterJournal = await readJournal(options.migrationsFolder);
  let migration = findNewEntry(beforeJournal, afterJournal);
  let source: DatabaseMigrationGenerationResult["source"] = migration === undefined
    ? "none"
    : "drizzle";

  if (!customContributionsChanged) {
    return {
      customContributionsChanged: false,
      ...(migration === undefined ? {} : { migrationTag: migration.tag }),
      source,
    };
  }

  if (migration === undefined) {
    await runCommand(
      options.drizzleKitExecutable,
      [
        ...executableArguments,
        "generate",
        ...extractConfigArguments(arguments_),
        "--custom",
        "--name=database_schema_contributions",
      ],
      options.cwd,
    );
    afterJournal = await readJournal(options.migrationsFolder);
    migration = findNewEntry(beforeJournal, afterJournal);
    source = "custom";
  }

  if (migration === undefined) {
    throw new Error("Drizzle Kit did not create the expected migration.");
  }

  await mergeMigrationSql(
    options.migrationsFolder,
    migration,
    plan,
    current,
  );
  await writeContributionSnapshot(
    options.migrationsFolder,
    migration,
    current,
  );

  return {
    customContributionsChanged: true,
    migrationTag: migration.tag,
    source,
  };
}

export function createMigrationSqlPlan(
  previous: readonly DatabaseSchemaContribution[],
  current: readonly DatabaseSchemaContribution[],
): MigrationSqlPlan {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const currentById = new Map(current.map((item) => [item.id, item]));
  const replacedOrRemoved = previous.filter((oldContribution) => {
    const newContribution = currentById.get(oldContribution.id);
    return newContribution === undefined
      || !contributionsEqual(oldContribution, newContribution);
  });
  const addedOrReplaced = current.filter((newContribution) => {
    const oldContribution = previousById.get(newContribution.id);
    return oldContribution === undefined
      || !contributionsEqual(oldContribution, newContribution);
  });

  return {
    before: replacedOrRemoved.flatMap(({ uninstallBeforeSql }) =>
      uninstallBeforeSql === undefined ? [] : [uninstallBeforeSql]
    ),
    after: [
      ...replacedOrRemoved.flatMap(({ uninstallAfterSql }) =>
        uninstallAfterSql === undefined ? [] : [uninstallAfterSql]
      ),
      ...addedOrReplaced.map((contribution) => {
        const existed = previousById.has(contribution.id);
        return existed
          ? contribution.updateSql ?? contribution.installSql
          : contribution.installSql;
      }),
    ],
  };
}

async function mergeMigrationSql(
  migrationsFolder: string,
  migration: DrizzleJournalEntry,
  plan: MigrationSqlPlan,
  contributions: readonly DatabaseSchemaContribution[],
): Promise<void> {
  const path = join(migrationsFolder, `${migration.tag}.sql`);
  const drizzleSql = (await readFile(path, "utf8")).trim();
  const sections = [
    ...annotateSql("custom schema cleanup before Drizzle", plan.before),
    drizzleSql,
    ...annotateSql("custom schema changes after Drizzle", plan.after),
    createEmbeddedSnapshot(contributions),
  ].filter((section) => section.trim() !== "");

  await writeFile(
    path,
    `${sections.join("\n--> statement-breakpoint\n")}\n`,
    "utf8",
  );
}

function annotateSql(label: string, statements: readonly string[]): string[] {
  if (statements.length === 0) {
    return [];
  }
  return [
    `-- ${label}. Generated from the exported Drizzle schema.\n${statements.join("\n")}`,
  ];
}

async function readJournal(
  migrationsFolder: string,
  allowMissing = false,
): Promise<DrizzleJournal> {
  try {
    const contents = await readFile(
      join(migrationsFolder, "meta", "_journal.json"),
      "utf8",
    );
    return JSON.parse(contents) as DrizzleJournal;
  } catch (error) {
    // Only the initial read permits a fresh application. Drizzle must create
    // its own journal, and malformed or unreadable existing files still fail.
    if (allowMissing && isMissingFileError(error)) return { entries: [] };
    throw error;
  }
}

async function readLatestContributionSnapshot(
  migrationsFolder: string,
  journal: DrizzleJournal,
): Promise<readonly DatabaseSchemaContribution[]> {
  for (const entry of [...journal.entries].reverse()) {
    const embedded = await readEmbeddedSnapshot(migrationsFolder, entry);
    if (embedded !== undefined) {
      return embedded.contributions;
    }
    try {
      const contents = await readFile(snapshotPath(migrationsFolder, entry), "utf8");
      const snapshot = JSON.parse(contents) as ContributionSnapshot;
      if (snapshot.version !== 1 || !Array.isArray(snapshot.contributions)) {
        throw new TypeError(`Invalid custom schema snapshot for ${entry.tag}.`);
      }
      return snapshot.contributions;
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
  }
  return [];
}

async function readEmbeddedSnapshot(
  migrationsFolder: string,
  entry: DrizzleJournalEntry,
): Promise<ContributionSnapshot | undefined> {
  const migrationSql = await readFile(
    join(migrationsFolder, `${entry.tag}.sql`),
    "utf8",
  );
  const marker = migrationSql.split("\n")
    .find((line) => line.startsWith(embeddedSnapshotPrefix));
  if (marker === undefined) {
    return undefined;
  }

  const encoded = marker.slice(embeddedSnapshotPrefix.length).trim();
  const snapshot = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as ContributionSnapshot;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.contributions)) {
    throw new TypeError(`Invalid embedded custom schema snapshot for ${entry.tag}.`);
  }
  return snapshot;
}

function createEmbeddedSnapshot(
  contributions: readonly DatabaseSchemaContribution[],
): string {
  const snapshot: ContributionSnapshot = {
    version: 1,
    contributions,
  };
  return `${embeddedSnapshotPrefix}${Buffer.from(JSON.stringify(snapshot))
    .toString("base64url")}`;
}

async function writeContributionSnapshot(
  migrationsFolder: string,
  migration: DrizzleJournalEntry,
  contributions: readonly DatabaseSchemaContribution[],
): Promise<void> {
  const snapshot: ContributionSnapshot = {
    version: 1,
    contributions,
  };
  await mkdir(join(migrationsFolder, "custom-meta"), { recursive: true });
  await writeFile(
    snapshotPath(migrationsFolder, migration),
    `${JSON.stringify(snapshot, undefined, 2)}\n`,
    "utf8",
  );
}

function snapshotPath(
  migrationsFolder: string,
  migration: DrizzleJournalEntry,
): string {
  return join(migrationsFolder, "custom-meta", `${migration.tag}.json`);
}

function findNewEntry(
  before: DrizzleJournal,
  after: DrizzleJournal,
): DrizzleJournalEntry | undefined {
  const existingTags = new Set(before.entries.map(({ tag }) => tag));
  const added = after.entries.filter(({ tag }) => !existingTags.has(tag));
  if (added.length > 1) {
    throw new Error("Drizzle Kit generated more than one migration unexpectedly.");
  }
  return added[0];
}

function contributionCollectionsEqual(
  left: readonly DatabaseSchemaContribution[],
  right: readonly DatabaseSchemaContribution[],
): boolean {
  return left.length === right.length
    && left.every((item, index) => contributionsEqual(item, right[index]!));
}

function hasCustomFlag(arguments_: readonly string[]): boolean {
  return arguments_.some((argument) =>
    argument === "--custom" || argument.startsWith("--custom=")
  );
}

function extractConfigArguments(arguments_: readonly string[]): string[] {
  const config: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument.startsWith("--config=")) {
      config.push(argument);
    } else if (argument === "--config") {
      const value = arguments_[index + 1];
      if (value !== undefined) {
        config.push(argument, value);
        index += 1;
      }
    }
  }
  return config;
}

async function runDrizzleKit(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          signal === null
            ? `Drizzle Kit exited with code ${String(code)}.`
            : `Drizzle Kit exited after signal ${signal}.`,
        ));
      }
    });
  });
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}
