<!-- Explains application setup, configuration, development commands, and deployment. Keep this guide aligned with your application as you customize it. -->

# __KESTREL_DISPLAY_NAME__

This experimental template consumes `@kestreljs/framework` at the exact compatible version declared in `package.json`. By default, dependencies come from npm when you install them. If created with `--framework-archive`, it uses a vendored local framework archive instead. Use Node.js 24 (`nvm use`) and run `npm install` in the generated project; commit the resulting application-specific lockfile.

## Welcome page

The starter home page lives in `src/client/src/main.tsx`, with responsive styles in `src/client/src/styles.css`. It links to Studio at `/_studio` during local development and to the [public Kestrel documentation](https://antarestupin.github.io/kestrel-framework/). The typed greeting API remains available through `src/client/src/api.ts` as an example for your own screens.

## Application commands

`./do` runs the Kestrel CLI against the default application exported by `src/server/core/app.ts`. It resolves the project from its own location, so invocation also works from another directory. Application providers are lazy: help and client generation do not open HTTP listeners or database connections. Composition is declared directly in `src/server/core/app.ts`. HTTP tests own that application for their suite; CLI tests use separate processes so disposal does not leak across tests running with `--no-isolate`.

| Command | Purpose |
| --- | --- |
| `./do --help` | List the application's CLI commands. |
| `npm run dev` | Run `run server` with Node's watch mode and Vite HMR. |
| `npm start` | Run the compiled application in production mode. |
| `npm run api:generate` | Run `generate http-clients` through the same application. |
| `npm run db:generate` | Generate migrations with Kestrel schema contributions. |
| `npm run db:check` | Validate the migration journal and snapshots. |
| `npm run db:migrate` | Run `database migrate` through the application provider. |
| `npm run db:dev:migrate` | Migrate application tables, push local tables, and install their schema contributions. |
| `npm run infra:up` | Build and start PostgreSQL, Drizzle Studio, and selected optional services. |
| `npm run dev:database` | Run Drizzle Studio on the host when its Compose service is stopped. |
| `npm run typecheck` | Check all application and test types. |
| `npm run test:ai` | Run tests without isolation or HTTP listeners. |
| `npm run build:ai` | Generate the client, compile the server, copy migrations, and build the browser. |

The local-only `database seed`, `database reset`, and `database reset-seed` commands use the explicit boundaries in `src/server/core/db/seed.ts`. Reset deletes the application's `public`, `dev`, and migration-journal schemas before rebuilding them. Use a database dedicated to this application.

## Configuration and database

Copy `.env.example` to `.env` for local overrides. The application and Drizzle load it only in the local environment, without overriding process variables. `ENVIRONMENT` selects an explicit environment; otherwise `NODE_ENV=production` selects `prod`, `NODE_ENV=test` selects `test`, and the default is `local`. The supported environments are `local`, `test`, `stage`, and `prod`. Tests use `DB_TEST_DATABASE` instead of the application database. `stage` and `prod` require `DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_DATABASE`; they default to port 5432 and TLS enabled.

`src/server/core/app_config.ts` owns the configuration API, environment selection, local `.env` loading, and resolution. Its `AppConfigurationApi` and `Environment` types are shared through type-only imports. Feature factories in `core/config/` declare multiline settings for core paths, HTTP, browser delivery, database, logging, and Studio. Schema-backed settings support conventional overrides such as `APP_CONFIG__HTTP__EXECUTION_ID_HEADER=x-request-id`. Explicit variables such as `PORT` retain their dedicated names; do not also provide a conventional override for the same field. Drizzle consumes the same resolved database settings.

Local PostgreSQL defaults to port 55432 and database `__KESTREL_DATABASE_NAME__`; tests use `__KESTREL_TEST_DATABASE_NAME__`. Run `npm run infra:up` for PostgreSQL, Drizzle Studio, and any selected optional services, or configure existing services. Drizzle Studio's backend is bound to `127.0.0.1:4983`; open https://local.drizzle.studio to browse the database. Its image installs the generated application's dependencies from npm or the optional vendored framework archive, honors the lockfile when present, and disables installation scripts. It reads live application schemas and configuration through read-only mounts and uses the Compose database credentials. It does not reuse host or devcontainer `node_modules`, and the tooling image rebuilds when dependencies change. Run `npm run db:migrate` before database operations. `npm run infra:down` stops services without deleting volumes.

`drizzle.database.ts` shares database configuration with the application without loading its providers. Deployment declarations live in `src/server/core/db/schema/app_schema.ts`. SQL migrations, snapshots, and the journal live in `src/server/core/db/migrations/`. `drizzle.dev.config.ts` browses application and development schemas; `drizzle.dev-push.config.ts` only synchronizes the exported `dev` tables. The shared filters in `development_schema.ts` must match the exports in `schema/push_schema.ts` when adding local tables. Logs, observations, and captured emails are available as local storage declarations; configure their providers when enabling those features.

The build copies migrations into `dist/server/core/db/migrations/`. To migrate a compiled deployment, run `NODE_ENV=production KESTREL_COMPILED=1 ./do database migrate`. Retain the complete `dist` directory, the launcher, and runtime dependencies. The default source commands use the runtime `tsx` dependency.

## Browser client

`src/server/example/example_catalog.ts` owns the example feature's actions and controllers. `src/server/core/app_catalog.ts` composes feature catalogs and derives the HTTP catalog used for generation. Add definitions to their owning feature catalog, then include that catalog in the application.

The UI calls the generated factory in `src/generated/public_client/public_client.ts` through the shared instance in `src/client/src/api.ts`. Regenerate contracts after changing controllers; never edit generated files manually. `HttpClientGenerationProvider` uses `src/server/core/config/http.ts` for its audience and output settings. The build regenerates the client automatically.

`src/server/core/development_clients.ts` creates one lazy `ViteDevelopmentRuntime` for the application. `vite.development.config.ts` owns its development graph. `src/client/vite.config.ts` builds the standalone browser from `src/client/src/main.tsx` into `dist/client`. The client HTML remains in `src/client/index.html`. Both use the same client entry, and generated server links are type-only. Browser delivery is disabled in the test environment so API tests need neither Vite nor compiled application assets.

## Studio

Open `/_studio` on the application's HTTP origin during local development. `core/config/studio.ts` enables Studio only in `local`; the application provider installs action and HTTP controller explorers, PostgreSQL schema inspection, and a link to Drizzle Studio. `DRIZZLE_STUDIO_URL` overrides that browser-facing link. The PostgreSQL pool is resolved only when the schema endpoint is requested, so CLI help, client generation, and catalog inspection keep infrastructure lazy. `PROJECT_ROOT` maps source links to the editor's project directory when the application runs in a container.

Studio uses the installed framework's prebuilt assets alongside the application's single Vite HMR runtime. It does not start another development server or require a sibling framework checkout. Editing Studio sources through that shared runtime is a separate source-integration workflow; adding that opt-in profile remains deferred. Logs, observations, email, workers, and workflows can gain explorers when their runtime providers are installed.

## Development environment

The `.devcontainer` directory supplies Node.js, PostgreSQL, Drizzle Studio, and a non-destructive test-database provisioner. It mounts only this application and its optional vendored archive; it needs no sibling repository. The application port is forwarded by the editor, while the separate Drizzle service publishes its own loopback port. `.nvmrc`, `.vscode/settings.json`, `.gitignore`, and `AGENTS.md` provide the matching local tooling conventions. The source and compiled CLI launchers target POSIX shells; a native Windows launcher remains a future addition.
