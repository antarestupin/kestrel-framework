# Kestrel

Kestrel is a modular application framework. This repository contains its libraries, tests, Studio, a web starter, and an independent playground. Package names are provisional, all packages are private, and the license is UNLICENSED. No npm publication is authorized.

## Develop and test

Use Node.js 24 and Docker Compose. From this repository root:

```sh
npm ci
npm run infra:up
npm run infra:prepare
npm run build:ai
npm run typecheck
npm run check:boundaries
npm run check:template
npm run test:ai
```

PostgreSQL is available at `127.0.0.1:55432`, with the framework database `kestrel_test` and separate application database `kestrel_playground`. Redis uses `127.0.0.1:56379`, logical database 2 for framework tests. Both services are independent of other repositories. `npm run infra:prepare` is safe to repeat on existing volumes. Use `npm run test:unit` without Docker, or `npm run test:integration` for database adapters. Use `npm run infra:down` to stop services while retaining PostgreSQL data. The devcontainer reuses the same service definitions.

## Local packages and applications

```sh
npm run pack:local
node packages/create-kestrel/bin/create.mjs /tmp/my-web-app --framework-archive artifacts/kestrel-framework-0.0.0.tgz
cd /tmp/my-web-app
npm install
npm run build:ai
npm run test:ai
```

Run `npm run verify:archive` after packing to generate and validate an independent consumer automatically, including package exports, declarations, the CLI, and Studio assets.

The creator copies the archive into the generated application's `vendor` directory. It never installs dependencies or contacts a registry itself. `templates/web` is the canonical template; `apps/playground` follows it, and `npm run check:template` detects drift. To develop the playground, run `npm run dev --workspace=@kestrel/playground`; its database migrations run through `npm run db:migrate --workspace=@kestrel/playground`.

## Documentation

The Docusaurus website in `apps/docs` renders the guides below directly. Run `npm run docs:dev` for local authoring, or `npm run docs:build` followed by `npm run docs:preview` to include local search. See [website maintenance and GitHub Pages setup](apps/docs/README.md).

- [Documentation home](docs/README.md)
- [Usage guides](docs/usage/README.md)
- [Implementation references](docs/implementation/README.md)
- [Packaging and remaining work](docs/implementation/distribution.md)
