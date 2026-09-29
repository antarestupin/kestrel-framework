import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { ProviderCompositionApp } from "@kestrel/framework/app";
import { DatabaseProvider as BaseDatabaseProvider, type DatabaseClient } from "@kestrel/framework/db";
import { databaseCliControllers, LocalDatabaseMaintenance } from "@kestrel/framework/database/seeder";
import type { AppConfig } from "../appConfig.js";
import * as schema from "../db/schema/app_schema.js";
import { applicationDatabaseMaintenance } from "../db/seed.js";

type ApplicationDatabase = NodePgDatabase<typeof schema>;

/** Bind application schema and CLI maintenance while keeping connections lazy. */
export class DatabaseProvider extends BaseDatabaseProvider<AppConfig, ApplicationDatabase> {
  protected override createDatabase(pool: Pool): ApplicationDatabase {
    return drizzle(pool, { schema });
  }

  protected override registerExtensions(app: ProviderCompositionApp<AppConfig>): void {
    app.container.registerFactory(
      "databaseMaintenance",
      ({ databaseClient }: { databaseClient: DatabaseClient<ApplicationDatabase> }) =>
        new LocalDatabaseMaintenance({
          database: databaseClient.database,
          pool: databaseClient.pool,
          environment: app.config.environment,
        }, applicationDatabaseMaintenance),
      { lifetime: "singleton" },
    );
    app.catalog.contribute({ database: { controllers: { cli: databaseCliControllers } } },
      { kind: "provider", provider: this.constructor.name });
  }
}
