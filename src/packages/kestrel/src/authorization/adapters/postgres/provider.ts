import type { Provider, ProviderCompositionApp } from "../../../app/index.js";
import type { DatabaseManager } from "../../../db/index.js";
import { PostgresAuthorizationAdapter } from "./adapter.js";
import { authorizationTables } from "./schema.js";
import type { PostgresAuthorizationTables } from "./tables.js";

interface Dependencies {
  readonly databaseManager: DatabaseManager;
  readonly authorizationAdapter: PostgresAuthorizationAdapter;
}

/** Selects the bundled PostgreSQL RBAC adapter and exposes its focused ports. */
export class PostgresAuthorizationAdapterProvider<Config>
  implements Provider<Config>
{
  public constructor(
    private readonly tables: PostgresAuthorizationTables = authorizationTables,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "authorizationAdapter",
      ({ databaseManager }: Dependencies) =>
        new PostgresAuthorizationAdapter(databaseManager, this.tables),
      { lifetime: "scoped" },
    );

    for (const name of ["permissionResolver", "roleStore", "subjectRoleStore"] as const) {
      app.container.registerFactory(
        name,
        ({ authorizationAdapter }: Dependencies) => authorizationAdapter,
        { lifetime: "scoped" },
      );
    }
  }
}
