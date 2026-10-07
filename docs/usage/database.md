# Database

[Usage index](./README.md) · [Implementation, schema tooling and history](../implementation/database.md)

Use `db` for PostgreSQL/Drizzle repositories and scoped transactions. The `database` directory owns migration and seed tooling. Register `DatabaseProvider` before any provider using PostgreSQL and apply the application's migrations before running it.

## Configure PostgreSQL

Register database infrastructure when actions or other libraries need persistent storage. Resolve connection settings once and let the provider own the shared pool.

```ts
import { App } from "@kestreljs/framework/app";
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { databaseConfigBase, DatabaseProvider } from "@kestreljs/framework/db";

const configuration = createConfigurationApi({
  environments: ["development", "production"],
  defaultEnvironment: "development",
});
const config = configuration.resolveConfig({
  database: configure(databaseConfigBase, {
    host: configuration.envVar("DB_HOST"),
    user: configuration.envVar("DB_USER"),
    password: configuration.envVar("DB_PASSWORD"),
    database: configuration.envVar("DB_NAME"),
    // Use the application environment to select the connection policy once.
    ssl: configuration.fromEnv({ development: false, default: true }),
  }),
}, { environment: configuration.resolveEnvironment(process.env.ENVIRONMENT), env: process.env });
const app = new App(config).register(new DatabaseProvider(config.database));
```

The provider owns pool disposal. A custom provider may attach the complete application schema through its `createDatabase` hook; ordinary repositories only need the scoped `databaseManager` registration.

## Install library schemas

Configure migration generation once for the application. Each PostgreSQL library then only needs its schema objects added to the same application schema: its SQL contributions travel with those objects, including table descriptions, cache `UNLOGGED` storage and history triggers.

For example, create an application-owned `src/database_schema.ts`:

```ts
import { cacheEntries } from "@kestreljs/framework/cache";
import { utilsSchema } from "@kestreljs/framework/db";

// Include library tables and their PostgreSQL namespaces alongside app tables.
export const schema = { utilsSchema, cacheEntries };
// Drizzle Kit needs named exports; the runtime object alone is insufficient.
export { utilsSchema, cacheEntries };
```

Point the application's Drizzle configuration at this file. The following application-owned `src/generate_database_migration.ts` assumes a root `drizzle.config.ts` with `schema: "./src/database_schema.ts"` and `out: "./migrations"`, and installed `drizzle-kit` and `tsx` development dependencies:

```ts
import { fileURLToPath } from "node:url";
import { generateDatabaseMigration } from "@kestreljs/framework/db";
import { schema } from "./database_schema.js";

// Keep these paths aligned with the application's Drizzle configuration.
await generateDatabaseMigration({
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  drizzleKitExecutable: process.execPath,
  drizzleKitExecutableArguments: [
    fileURLToPath(new URL("../node_modules/drizzle-kit/bin.cjs", import.meta.url)),
  ],
  drizzleArguments: process.argv.slice(2),
  schema,
});
```

Set the application's `db:generate` script to `tsx src/generate_database_migration.ts`. With the application's migration command configured to apply the same folder, use:

```sh
npm run db:generate -- --name=install_cache
npm run db:migrate
```

Review and commit the generated SQL, Drizzle journal and snapshots, and `custom-meta` snapshots. The first generation also works before the migrations directory exists. Subsequent unchanged generations add no contribution migration. Removing annotations or schema exports generates the helper's cleanup, and renaming a table retains Drizzle's interactive rename decision. Review removals because removing an exported table can generate a table drop. Existing migration history must be preserved, including historical manually written SQL.

