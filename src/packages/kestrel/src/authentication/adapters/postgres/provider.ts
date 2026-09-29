import type { Provider, ProviderCompositionApp } from "../../../app/index.js";
import type { DatabaseManager } from "../../../db/index.js";
import { PostgresAuthenticationAdapter } from "./adapter.js";
import { authenticationTables } from "./schema.js";
import type { PostgresAuthenticationTables } from "./tables.js";

interface PostgresAuthenticationAdapterDependencies {
  readonly databaseManager: DatabaseManager;
}

/** Selects PostgreSQL persistence without coupling the core provider to it. */
export class PostgresAuthenticationAdapterProvider<Config, Claims = unknown>
  implements Provider<Config>
{
  public constructor(
    private readonly tables: PostgresAuthenticationTables = authenticationTables,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "authenticationAdapter",
      ({ databaseManager }: PostgresAuthenticationAdapterDependencies) =>
        new PostgresAuthenticationAdapter<Claims>(databaseManager, this.tables),
      { lifetime: "scoped" },
    );
  }
}
