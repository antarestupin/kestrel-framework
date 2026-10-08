# Database

[Usage index](./README.md) · [Implementation, schema tooling and history](../implementation/database.md)

Use `db` for PostgreSQL/Drizzle repositories and scoped transactions. The `database` directory owns migration and seed tooling. Register `PostgresDrizzleProvider` before any provider using PostgreSQL and apply the application's migrations before running it.

## Configure PostgreSQL

Register database infrastructure when actions or other libraries need persistent storage. Resolve connection settings once and let the provider own the shared pool.

```ts
import { App } from "@kestreljs/framework/app";
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { postgresDrizzleConfigBase, PostgresDrizzleProvider } from "@kestreljs/framework/db";

const configuration = createConfigurationApi({
  environments: ["development", "production"],
  defaultEnvironment: "development",
});
const config = configuration.resolveConfig({
  database: configure(postgresDrizzleConfigBase, {
    host: configuration.envVar("DB_HOST"),
    user: configuration.envVar("DB_USER"),
    password: configuration.envVar("DB_PASSWORD"),
    database: configuration.envVar("DB_NAME"),
    // Allocate connections per process, including every deployed replica.
    max: configuration.envVar("DB_POOL_MAX", { fallback: 10 }),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
    options: "-c transaction_timeout=60000",
    resourcePolicy: { maxWaitingRequests: 100, shutdownTimeoutMs: 10_000 },
    // Use the application environment to select the connection policy once.
    ssl: configuration.fromEnv({ development: false, default: true }),
  }),
}, { environment: configuration.resolveEnvironment(process.env.ENVIRONMENT), env: process.env });
const app = new App(config).register(new PostgresDrizzleProvider(config.database));
```

The provider owns pool disposal. Pass `{ schema }` or a typed `{ createDatabase: (pool) => drizzle(pool, { schema }) }` constructor option to attach the application schema. Ordinary repositories only need the scoped `databaseManager` registration.

## Pool budgets, failures and recovery

The configuration uses native `pg` option names. The provider validates configuration even when constructed directly, forwards native fields to `new Pool()`, and removes only `queryObservability` and `resourcePolicy`. Additional native driver options, including type parsers and connection hooks, pass through. Known resource fields are validated; advanced driver options retain their native validation and behavior. Credentials remain application-owned, and Kestrel does not read environment variables.

| Field | Default | Meaning |
| --- | --- | --- |
| `max` / `min` | `10` / `0` | Maximum connections and native idle-retention floor; `min` does not prewarm the pool. |
| `connectionTimeoutMillis` | `5000` | Native connection/acquisition timeout; must be positive. Native queue and connection phases can have separate timers. |
| `idleTimeoutMillis` | `30000` | Idle pool connection lifetime; `0` disables idle eviction. |
| `statement_timeout` | `30000` | Server-side statement cancellation. |
| `lock_timeout` | `5000` | Server-side timeout for each lock acquisition. |
| `idle_in_transaction_session_timeout` | `10000` | Server-side termination of sessions idle in a transaction. |
| `options` | `"-c transaction_timeout=60000"` | Native PostgreSQL startup options; the default terminates transactions exceeding 60 seconds. |
| `query_timeout` | `35000` | Native client-side query wait limit; this alone is not SQL cancellation. |
| `resourcePolicy.maxWaitingRequests` | `100` | Extra acquisition requests admitted beyond the connection capacity; `0` rejects overflow immediately. |
| `resourcePolicy.shutdownTimeoutMs` | `10000` | Grace period before owned connections are forcibly disconnected. |

Durations are milliseconds except native `maxLifetimeSeconds`. Numeric environment strings are accepted. Limits must be integers within the supported timer range. Server timeout fields and `query_timeout` accept an explicit `0` to disable that limit. Keep `lock_timeout` below `statement_timeout`, and the total transaction budget above the statement and idle-transaction budgets when those finer limits should apply first. Replacing `options` replaces the entire startup string: include `-c transaction_timeout=...` alongside any other required options. Startup options can also override server settings; applications own such overrides.

For verified TLS with a private CA, use `ssl: { ca: certificatePem, rejectUnauthorized: true }`. Client certificates (`cert`, `key`, optional `passphrase`), `servername`, and other Node TLS options remain available. TLS objects default to certificate verification; `ssl: false` is an explicit choice for trusted local development. Load certificate material in application composition, not inside the provider.

Size the deployment budget using the sum of `max` across all pools, processes and replicas, including overlapping deployments, and reserve capacity for administration and maintenance. Workers and HTTP requests using one provider share its capacity and queue; the queue is bounded but does not reserve connections or provide workload fairness. Use separately composed applications/processes for independent workload budgets. Migrations, bulk operations and long-running maintenance need an explicit profile with appropriate timeouts; they must not silently inherit unbounded production behavior. Pools constructed directly by application tooling are outside the provider lifecycle.

### Inspect and report pool state

