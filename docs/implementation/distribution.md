# Distribution and repository boundaries

[Implementation index](README.md) · [Installation](../usage/installation.md)

Status: local extraction implemented; publication disabled. All manifests retain `private: true` and `UNLICENSED`, and publish lifecycle guards reject accidental publication. No release workflow exists. Package names are provisional.

## Model and responsibilities

The npm workspace root owns contributor tooling, CI, PostgreSQL/Redis infrastructure, and the web template. `packages/kestrel` owns framework code, library tests, the explicit public export map, the CLI, and Studio. The playground imports the built package and carries application configuration. Framework production code does not read application environment values. Infrastructure and test helpers may read their own connection settings.

The framework is one ESM package with declarations and source maps. Public subpaths cover supported library indexes, adapters, schemas, browser transport, and existing integration contracts. The browser transport is a separate module without server runtime imports. Node.js 24 is the current supported runtime. Studio is built into `assets/studio`; runtime lookup starts from the installed package rather than the consuming application's working directory. Its serialized Vite manifest uses relocatable package-relative output paths. The CLI resolves executable symlinks before detecting direct execution.

## Build and validation

Build the framework before workspace consumers. Tests remain beside their owning library or adapter. Vitest separates infrastructure-backed integration suites from unit suites; the generated creator template is excluded from discovery. The boundary checker verifies that framework relative imports stay within the package and rejects application-specific production references. It does not yet enforce the complete inter-library dependency graph.

The creator is built from `templates/web`; the playground is checked against that source, with only its package name changed. The creator refuses nonempty destinations and vendors a supplied local archive. Database schema exports and local table filters must remain aligned wherever schema push is introduced; the current template uses migrations only.

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