Always generate through the Kestrel wrapper: invoking `drizzle-kit generate` directly does not collect contributions. Migration execution applies the generated SQL before providers use their storage; starting a provider does not install its schema. Generation errors propagate, including invalid journal JSON and Drizzle command failures; resolve the error and inspect generated files before applying migrations. The [contribution reference](../implementation/database.md#custom-schema-contributions) explains SQL ordering and lifecycle contracts.

Use the corresponding library guide for its required exports: [cache](./cache.md#install-postgresql-storage), [locks](./lock.md#install-postgresql-storage), [throttling](./throttling.md#install-postgresql-storage), [authentication](./authentication.md#install-postgresql-storage), [authorization](./authorization.md#install-postgresql-storage), [tokens](./tokens.md#install-postgresql-storage), [scheduled tasks](./scheduled_tasks.md#install-postgresql-storage), [workers](./workers.md#install-postgresql-storage) and [workflows](./workflows.md#install-postgresql-storage).

For development-only tables managed by Drizzle Push, call `applyDatabaseSchemaContributions(localSchema, executeSql)` after Push completes, where `executeSql` is an application-supplied async SQL executor. This replays installation SQL and stops on the first failure; it does not calculate removal diffs. Only use replay-safe contributions on this path. Keep Push exports and `tablesFilter` strictly aligned; see the [development storage reference](../implementation/database.md).

## Create a repository-backed action

Use a repository and a model action helper for conventional record creation. This example maps a contact table to a validated action that returns the created record.

```ts
import { sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { defineModelCreateAction } from "@kestreljs/framework/actions";
import { DatabaseManager, Repository, type RepositoryCollectionOptions } from "@kestreljs/framework/db";

export const contacts = pgTable("contact", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
});
type ContactInsert = typeof contacts.$inferInsert;
class ContactRepository extends Repository<typeof contacts, string, ContactInsert, Partial<ContactInsert>> {
  // Dependency injection supplies the database manager for this execution scope.
  constructor({ databaseManager }: { databaseManager: DatabaseManager }) {
    super(databaseManager, {
      table: contacts,
      idColumn: contacts.id,
    });
  }

  // A unique ordering makes numbered pagination deterministic.
  protected override getOrderBy() {
    return [contacts.id];
  }

  // Explicitly allow the fields accepted by conventional list actions.
  protected override getCollectionConfiguration(): RepositoryCollectionOptions {
    return {
      search: { name: contacts.name },
      filters: { name: { column: contacts.name, operators: ["equals", "contains"] } },
      sorting: { name: contacts.name, id: contacts.id },
    };
  }
}
const createContact = defineModelCreateAction(
  "contact",
  ContactRepository,
  // Accept only editable input fields; the database generates the ID.
  z.object({ name: z.string().min(1) }),
  z.object({ id: z.uuid(), name: z.string() }),
);
// Add createContact to the application's actions catalog.
```

Export the table through your Drizzle migration schema. Database-side `uuidv7()` requires PostgreSQL 18. `findById` returns `null` for a missing row. Direct `create`/`update`/`delete` writes return data only when requested with `{ returning: true }`; model action helpers select that behavior for you. Use `findManyByIds` for batch reads and [pagination](./pagination.md) for collection reads.

Both protected hooks are optional: `getOrderBy()` defaults to `[]` (no SQL ordering), and `getCollectionConfiguration()` defaults to `undefined`. Without collection configuration, `findCollection()` still supports plain numbered pages but rejects non-empty search, filters and caller-selected sorting. You may configure search, filters and sorting independently. An explicit collection sort replaces the default ordering entirely.

Migration: move the former constructor `orderBy` and `collection` options into `getOrderBy()` and `getCollectionConfiguration()` overrides. Keep `table`, `idColumn` and optional `cursor` in the constructor options.

## Group writes in a transaction

Wrap an action in a transaction when several database writes must succeed or fail together. Creating the pair below must not leave only one contact behind.

```ts
import { defineAction } from "@kestreljs/framework/actions";
import { databaseTransaction } from "@kestreljs/framework/db";

const createPair = defineAction({
  name: "contact.create-pair",
  input: z.object({ first: z.string(), second: z.string() }),
  output: z.void(),
  dependencies: { contacts: ContactRepository },
  // All scoped database work joins this action's transaction boundary.
  middleware: [databaseTransaction],
  handler: async ({ first, second }, { contacts }) => {
    // Both writes use the same scoped transaction executor.
    await contacts.create({ name: first });
    await contacts.create({ name: second });
  },
});
```

Thrown failures, including output validation failures, roll back the transaction. Code that needs an explicit boundary can call `DatabaseManager.transaction(callback)`.

## Track row history

Add a history table when an application needs to retain changes to a source record. Include it in migrations alongside the source table before recording audited writes. Use the [Kestrel migration generator](#install-library-schemas) so the history table's functions and triggers are installed along with its Drizzle table.

```ts
import { defineHistoryTable } from "@kestreljs/framework/db";

// Export this beside the source table so migration generation sees both.
export const contactHistory = defineHistoryTable(contacts);
```

Use `runWithHistoryContext(databaseManager, { actor, reason }, callback)` around writes to attach application audit metadata. Source writes and generated history events share one transaction. Removing a source column currently also removes its derived history column; review schema changes with retention needs in mind.

For descriptions, custom SQL contributions, migration generation, seeding and local resets, use the [schema and maintenance reference](../implementation/database.md#custom-schema-contributions). Local push-schema exports and `tablesFilter` must describe exactly the same tables.

## Use cases still to document

- Seed an application database.
- Reset an isolated development database with aligned schema exports and table filters.
- Implement repository reads, updates, deletes and batch operations.
- Record actor and reason metadata with runWithHistoryContext, including nested transactions.
- Add custom filtering and sorting to a collection repository.
