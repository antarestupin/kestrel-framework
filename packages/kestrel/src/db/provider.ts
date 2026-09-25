import {
  drizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import {
  Pool,
  type PoolConfig,
} from "pg";

import type { Provider, ProviderCompositionApp } from "../app/index.js";
import { observerContextDependency } from "../observability/index.js";
import type { DatabaseConfig } from "./configuration.js";
import { DatabaseManager } from "./database_manager.js";
import {
  type DatabaseQueryInstrumentation,
  recordDatabaseQueryInstrumentation,
} from "./observations.js";
import {
  instrumentDrizzleDatabase,
  instrumentPostgresPool,
} from "./query_instrumentation.js";

export interface DatabaseClient<Database extends NodePgDatabase<any> = NodePgDatabase<any>> {
  readonly database: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

/** Adds lazy PostgreSQL and Drizzle infrastructure to an application. */
export class DatabaseProvider<
  Config,
  Database extends NodePgDatabase<any> = NodePgDatabase<any>,
> implements Provider<Config> {
  public constructor(protected readonly config: DatabaseConfig) {}

  public register(app: ProviderCompositionApp<Config>): void {
    // The pool stays lazy so minimal maintenance commands can compose safely.
    app.container.registerFactory(
      "databaseClient",
      () => this.createClient(app),
      {
        lifetime: "singleton",
        dispose: (client) => client.close(),
      },
    );
    app.container.registerFactory<Database, {
      databaseClient: DatabaseClient<Database>;
    }>(
      "database",
      ({ databaseClient }) => databaseClient.database,
      { lifetime: "singleton" },
    );
    app.container.registerClass(
      "databaseManager",
      DatabaseManager,
      { lifetime: "scoped" },
    );

    this.registerExtensions(app);
  }

  /** Registers application-specific database services after the common ones. */
  protected registerExtensions(_app: ProviderCompositionApp<Config>): void {}

  /** Creates the typed Drizzle facade. Applications can attach their schema. */
  protected createDatabase(pool: Pool): Database {
    // The default facade has no schema-specific members; subclasses can return
    // a more precise database type from an overridden factory.
    return drizzle(pool) as unknown as Database;
  }

  /** Creates the owned pool and its typed Drizzle facade. */
  protected createClient(
    app: ProviderCompositionApp<Config>,
  ): DatabaseClient<Database> {
    const pool = new Pool(this.createPoolConfig());
    const getInstrumentation = (): DatabaseQueryInstrumentation | undefined => {
      if (!app.container.hasRegistration("observerContext")) {
        return undefined;
      }

      const observer = app.container.resolve(observerContextDependency).get();

      return observer === undefined
        ? undefined
        : {
            record: (event) =>
              recordDatabaseQueryInstrumentation(observer, event),
          };
    };

    instrumentPostgresPool(
      pool,
      this.config.queryObservability,
      getInstrumentation,
    );
    const database = instrumentDrizzleDatabase(
      this.createDatabase(pool),
      this.config.queryObservability,
      getInstrumentation,
    );

    return {
      database,
      pool,
      close: async () => {
        await pool.end();
      },
    };
  }

  /** Maps the validated library configuration to node-postgres options. */
  protected createPoolConfig(): PoolConfig {
    return {
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      ssl: this.config.ssl,
    };
  }
}
