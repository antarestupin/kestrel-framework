# Installation and local development

[Usage index](README.md) · [Distribution internals](../implementation/distribution.md)

No npm release is available or authorized. Use Node.js 24 and the locally packed `@kestrel/framework` archive. Names and license are provisional. Build the repository with `npm run build:ai`, then run `npm run pack:local`; install the resulting archive with `npm install /path/to/kestrel-framework-0.0.0.tgz`.

Import supported subpaths, such as `@kestrel/framework/app`, `@kestrel/framework/http`, and the browser-safe `@kestrel/framework/http/client`. Internal source paths are not consumer APIs. The `kestrel` executable accepts an application module followed by CLI arguments. For compiled code, use `node --import zod/compile node_modules/@kestrel/framework/dist/cli/main.js dist/server/core/app.js <command>`. For TypeScript modules use `node --import tsx --import zod/compile node_modules/@kestrel/framework/dist/cli/main.js src/server/core/app.ts <command>`. Dispose application resources when invoking execution APIs directly.

Studio ships prebuilt assets and its client adapter defaults to production delivery. The provider's `devMode` must remain false for installed-package use. Source development requires an explicitly composed `ViteDevelopmentRuntime` and the repository's source entry; it is not inferred from application environment variables. Application UI development still uses the application's own Vite configuration.

## Independent integration-test infrastructure

Run `npm run infra:up` and `npm run infra:prepare` in the framework repository. PostgreSQL initialization creates `kestrel_test` without resetting existing data. The Compose service separately creates `kestrel_playground`. Framework suites own and clean up their test tables or schemas; Redis test contexts use logical database 2 and unique key prefixes, and never flush the shared database.

Default ports are 55432 for PostgreSQL and 56379 for Redis. Override `KESTREL_POSTGRES_PORT` and `KESTREL_REDIS_PORT` for host testing. Test helpers also accept `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`, `KESTREL_TEST_DATABASE`, and `KESTREL_TEST_REDIS_URL`. Managed database names must be `kestrel_test` or `kestrel_test_<suffix>`. The devcontainer uses service hostnames and internal ports. CI runs the same provisioner and required integration suites; connection failures fail those suites.

Stop services with `npm run infra:down`. Tests clean up their own resources; there is intentionally no routine command deleting the shared PostgreSQL volume. A deliberate full infrastructure reset removes playground data as well and is outside normal test preparation.

## Create an application

After building the repository, run `node src/packages/create-kestrel/bin/create.mjs <empty-directory> --framework-archive artifacts/kestrel-framework-0.0.0.tgz`. The generator requires an empty destination, copies the versioned template directly from `src/packages/create-kestrel/template`, and stores the local archive inside the application. Install dependencies, then run `npm run build:ai` and `npm run test:ai` there. Generated applications keep their SQL migrations, snapshots, and journal in `src/server/core/db/migrations/`; use `npm run db:generate` and `npm run db:migrate` to generate and apply them. The template's README documents database provisioning, fresh migrations, client generation, development, and production commands.

The starter uses `HttpClientGenerationProvider` through `npm run api:generate` to produce `src/generated/publicClient/publicClient.ts` from its HTTP controller catalog. Keep generated contracts in that directory and browser configuration in `src/client/src/api.ts`, which instantiates the generated factory. Regenerate after changing controllers; `npm run build:ai` does this automatically. See [typed HTTP client generation](./client.md#generate-a-typed-http-client).

Generated projects include the executable `do` launcher: use `./do --help`, `./do run server`, `./do generate http-clients`, and `./do database migrate`. The npm commands delegate to this shared application composition. Local `.env` loading, Drizzle development configurations, Node/editor conventions, and an independent devcontainer are included. The build copies migration assets for `NODE_ENV=production KESTREL_COMPILED=1 ./do database migrate`. See the generated README for the full root-file inventory and local reset boundaries.

The starter places browser sources in `src/client/src/`, production Vite configuration in `src/client/vite.config.ts`, and browser output in `dist/client/`. Server composition lives directly in `src/server/core/app.ts`; `appConfig.ts` assembles the feature configurations in `core/config/`. Set `DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_DATABASE` for `stage` or `prod`; TLS defaults to enabled there. Schema-backed configuration accepts `APP_CONFIG__…` overrides for fields without dedicated environment-variable bindings.
