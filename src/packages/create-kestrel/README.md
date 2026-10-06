# Kestrel application generator

Run `npx @kestreljs/create-kestrel@latest my-app` from the parent directory. The creator creates `my-app/` and generates the application inside it; no manual `mkdir` is needed. Relative and absolute paths are also accepted. The generated application declares the exact compatible `@kestreljs/framework` version bundled in the template; run `npm install` in the application directory to fetch its dependencies. The creator itself does not install dependencies or contact the registry. It requires Node.js 24.11 or later within the Node.js 24 line.

For checkout setup and testing unpublished changes, see the [contribution guide](https://github.com/antarestupin/kestrel-framework/blob/main/docs/contributing.md). The installed executable remains `create-kestrel`; Yeoman is internal and needs no global `yo` installation.

An interactive terminal asks for the cache backend, PostgreSQL or Redis. Selecting Redis automatically includes Redis Insight for local development. Explicit arguments skip their corresponding questions. Redirected input and `--yes` use PostgreSQL when the cache choice is unspecified.

```sh
npx @kestreljs/create-kestrel@latest my-app --cache postgres --yes
npx @kestreljs/create-kestrel@latest my-app --cache redis --yes
```

The creator validates the destination and choices before writing, uses the compatible framework version declared in its template, and never installs application dependencies. The base application includes local Studio explorers at `/_studio`, a feature-owned example catalog, and one application HMR runtime alongside the packaged Studio browser. Configuration API and environment selection live in `core/appConfig.ts`; feature configuration objects are multiline. PostgreSQL remains the only application database. `npm run infra:up` builds and starts Drizzle Studio on loopback port 4983 alongside it; open https://local.drizzle.studio. Its cache variant includes the infrastructure schema and migration. The Redis variant includes an application-owned connection provider, `@redis/client`, configuration and a Compose service. Redis Insight contributes local UI tooling and its persistent settings volume, available at http://127.0.0.1:5540 after `npm run infra:up`.

The application generator composes the bundled `base`, `cache`, and shared `redis` generators (the latter only when required) through Yeoman's lifecycle and staged filesystem. The base owns `template/`; each feature keeps its generator and supporting templates together under `generators/`. Compose contributions preserve existing services and derive the infrastructure startup command from the composed service inventory. The application composes Redis once when a feature requires it; the Redis generator owns its connection provider, configuration, client dependency, service and Redis Insight. Cache only composes its adapter and borrows the default `redisDependency` connection. Other features can reuse that connection without depending on cache. The local service uses `noeviction` to protect coordination keys; native LRU requires a dedicated cache instance. Additional connections can be registered and selected through custom dependency descriptors. No external generator discovery or installation occurs.

See [installation and choices](https://github.com/antarestupin/kestrel-framework/blob/main/docs/usage/installation.md#create-an-application) and [implementation details](https://github.com/antarestupin/kestrel-framework/blob/main/docs/implementation/distribution.md#application-generation).

Future work includes additional client stacks and services, public third-party generators, and adding features to existing projects. Creation accepts a missing or empty destination; it does not merge user-edited applications. The starter has no scheduled-task runtime, so PostgreSQL cache pruning must be arranged before production use.
