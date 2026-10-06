import type { ProviderCompositionApp } from "@kestreljs/framework/app";
import type { DatabaseClient } from "@kestreljs/framework/db";
import { dep } from "@kestreljs/framework/di";
import {
  StudioProvider as KestrelStudioProvider,
  ViteStudioClientAdapter,
  type StudioExtension,
} from "@kestreljs/framework/studio";
import { defineActionsDocumentationExtension } from "@kestreljs/framework/studio/extensions/actions";
import { defineControllersStudioExtension } from "@kestreljs/framework/studio/extensions/controllers";
import {
  defineDatabaseStudioExtension,
  PostgresDatabaseSchemaSource,
  type DatabaseSchemaSource,
} from "@kestreljs/framework/studio/extensions/database";
import type { AppConfig } from "../app_config.js";

/** Installs the application's catalogs and lazily resolved database into Studio. */
export class StudioProvider extends KestrelStudioProvider<AppConfig, AppConfig["studio"]> {
  public constructor(
    config: AppConfig["studio"],
    private readonly paths: Pick<AppConfig["core"], "runtimeRoot" | "projectRoot">,
  ) {
    super(config);
  }

  protected override createClient(): ViteStudioClientAdapter {
    return new ViteStudioClientAdapter({
      // Installed packages include built Studio assets, not its browser source tree.
      dev: this.config.devMode,
      sourcePathMapping: {
        runtimeRoot: this.paths.runtimeRoot,
        editorRoot: this.paths.projectRoot,
      },
    });
  }

  protected override createExtensions(app: ProviderCompositionApp<AppConfig>): readonly StudioExtension[] {
    const databaseSource: DatabaseSchemaSource = {
      // Catalog inspection and CLI commands must not construct a database client.
      getLayout: () => {
        const { pool } = app.container.resolve(dep<DatabaseClient>("databaseClient"));
        return new PostgresDatabaseSchemaSource(pool).getLayout();
      },
    };

    return [
      defineDatabaseStudioExtension(databaseSource, this.config.drizzleStudioUrl),
      defineActionsDocumentationExtension(app.catalog.actions.definitions),
      defineControllersStudioExtension(app.catalog.httpControllers.catalog, {
        executionIdHeader: app.config.http.executionIdHeader,
      }),
    ];
  }
}
