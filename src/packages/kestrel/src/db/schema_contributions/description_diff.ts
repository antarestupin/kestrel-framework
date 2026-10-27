import type { DatabaseSchemaContribution } from "./definition.js";

interface DescriptionStatement {
  readonly target: string;
  readonly installSql: string;
  readonly removeSql: string;
}

/**
 * Recognizes only the exact SQL lifecycle emitted by the description helpers.
 * Keeping their existing snapshot format also supports historical migrations.
 * Other SQL contributions retain their ordinary replacement lifecycle.
 */
export function getDescriptionStatements(
  contribution: DatabaseSchemaContribution,
): readonly DescriptionStatement[] | undefined {
  if (!((contribution.id.startsWith("postgres.table:") && contribution.id.endsWith(":descriptions"))
    || (contribution.id.startsWith("postgres.schema:") && contribution.id.endsWith(":description")))
    || contribution.uninstallAfterSql !== undefined
    || (contribution.updateSql !== undefined && contribution.updateSql !== contribution.installSql)) {
    return undefined;
  }

  // Quoted identifiers and literals may contain dots, semicolons and newlines.
  // A sticky recognizer must consume the whole input; never split SQL on ';'.
  const pattern = /\s*COMMENT ON (SCHEMA|TABLE|COLUMN) ("(?:[^"]|"")*"(?:\."(?:[^"]|"")*")*) IS ('(?:[^']|'')*');/uy;
  const statements: DescriptionStatement[] = [];
  const targets = new Set<string>();
  let position = 0;
  while (position < contribution.installSql.length) {
    if (contribution.installSql.slice(position).trim() === "") break;
    pattern.lastIndex = position;
    const match = pattern.exec(contribution.installSql);
    if (match === null) return undefined;
    const target = `${match[1]} ${match[2]}`;
    if (targets.has(target)) return undefined;
    targets.add(target);
    statements.push({
      target,
      installSql: `COMMENT ON ${target} IS ${match[3]};`,
      removeSql: `COMMENT ON ${target} IS NULL;`,
    });
    position = pattern.lastIndex;
  }
  if (statements.length === 0
    || contribution.uninstallBeforeSql !== statements.map(({ removeSql }) => removeSql).join("\n")) {
    return undefined;
  }
  return statements;
}

/** Distinguishes semantic changes from harmless declaration-order changes. */
export function descriptionContributionsEqual(
  left: DatabaseSchemaContribution,
  right: DatabaseSchemaContribution,
): boolean {
  if (left.id !== right.id) return false;
  const oldStatements = getDescriptionStatements(left);
  const newStatements = getDescriptionStatements(right);
  if (oldStatements === undefined || newStatements === undefined) return false;
  const oldByTarget = new Map(oldStatements.map((statement) => [statement.target, statement.installSql]));
  return oldStatements.length === newStatements.length
    && newStatements.every((statement) => oldByTarget.get(statement.target) === statement.installSql);
}

/** Clears only removed targets before DDL and sets added/changed comments after it. */
export function createDescriptionUpdatePlan(
  previous: DatabaseSchemaContribution,
  current: DatabaseSchemaContribution,
): { readonly before: readonly string[]; readonly after: readonly string[] } | undefined {
  const oldStatements = getDescriptionStatements(previous);
  const newStatements = getDescriptionStatements(current);
  if (oldStatements === undefined || newStatements === undefined) return undefined;
  const oldByTarget = new Map(oldStatements.map((statement) => [statement.target, statement.installSql]));
  const newTargets = new Set(newStatements.map(({ target }) => target));
  return {
    before: oldStatements.filter(({ target }) => !newTargets.has(target)).map(({ removeSql }) => removeSql),
    after: newStatements.filter(({ target, installSql }) => oldByTarget.get(target) !== installSql).map(({ installSql }) => installSql),
  };
}
