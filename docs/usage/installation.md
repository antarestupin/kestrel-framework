# Installation

[Usage index](README.md) · [Contributing and framework development](../contributing.md) · [Distribution internals](../implementation/distribution.md)

Kestrel is available on npm as `@kestreljs/framework` and `@kestreljs/create-kestrel`. The published releases are experimental: APIs and behavior may change without backward compatibility. Kestrel and its starter sources are MIT-licensed; retain the supplied license and copyright notice when redistributing them.

## Requirements

Use Node.js 24.11 or later within the Node.js 24 line, with npm and npx available. Docker Compose is needed if you use the generated application's PostgreSQL, Redis, and Drizzle Studio services. The generated `./do` launcher and npm scripts require a POSIX shell, such as macOS, Linux, or WSL.

## Install in an existing application

From your application's directory, install the published framework:

```sh
npm install @kestreljs/framework
```

This uses npm's `latest` tag. Use `@next` explicitly when opting into the next prerelease channel; a `latest` tag does not imply a stable API while Kestrel remains experimental. Commit your application's lockfile to keep dependency resolution reproducible.

Import supported subpaths, such as `@kestreljs/framework/app`, `@kestreljs/framework/http`, and the browser-safe `@kestreljs/framework/http/client`. Internal source paths are not consumer APIs. Follow [application composition](./app.md) and [configuration](./configuration.md) to integrate providers and services into an existing project, or use the starter below for a configured web application.

## Create an application

Run the generator from the parent directory where you want the application to live:

```sh
npx @kestreljs/create-kestrel@latest my-app
cd my-app
npm install
```

The creator creates `my-app/` and generates the application inside it; no manual `mkdir` is needed. Relative and absolute paths are also accepted. An existing destination must be empty. No global generator installation is needed. The generated application declares an exact compatible framework version; `npm install` downloads it and the application's other dependencies from npm.

To use the bundled local services and start the generated application, run these commands inside `my-app/`:

```sh
npm run infra:up
npm run db:dev:migrate
npm run dev
```

`infra:up` starts PostgreSQL, Drizzle Studio, and the selected optional Redis services. `db:dev:migrate` applies application migrations and prepares development-only tables used by Studio. Open the application URL printed by the server, and visit `/_studio` on the same origin for Studio. Stop the development process when finished and run `npm run infra:down` to stop its services while keeping their data. If you supply your own database instead, configure the generated `.env` using `.env.example`.

Run `npm run build:ai` and `npm run test:ai` inside the generated application to build and test it. Its database migrations live in `src/server/core/db/migrations/`; use `npm run db:generate` and `npm run db:migrate` when preparing and applying deployment migrations. The generated README describes configuration, commands, and local database reset boundaries.

## Choose the cache backend

In a terminal, the generator asks you to choose PostgreSQL or Redis for the cache. Selecting Redis automatically includes Redis Insight for local development. These examples are alternatives; use a different application name for each project:

```sh
npx @kestreljs/create-kestrel@latest my-app --cache postgres --yes
npx @kestreljs/create-kestrel@latest my-app --cache redis --yes
```

`--yes` and noninteractive input use PostgreSQL when the cache choice is unspecified. Invalid cache values and unknown options fail before files are written. Redis Insight has no separate enable/disable flags. The creator neither installs application dependencies nor discovers third-party generators.

PostgreSQL remains the database for both variants. The PostgreSQL cache uses the framework adapter and includes the `utils.cache_entry` schema, migration, UNLOGGED contribution and reset boundary. The Redis cache adds `@redis/client`, a lazy application-owned connection, typed `REDIS_URL` configuration and a loopback-bound Compose service. The cache borrows the shared connection exposed by `redisDependency`; `RedisProvider` owns its lifecycle independently of cache. It uses native expiration and does not support tags. The generated Redis service uses `noeviction`, so memory pressure rejects writes instead of evicting shared coordination keys; TTL expiration still applies. You can register additional Redis providers under distinct dependency descriptors and pass one to `RedisCacheProvider` when isolation is needed. `stage` and `prod` require an explicit Redis URL. The starter has no scheduled-task runtime, so automatic PostgreSQL pruning is disabled; arrange cache pruning before production use. See [cache usage](./cache.md).

Whenever Redis is installed, Redis Insight joins `npm run infra:up`, preconfigures the local Redis connection and persists its UI settings in a named volume. Open http://127.0.0.1:5540 for local development. `npm run infra:down` stops it without deleting its settings. See [Redis Insight Docker installation](https://redis.io/docs/latest/operate/redisinsight/install/install-on-docker/) and [connection configuration](https://redis.io/docs/latest/operate/redisinsight/configuration/).

## Develop your application

The starter uses `HttpClientGenerationProvider` through `npm run api:generate` to produce `src/generated/publicClient/publicClient.ts` from its HTTP controller catalog. Keep generated contracts in that directory and browser configuration in `src/client/src/api.ts`, which instantiates the generated factory. Regenerate after changing controllers; `npm run build:ai` does this automatically. See [typed HTTP client generation](./client.md#generate-a-typed-http-client).

Generated projects include the executable `do` launcher: use `./do --help`, `./do run server`, `./do generate http-clients`, and `./do database migrate`. The npm commands delegate to this shared application composition. Local `.env` loading, Drizzle development configurations, Node/editor conventions, and an independent devcontainer are included. The build copies migration assets for `NODE_ENV=production KESTREL_COMPILED=1 ./do database migrate`. See the generated README for the full root-file inventory and local reset boundaries.

The starter places browser sources in `src/client/src/`, production Vite configuration in `src/client/vite.config.ts`, and browser output in `dist/client/`. Server composition lives directly in `src/server/core/app.ts`. Feature definitions belong to their own catalogs, starting with `example/exampleCatalog.ts`; `core/appCatalog.ts` composes them. `appConfig.ts` owns the typed configuration API, supported environments, local `.env` loading, and resolution of the multiline factories in `core/config/`. Set `DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_DATABASE` for `stage` or `prod`; TLS defaults to enabled there. Schema-backed configuration accepts `APP_CONFIG__…` overrides for fields without dedicated environment-variable bindings.

## Explore Studio

Generated applications include [Studio](./studio.md) at `/_studio` in the local environment, with actions, HTTP controllers, database schema inspection, and a Drizzle Studio link. `core/development_clients.ts` creates one lazy Vite runtime for application HMR; Studio serves its packaged browser assets alongside it. `npm run infra:up` also builds and starts a separate Drizzle Studio service on loopback port 4983. Its image installs the generated application's dependencies without lifecycle scripts, using npm and the lockfile when available; schemas and configuration are mounted read-only. Open https://local.drizzle.studio, or override the link through `DRIZZLE_STUDIO_URL`. Run `npm run dev:database` only when the Compose service is stopped to avoid a port conflict. No sibling framework sources are required.

## Work on the framework

For repository setup, framework tests, and trying unpublished changes in an application, use the [contribution and framework development guide](../contributing.md). The npm installation and npx creation commands above consume published packages directly.
