import type { Provider, ProviderCompositionApp } from "../../../app/index.js";
import type { DatabaseManager } from "../../../db/index.js";
import { PostgresTokenStore } from "./adapter.js";
import { tokenRecords } from "./schema.js";
import type { PostgresTokenTable } from "./tables.js";

interface PostgresTokenStoreDependencies {
  readonly databaseManager: DatabaseManager;
}

/** Selects PostgreSQL token persistence with an overridable table mapping. */
export class PostgresTokenAdapterProvider<Config> implements Provider<Config> {
  public constructor(
    private readonly table: PostgresTokenTable = tokenRecords,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "tokenStore",
      ({ databaseManager }: PostgresTokenStoreDependencies) =>
        new PostgresTokenStore(databaseManager, this.table),
      { lifetime: "scoped" },
    );
  }
}
