# Kestrel

Kestrel is a modular application framework. This repository contains its libraries, tests, Studio, a web starter, and an independent playground.

## Project status

Kestrel is experimental and under active development. APIs and behavior may change without notice, and backward compatibility is not guaranteed. It is not ready for production use.

Kestrel packages are published on npm. This repository contains their source and the GitHub Pages documentation site. External contributions, including pull requests, are not accepted at this stage. No support or response times are guaranteed.

Kestrel is licensed under the [MIT License](LICENSE). The published packages are `@kestreljs/framework` and `@kestreljs/create-kestrel`. The workspace root, playground, documentation site, and generated applications remain private packages. Publication requires explicit owner approval.

## Install Kestrel

Use Node.js 24.11 or later within the Node.js 24 line. Install the published framework in an existing application:

```sh
npm install @kestreljs/framework
```

## Create an application

From the parent directory, generate a new application and install its dependencies:

```sh
npx @kestreljs/create-kestrel@latest my-app
cd my-app
npm install
```

The creator creates `my-app/` automatically; an existing destination must be empty. To start with the bundled services, use Docker Compose and run `npm run infra:up`, `npm run db:dev:migrate`, then `npm run dev` inside the application. See the [installation guide](docs/usage/installation.md) for cache options, configuration, and application commands.

## Contributing and framework development

Repository setup, framework tests, local archive consumption, and release commands are documented in the [contribution guide](docs/contributing.md). External contributions remain closed at this stage.

## Documentation

The Docusaurus website in `src/apps/docs` renders the guides below directly. Run `npm run docs:dev` for local authoring, or `npm run docs:build` followed by `npm run docs:preview` to include local search. See [website maintenance and GitHub Pages setup](src/apps/docs/README.md).

The Documentation workflow validates documentation changes in pull requests and deploys matching pushes to `main` to GitHub Pages. It can also be triggered manually from GitHub Actions on `main`.

- [Documentation home](docs/README.md)
- [Usage guides](docs/usage/README.md)
- [Implementation references](docs/implementation/README.md)
- [Contributing and framework development](docs/contributing.md)
- [Packaging and remaining work](docs/implementation/distribution.md)
