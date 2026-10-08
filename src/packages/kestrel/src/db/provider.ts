import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import type { Provider, ProviderCompositionApp } from "../app/index.js";
import { observerContextDependency } from "../observability/index.js";
import { postgresDrizzleConfigBase, type PostgresDrizzleConfig } from "./configuration.js";
import { PostgresPoolRuntime, type PostgresPoolEvent, type PostgresPoolSnapshot } from "./pool_runtime.js";
import { PostgresDrizzleManager } from "./database_manager.js";
import {
  type DatabaseQueryInstrumentation,
  recordDatabaseQueryInstrumentation,
} from "./observations.js";
import { instrumentDrizzleDatabase, instrumentPostgresPool } from "./query_instrumentation.js";

export interface PostgresDrizzleClient<Database extends NodePgDatabase<any> = NodePgDatabase<any>> {
  readonly database: Database;
  readonly pool: Pool;
  /** Returns local pool state without opening a connection. */
  snapshot(): PostgresPoolSnapshot;
  /** Checks connectivity explicitly; construction remains lazy. */
  checkHealth(): Promise<PostgresPoolSnapshot>;
  close(): Promise<void>;
}

export interface PostgresDrizzleProviderOptions<Database> {
  /** Sanitized pool diagnostics, independent of request-scoped observation. */
  readonly onPoolEvent?: (event: PostgresPoolEvent) => void | Promise<void>;
  readonly schema?: Record<string, unknown>;
  /** Overrides facade construction while the provider retains pool ownership. */
  readonly createDatabase?: (pool: Pool) => Database;
}

/** Adds lazy PostgreSQL and Drizzle infrastructure to an application. */
export class PostgresDrizzleProvider<
  Config,
  Database extends NodePgDatabase<any> = NodePgDatabase<any>,
> implements Provider<Config> {
  public constructor(
    protected readonly config: PostgresDrizzleConfig,
    private readonly options: PostgresDrizzleProviderOptions<Database> = {},
  ) {
    // Validate direct construction as well as declarative configuration.
    this.config = postgresDrizzleConfigBase.schema.parse(config);
  }

  public register(app: ProviderCompositionApp<Config>): void {
    // The pool stays lazy so minimal maintenance commands can compose safely.
    app.container.registerFactory("databaseClient", () => this.createClient(app), {
      lifetime: "singleton",
      dispose: (client) => client.close(),
    });
    app.container.registerFactory<
      Database,
      {
        databaseClient: PostgresDrizzleClient<Database>;
      }
    >("database", ({ databaseClient }) => databaseClient.database, { lifetime: "singleton" });
    app.container.registerClass("databaseManager", PostgresDrizzleManager, { lifetime: "scoped" });

    this.registerExtensions(app);
  }

  /** Registers application-specific database services after the common ones. */
  protected registerExtensions(_app: ProviderCompositionApp<Config>): void {}

  /** Creates the typed Drizzle facade. Applications can attach their schema. */
  protected createDatabase(pool: Pool): Database {
    // A typed factory can refine the facade while the provider keeps pool ownership.
    return (
      this.options.createDatabase?.(pool) ??
      (drizzle(
        pool,
        this.options.schema === undefined ? {} : { schema: this.options.schema },
      ) as unknown as Database)
    );
  }

  /** Creates the owned pool and its typed Drizzle facade. */
  protected createClient(app: ProviderCompositionApp<Config>): PostgresDrizzleClient<Database> {
    const pool = new Pool(this.createPoolConfig());
    const runtime = new PostgresPoolRuntime(pool, this.config.resourcePolicy, this.options.onPoolEvent);
    const getInstrumentation = (): DatabaseQueryInstrumentation | undefined => {
      if (!app.container.hasRegistration("observerContext")) {
        return undefined;
      }

      const observer = app.container.resolve(observerContextDependency).get();

      return observer === undefined
        ? undefined
        : {
            record: (event) => recordDatabaseQueryInstrumentation(observer, event),
          };
    };

    instrumentPostgresPool(pool, this.config.queryObservability, getInstrumentation);
    const database = instrumentDrizzleDatabase(
      this.createDatabase(pool),
      this.config.queryObservability,
      getInstrumentation,
    );

    return {
      database,
      pool,
      snapshot: () => runtime.snapshot(),
      checkHealth: () => runtime.checkHealth(),
      close: () => runtime.close(),
    };
  }

  /** Maps the validated library configuration to node-postgres options. */
  protected createPoolConfig(): PoolConfig {
    const { queryObservability: _observability, resourcePolicy: _policy, ...poolConfig } = this.config;
    return poolConfig;
  }
}
