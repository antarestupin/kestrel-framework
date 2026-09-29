/** SQL lifecycle attached to one object exported by a Drizzle schema. */
export interface DatabaseSchemaContribution {
  /** Globally stable identifier used to compare successive schema versions. */
  readonly id: string;
  /** SQL used when the contribution first appears. */
  readonly installSql: string;
  /** SQL used when an existing contribution definition changes. */
  readonly updateSql?: string;
  /** Optional cleanup that must run before Drizzle changes tables. */
  readonly uninstallBeforeSql?: string;
  /** Optional cleanup that can safely run after Drizzle changes tables. */
  readonly uninstallAfterSql?: string;
}

const databaseSchemaContributions = Symbol(
  "database.schemaContributions",
);

type ContributedObject = object & {
  readonly [databaseSchemaContributions]?: readonly DatabaseSchemaContribution[];
};

/**
 * Attaches versioned custom SQL to an object already exported by a Drizzle
 * schema without changing the object Drizzle Kit sees.
 */
export function defineDatabaseSchemaContribution<Target extends object>(
  target: Target,
  contribution: DatabaseSchemaContribution,
): Target {
  assertContribution(contribution);
  const contributedTarget = target as ContributedObject;
  const current = contributedTarget[databaseSchemaContributions] ?? [];
  if (current.some(({ id }) => id === contribution.id)) {
    throw new TypeError(
      `Duplicate database schema contribution "${contribution.id}" on one object.`,
    );
  }

  if (current.length === 0) {
    Object.defineProperty(target, databaseSchemaContributions, {
      configurable: false,
      enumerable: false,
      value: [contribution],
      writable: false,
    });
  } else {
    // The hidden array itself stays mutable so independent helpers can compose.
    (current as DatabaseSchemaContribution[]).push(contribution);
  }

  return target;
}

/** Collects and validates custom SQL from an aggregated Drizzle schema. */
export function getDatabaseSchemaContributions(
  schema: Readonly<Record<string, unknown>>,
): readonly DatabaseSchemaContribution[] {
  const contributions = new Map<string, DatabaseSchemaContribution>();

  for (const value of Object.values(schema)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }

    const attached = (value as ContributedObject)[databaseSchemaContributions]
      ?? [];
    for (const contribution of attached) {
      const previous = contributions.get(contribution.id);
      if (previous !== undefined && !contributionsEqual(previous, contribution)) {
        throw new TypeError(
          `Conflicting database schema contribution "${contribution.id}".`,
        );
      }
      contributions.set(contribution.id, contribution);
    }
  }

  return [...contributions.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

export function contributionsEqual(
  left: DatabaseSchemaContribution,
  right: DatabaseSchemaContribution,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertContribution(contribution: DatabaseSchemaContribution): void {
  if (contribution.id.trim() === "") {
    throw new TypeError("A database schema contribution requires a stable id.");
  }
  if (contribution.installSql.trim() === "") {
    throw new TypeError(
      `Database schema contribution "${contribution.id}" requires install SQL.`,
    );
  }
}
