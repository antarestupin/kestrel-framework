# Kestrel

Kestrel is a modular application framework. This repository contains its libraries, tests, Studio, a web starter, and an independent playground.

## Project status

Kestrel is experimental and under active development. APIs and behavior may change without notice, and backward compatibility is not guaranteed. It is not ready for production use.

The repository is being made public to support the planned distribution of Kestrel packages on npm and documentation on GitHub Pages. External contributions, including pull requests, are not accepted at this stage. No support or response times are guaranteed.

Kestrel is licensed under the [MIT License](LICENSE). Package names are provisional and all packages are currently marked private. npm publication remains pending and requires explicit owner approval.

## Develop and test

GitHub Actions validation is paused. Its workflow is preserved in `.github/workflows/validate.yml.disabled`; rename it to `validate.yml` to restore validation on pushes and pull requests. Local validation commands remain available below.

Use Node.js 24 and Docker Compose. From this repository root:

```sh
npm ci
npm run infra:up
npm run infra:prepare
npm run build:ai
npm run typecheck
npm run check:boundaries
npm run check:playground
npm run test:ai
```

PostgreSQL is available at `127.0.0.1:55432`, with the framework database `kestrel_test` and separate application database `kestrel_playground`. Redis uses `127.0.0.1:56379`, logical database 2 for framework tests. Both services are independent of other repositories. `npm run infra:prepare` is safe to repeat on existing volumes. Use `npm run test:unit` without Docker, or `npm run test:integration` for database adapters. Use `npm run infra:down` to stop services while retaining PostgreSQL data. The devcontainer reuses the same service definitions.

## Local packages and applications

All npm workspaces live under `src/`: framework and starter packages in `src/packages/`, and the playground and documentation website in `src/apps/`. Run workspace commands from the repository root; shared guides, infrastructure, and verification scripts remain in `docs/`, `infrastructure/`, and `scripts/`.

```sh
npm run pack:local
node src/packages/create-kestrel/bin/create.mjs /tmp/my-web-app --framework-archive artifacts/kestrel-framework-0.0.0.tgz
cd /tmp/my-web-app
npm install
npm run build:ai
npm run test:ai
```

Run `npm run verify:archive` after packing to generate and validate an independent consumer automatically, including package exports, declarations, the CLI, and Studio assets.

The creator copies the archive into the generated application's `vendor` directory. It never installs dependencies or contacts a registry itself. `src/packages/create-kestrel/template` is the canonical template; `src/apps/playground` follows it, and `npm run check:playground` detects drift. To develop the playground, run `npm run dev --workspace=@kestrel/playground`; its database migrations run through `npm run db:migrate --workspace=@kestrel/playground`.

## Documentation

The Docusaurus website in `src/apps/docs` renders the guides below directly. Run `npm run docs:dev` for local authoring, or `npm run docs:build` followed by `npm run docs:preview` to include local search. See [website maintenance and GitHub Pages setup](src/apps/docs/README.md).

- [Documentation home](docs/README.md)
- [Usage guides](docs/usage/README.md)
- [Implementation references](docs/implementation/README.md)
- [Packaging and remaining work](docs/implementation/distribution.md)