`databaseClient.snapshot()` returns local state without connecting: `unknown`, `healthy`, `degraded`, `closing` or `closed`, plus `total`, `idle`, `active`, native `waiting`, in-flight `acquiring`, acquisition attempt/failure counters, the latest acquisition duration and the latest sanitized failure. `active` counts checked-out or connecting connections, not SQL statements currently running. Admission counts both acquired leases and in-flight acquisitions, including requests not yet assigned an idle connection.

`await databaseClient.checkHealth()` executes `select 1` with the configured native budgets. A successful check establishes `healthy` only if no newer failure occurred. Failures propagate to the caller; pool/connection errors degrade local state, while admission overflow is reported separately and does not itself mean PostgreSQL is unavailable. Acquiring a connection alone does not establish recovery. Applications choose how and when to call this check and integrate its result with readiness; no polling loop or HTTP endpoint starts automatically. Disabling native deadlines also weakens the health-check deadline.

Pass an independent diagnostic sink as a provider option:

```ts
const provider = new PostgresDrizzleProvider(config.database, {
  schema,
  // Use a bounded sink independent of this database to avoid recursive failure reporting.
  onPoolEvent: (event) => applicationLogger.info({ databasePool: event }),
});
```

Events report acquisition duration/outcome, pool errors and shutdown outcomes. They contain timestamps, fixed failure categories and sanitized error codes; they omit messages, stacks, SQL, parameters and credentials. The error boundary is installed even without a sink or an active execution observer. Sink exceptions and rejected promises cannot change database outcomes; asynchronous sinks are not awaited or drained by the provider. The application must bound their buffering and dispose their resources. Query observations remain controlled separately by `queryObservability`.

### Transactions and shutdown guarantees

Drizzle remains responsible for `BEGIN`, `COMMIT`, rollback, transaction options and nested savepoints. The complete typed Drizzle facade remains available through `databaseClient.database` and the `database` registration. The scoped manager continues to join ambient transactions and introduces no alternate SQL transaction engine. Kestrel never retries writes or rewrites Drizzle query/transaction errors; a connection loss during `COMMIT` can leave the outcome unknown. Drizzle may surface a rollback error after an earlier transaction failure, so do not interpret the last error as proof that nothing committed.

Server statement/lock timeouts cancel SQL. Transaction and idle-transaction timeouts terminate the PostgreSQL session; Kestrel evicts a terminated checked-out connection even if its owner has not released it yet. None of these mechanisms can interrupt an arbitrary JavaScript transaction callback suspended on unrelated work. A native client `query_timeout` limits waiting and does not by itself guarantee server cancellation or safe reuse of a manually held client. Such clients remain application-managed and should be released with an error when their state is uncertain.

Call `databaseClient.close()` (or let application disposal call it), not `pool.end()`, to apply Kestrel's shutdown policy. Closure is idempotent and immediately refuses admission with `PostgresPoolPolicyError` code `closing`. Pending callers are rejected, idle connections close, and checked-out work gets a grace period. At the deadline, owned checked-out transports are destroyed, connections are evicted, and close rejects with `shutdown_timeout`; late owner releases after eviction are harmless. Ordinary duplicate releases retain native pg errors. A forced disconnect does not prove rollback or undo external side effects.

Native acquisitions already in progress cannot be cancelled through the public pool API. Their callers are rejected immediately, but their native queue/connect callbacks can survive until `connectionTimeoutMillis`; late connections are evicted. `closed` means the provider has finished its bounded close operation, not that every native callback has already run. Shutdown does not wait for arbitrary application callbacks or asynchronous diagnostic sinks. The global application shutdown deadline and cooperative execution cancellation are separate runtime concerns.

See the [implementation and deferred evolutions](../implementation/database.md#pool-resource-policy) for ownership and regression coverage.

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
import { PostgresDrizzleManager, Repository, type RepositoryCollectionOptions } from "@kestreljs/framework/db";

export const contacts = pgTable("contact", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  name: text("name").notNull(),
});
type ContactInsert = typeof contacts.$inferInsert;
class ContactRepository extends Repository<typeof contacts, string, ContactInsert, Partial<ContactInsert>> {
  // Dependency injection supplies the database manager for this execution scope.
  constructor({ databaseManager }: { databaseManager: PostgresDrizzleManager }) {
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

Thrown failures, including output validation failures, roll back the transaction. Code that needs an explicit boundary can call `PostgresDrizzleManager.transaction(callback)`.

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

## Explicit provider adapters

`PostgresDrizzleProvider` names the actual PostgreSQL/Drizzle boundary. `PostgresDrizzleConfig`, `postgresDrizzleConfigBase`, `PostgresDrizzleClient` and `PostgresDrizzleManager` are explicit public names. Supply `{ schema }` or `{ createDatabase: (pool) => drizzle(pool, { schema }) }` as constructor options. Application subclasses are only needed for additional composition such as maintenance. A TypeORM integration requires its own infrastructure provider and compatible feature adapters.

See the [shared composition convention](../implementation/app.md#provider-adapter-convention) and [configuration recipes](../usage/configuration.md#additional-provider-composition).
