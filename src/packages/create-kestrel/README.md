# Kestrel application generator

Build the framework with `npm run pack:local` from the repository root, then run `node src/packages/create-kestrel/bin/create.mjs <empty-directory> --framework-archive artifacts/kestrel-framework-0.0.0.tgz`. The installed executable remains `create-kestrel`; Yeoman is its internal generation engine and does not require a global `yo` installation. The creator requires Node.js 24.11 or later in the Node.js 24 line. Names are provisional and publication requires explicit owner approval.

An interactive terminal asks for the cache backend, PostgreSQL or Redis. When Redis is selected it also asks whether to add Redis Insight, defaulting to no. Explicit arguments skip their corresponding questions. Redirected input and `--yes` use PostgreSQL and no Redis Insight for unspecified choices.

```sh
node src/packages/create-kestrel/bin/create.mjs my-app --framework-archive artifacts/kestrel-framework-0.0.0.tgz --cache postgres --yes
node src/packages/create-kestrel/bin/create.mjs my-app --framework-archive artifacts/kestrel-framework-0.0.0.tgz --cache redis --no-redis-insight
node src/packages/create-kestrel/bin/create.mjs my-app --framework-archive artifacts/kestrel-framework-0.0.0.tgz --cache redis --redis-insight
```

The creator validates the destination and choices before writing, vendors the supplied framework archive, and never installs application dependencies. The base application includes local Studio explorers at `/_studio`, a feature-owned example catalog, and one application HMR runtime alongside the packaged Studio browser. Configuration API and environment selection live in `core/appConfig.ts`; feature configuration objects are multiline. PostgreSQL remains the only application database. `npm run infra:up` builds and starts Drizzle Studio on loopback port 4983 alongside it; open https://local.drizzle.studio. Its cache variant includes the infrastructure schema and migration. The Redis variant includes an application-owned connection provider, `@redis/client`, configuration and a Compose service. Redis Insight contributes local UI tooling and its persistent settings volume, available at http://127.0.0.1:5540 after `npm run infra:up`.

The application generator composes the bundled `base`, `cache`, and optional `redis-insight` generators through Yeoman's lifecycle and staged filesystem. The base owns `template/`; each feature keeps its generator and supporting templates together under `generators/`. Compose contributions preserve existing services and derive the infrastructure startup command from the composed service inventory. Redis Insight checks for the actual Redis service, allowing future Redis consumers to participate without removing another feature's service. No external generator discovery or installation occurs.

See [installation and choices](../../../docs/usage/installation.md#create-an-application) and [implementation details](../../../docs/implementation/distribution.md#application-generation).

Future work includes additional client stacks and services, public third-party generators, and adding features to existing projects. Creation currently requires an empty destination; it does not merge user-edited applications. The starter has no scheduled-task runtime, so PostgreSQL cache pruning must be arranged before production use.
