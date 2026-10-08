// Binds the application schema to Drizzle and registers database maintenance CLI commands.
// Extend database integration here; connection settings live in ../config/database.ts.

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { dep } from "@kestreljs/framework/di";
import type { ProviderCompositionApp } from "@kestreljs/framework/app";
import {
  PostgresDrizzleProvider as BaseDatabaseProvider,
  type PostgresDrizzleClient,
  type PostgresDrizzleConfig,
} from "@kestreljs/framework/db";
import {
  databaseCliControllers,
  LocalDatabaseMaintenance,
} from "@kestreljs/framework/database/seeder";
import type { AppConfig, Environment } from "../app_config.js";
import * as schema from "../db/schema/app_schema.js";
import { applicationDatabaseMaintenance } from "../db/seed.js";

type ApplicationDatabase = NodePgDatabase<typeof schema>;

/** Typed connection shared by feature adapter definitions without transferring ownership. */
export const databaseDependency = dep<ApplicationDatabase>("database");

/** Bind application schema and CLI maintenance while keeping connections lazy. */
export class PostgresDrizzleProvider extends BaseDatabaseProvider<AppConfig, ApplicationDatabase> {
  public constructor(
    config: PostgresDrizzleConfig,
    private readonly environment: Environment,
  ) {
    super(config, { createDatabase: (pool) => drizzle(pool, { schema }) });
  }

  protected override registerExtensions(app: ProviderCompositionApp<AppConfig>): void {
    app.container.registerFactory(
      "databaseMaintenance",
      ({ databaseClient }: { databaseClient: PostgresDrizzleClient<ApplicationDatabase> }) =>
        new LocalDatabaseMaintenance(
          {
            database: databaseClient.database,
            pool: databaseClient.pool,
            environment: this.environment,
          },
          applicationDatabaseMaintenance,
        ),
      { lifetime: "singleton" },
    );
    app.catalog.contribute(
      { database: { controllers: { cli: databaseCliControllers } } },
      { kind: "provider", provider: this.constructor.name },
    );
  }
}
