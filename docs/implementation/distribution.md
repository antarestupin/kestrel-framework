# Distribution and repository boundaries

[Implementation index](README.md) · [Installation](../usage/installation.md)

Status: local extraction implemented; publication disabled. All manifests retain `private: true` and `UNLICENSED`, and publish lifecycle guards reject accidental publication. No release workflow exists. Package names are provisional.

## Model and responsibilities

The npm workspace root owns contributor tooling, CI, PostgreSQL/Redis infrastructure, and validation of the web template. `src/packages/create-kestrel` owns the creator and its versioned web template. `src/packages/kestrel` owns framework code, library tests, the explicit public export map, the CLI, and Studio. The playground imports the built package and carries application configuration. Framework production code does not read application environment values. Infrastructure and test helpers may read their own connection settings.

The framework is one ESM package with declarations and source maps. Public subpaths cover supported library indexes, adapters, schemas, browser transport, and existing integration contracts. The browser transport is a separate module without server runtime imports. Node.js 24 is the current supported runtime. Studio is built into `assets/studio`; runtime lookup starts from the installed package rather than the consuming application's working directory. Its serialized Vite manifest uses relocatable package-relative output paths. The CLI resolves executable symlinks before detecting direct execution.

## Build and validation

Build the framework before workspace consumers. Tests remain beside their owning library or adapter. Vitest separates infrastructure-backed integration suites from unit suites; the package-owned template is excluded from discovery because its tests run through the playground and generated applications. The boundary checker verifies that framework relative imports stay within the package and rejects application-specific production references. It does not yet enforce the complete inter-library dependency graph.

The creator directly owns the versioned source in `src/packages/create-kestrel/template` and requires no template build or synchronization step; the playground is checked against that source, with only its package name changed. The template and playground keep SQL migrations, snapshots, and the journal in `src/server/core/db/migrations/`, beside the database schema and migration entry point; Drizzle generation and migration execution use that same directory. The creator refuses nonempty destinations and vendors a supplied local archive. Deployment schema exports are separate from disposable development tables. Shared local table filters stay aligned with the push-schema exports. The build copies SQL and migration metadata alongside compiled database tooling.

The template exposes one default application module to the generic Kestrel CLI. The executable root `do` resolves the installed package from the project directory, including hoisted workspace dependencies. Development, production, generation, and database scripts all dispatch through that CLI. The application factory keeps HTTP and PostgreSQL services lazy until a command needs them, while tests create and dispose independent instances. No separate server or HTTP client generation entry points are needed.

`HttpClientGenerationProvider` uses the shared application settings to generate contracts in `src/generated/publicClient/`; `src/client/api.ts` only configures the browser instance. Generated links to the server catalog are type-only. `vite.development.config.ts` owns the shared development graph, while `vite.config.ts` builds production assets.

The starter includes Node/editor/agent conventions, local environment defaults, a standalone devcontainer, shared Drizzle credentials, application and local Drizzle entry points, contribution-aware migration generation, and provider-owned database maintenance. Local reset boundaries and seed records belong to the application. The development push schema contains only `dev` objects, so it cannot reconcile migration-owned application tables. Add migration-owned utility exports and corresponding filters together if future local declarations require their schema. Optional storage declarations do not automatically enable their runtime providers.

Application-specific lockfiles are generated after the creator assigns the project name and vendors the selected archive. Dependency folders, build output, secrets, source-integration scripts for sibling repositories, and private product configuration are not template inputs. Native Windows CLI launchers and additional optional feature composition remain future work.

Local archive validation must exercise imports, TypeScript declarations, CLI loading, Studio HTML and assets, and browser bundling from an installation outside the monorepo. This catches dependencies and source files accidentally supplied by workspace links. CI validates builds and tests and produces local archives without publishing them.

## Remaining work and potential evolutions

- Select final package names, scope, license, and release compatibility policy before requesting explicit publication authorization.
- Resolve existing inter-library cycles before individual package publication, particularly definition utilities, application/observation event ownership, and maintenance scheduling integrations. Move shared contracts downward or inject composition dependencies; directory extraction alone does not establish independent libraries.
- Classify optional integrations and reduce eager adapter dependencies as separate packages become useful. The initial distribution retains the established dependency versions and standard adapters.
- Expand the playground beyond the minimal template with focused feature demonstrations.
- Compile documentation recipes in CI and complete an exhaustive public API review; historical specifications remain explicitly planned rather than distribution guarantees.
- Add finer-grained, data-preserving infrastructure reset commands only with clearly bounded ownership.

### CommonJS tooling on Node.js 24

Each JavaScript subpath has an `import` condition and a `default` fallback pointing to the same ESM module. Node.js 24 can synchronously require these modules; the fallback lets CommonJS configuration loaders such as Drizzle resolve them. This does not introduce a separate CommonJS build or duplicate runtime instances. Installed-package validation exercises both loaders and checks export identity.
