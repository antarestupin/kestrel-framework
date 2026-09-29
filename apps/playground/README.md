# Kestrel web application

This template consumes the provisional `@kestrel/framework` package. No npm release exists or is authorized. The creator vendors a local framework archive. Use Node.js 24 (`nvm use`) and run `npm install` in the generated project; commit the resulting application-specific lockfile.

## Application commands

`./do` runs the Kestrel CLI against the default application exported by `src/server/core/app.ts`. It resolves the project from its own location, so invocation also works from another directory. Application providers are lazy: help and client generation do not open HTTP listeners or database connections. Tests create independent applications through `src/server/core/app_factory.ts`.

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
| `npm run dev:database` | Browse application and local tables in Drizzle Studio. |
| `npm run typecheck` | Check all application and test types. |
| `npm run test:ai` | Run tests without isolation or HTTP listeners. |
| `npm run build:ai` | Generate the client, compile the server, copy migrations, and build the browser. |

The local-only `database seed`, `database reset`, and `database reset-seed` commands use the explicit boundaries in `src/server/core/db/seed.ts`. Reset deletes the application's `public`, `dev`, and migration-journal schemas before rebuilding them. Use a database dedicated to this application.

## Configuration and database

Copy `.env.example` to `.env` for local overrides. The application and Drizzle load it only in the local environment, without overriding process variables. `ENVIRONMENT` selects an explicit environment; otherwise `NODE_ENV=production` selects `prod`, `NODE_ENV=test` selects `test`, and the default is `local`. Tests use `DB_TEST_DATABASE` instead of the application database.

PostgreSQL defaults to port 55432 and database `kestrel_playground`. Run `npm run infra:up` for the template's PostgreSQL and Redis containers, or configure existing services. The repository playground already uses the framework infrastructure on those ports; do not start a second copy there. Run `npm run db:migrate` before database operations. `npm run infra:down` stops services without deleting volumes.

`drizzle.database.ts` shares database configuration with the application without loading its providers. Deployment declarations live in `src/server/core/db/schema/app_schema.ts`. SQL migrations, snapshots, and the journal live in `src/server/core/db/migrations/`. `drizzle.dev.config.ts` browses application and development schemas; `drizzle.dev-push.config.ts` only synchronizes the exported `dev` tables. The shared filters in `development_schema.ts` must match the exports in `schema/push_schema.ts` when adding local tables. Logs, observations, and captured emails are available as local storage declarations; configure their providers when enabling those features.

The build copies migrations into `dist/server/core/db/migrations/`. To migrate a compiled deployment, run `NODE_ENV=production KESTREL_COMPILED=1 ./do database migrate`. Retain the complete `dist` directory, the launcher, and runtime dependencies. The default source commands use the runtime `tsx` dependency.

## Browser client

The UI calls the generated factory in `src/generated/publicClient/publicClient.ts` through the shared instance in `src/client/api.ts`. Regenerate contracts after changing controllers; never edit generated files manually. `HttpClientGenerationProvider` uses `src/server/core/http_client_generation.ts` for its audience and output settings. The build regenerates the client automatically.

`vite.development.config.ts` owns the shared development graph. `vite.config.ts` builds the standalone browser into `dist/web`. Both use the same client entry, and generated server links are type-only.

## Development environment

The `.devcontainer` directory supplies Node.js, PostgreSQL, Redis, and a non-destructive test-database provisioner. It mounts only this application and its vendored archive; it needs no sibling repository. `.nvmrc`, `.vscode/settings.json`, `.gitignore`, and `AGENTS.md` provide the matching local tooling conventions. The source and compiled CLI launchers target POSIX shells; a native Windows launcher remains a future addition.
