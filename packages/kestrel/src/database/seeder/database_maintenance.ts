import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import type { DatabaseMaintenanceDefinition } from "./definition.js";
import { migrateDatabase } from "../migrator/index.js";
import { resetDatabase } from "./database_resetter.js";
import { seedDatabase } from "./database_seeder.js";

export interface DatabaseMaintenance {
  migrate(): Promise<void>;
  reset(): Promise<void>;
  resetAndSeed(): Promise<void>;
  seed(): Promise<void>;
}

export interface DatabaseMaintenanceDependencies {
  readonly database: NodePgDatabase<any>;
  readonly environment: string;
  readonly pool: Pool;
}

/** Owns guarded database maintenance workflows exposed by local tooling. */
export class LocalDatabaseMaintenance implements DatabaseMaintenance {
  public constructor(
    private readonly dependencies: DatabaseMaintenanceDependencies,
    private readonly definition: DatabaseMaintenanceDefinition,
  ) {}

  public async migrate(): Promise<void> {
    await migrateDatabase(
      this.dependencies.database,
      this.definition.migration,
    );
  }

  public async seed(): Promise<void> {
    this.assertLocal();
    await seedDatabase(this.dependencies.database, this.definition.seed);
  }

  public async reset(): Promise<void> {
    this.assertLocal();
    await resetDatabase(
      this.dependencies.pool,
      this.dependencies.database,
      this.definition.reset,
      this.definition.migration,
    );
  }

  public async resetAndSeed(): Promise<void> {
    this.assertLocal();
    await resetDatabase(
      this.dependencies.pool,
      this.dependencies.database,
      this.definition.reset,
      this.definition.migration,
    );
    await seedDatabase(this.dependencies.database, this.definition.seed);
  }

  /** Prevents destructive maintenance outside local development. */
  private assertLocal(): void {
    if (this.dependencies.environment !== "local") {
      throw new Error(
        "Database maintenance is only allowed in the local environment.",
      );
    }
  }
}
