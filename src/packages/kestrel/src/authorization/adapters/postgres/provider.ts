import type { Provider, ProviderCompositionApp } from "../../../app/index.js";
import type { DatabaseManager } from "../../../db/index.js";
import { PostgresSubjectRoleStore } from "./store.js";
import { authorizationTables } from "./schema.js";
import type { PostgresAuthorizationTables } from "./tables.js";

/** Registers PostgreSQL assignments independently from permission resolution. */
export class PostgresSubjectRoleStoreProvider<Config> implements Provider<Config> {
  public constructor(
    private readonly tables: PostgresAuthorizationTables = authorizationTables,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "subjectRoleStore",
      ({ databaseManager }: { readonly databaseManager: DatabaseManager }) =>
        new PostgresSubjectRoleStore(databaseManager, this.tables),
      { lifetime: "scoped" },
    );
  }
}
