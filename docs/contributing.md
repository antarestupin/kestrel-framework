# Contributing and framework development

[Documentation home](README.md) · [Install Kestrel](usage/installation.md) · [Distribution internals](implementation/distribution.md)

External contributions, including pull requests, are not accepted at this stage. This page documents the maintainer workflow and how to explore or modify Kestrel locally. No support or response times are guaranteed. A public contribution process remains deferred.

For application development with the published packages, start with the [npm installation and npx creation guide](usage/installation.md).

## Set up a checkout

Use Node.js 24.11 or later within Node.js 24, npm 11.9.0 for release validation, Git, and Docker Compose. Clone the framework repository:

```sh
git clone https://github.com/antarestupin/kestrel-framework.git
cd kestrel-framework
```

## Develop and test

GitHub Actions runs `.github/workflows/validate.yml` on pushes, pull requests, merge groups, and manual dispatch. Configure the stable `release-validation` job as a required check in the repository ruleset. Workflow files cannot enforce branch protection by themselves. See [release validation](implementation/distribution.md#release-validation) for the candidate and security contracts.

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

At the repository root, `npm run test` and `npm run test:ai` run framework and playground unit/integration tests, excluding the slower application-generator scenarios; `test:ai` uses compact output. Use `npm run test:unit` for unit tests without Docker, `npm run test:integration` for database adapters, `npm run test:generator` for the creator without Docker, or `npm run test:all` for all three groups. Run the generator group whenever changing the creator or its template. The devcontainer reuses the repository service definitions.

## Integration-test infrastructure

Run `npm run infra:up` and `npm run infra:prepare` in the framework repository. PostgreSQL initialization creates `kestrel_test` without resetting existing data. The Compose service separately creates `kestrel_playground`. Framework suites own and clean up their test tables or schemas; Redis test contexts use logical database 2 and unique key prefixes, and never flush the shared database.

Default ports are 55432 for PostgreSQL and 56379 for Redis. Override `KESTREL_POSTGRES_PORT` and `KESTREL_REDIS_PORT` for host testing. Test helpers also accept `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`, `KESTREL_TEST_DATABASE`, and `KESTREL_TEST_REDIS_URL`. Managed database names must be `kestrel_test` or `kestrel_test_<suffix>`. The devcontainer uses service hostnames and internal ports. CI runs the same provisioner and required integration suites; connection failures fail those suites.

Stop services with `npm run infra:down`. Tests clean up their own resources; there is intentionally no routine command deleting the shared PostgreSQL volume. A deliberate full infrastructure reset removes playground data as well and is outside normal test preparation.

## Try unpublished changes in an application

All npm workspaces live under `src/`: framework and starter packages in `src/packages/`, and the playground and documentation website in `src/apps/`. Run workspace commands from the repository root; shared guides, infrastructure, and verification scripts remain in `docs/`, `infrastructure/`, and `scripts/`.

```sh
npm run pack:local
node src/packages/create-kestrel/bin/create.mjs /tmp/my-web-app --framework-archive artifacts/kestreljs-framework-0.1.0-alpha.0.tgz
cd /tmp/my-web-app
npm install
npm run build:ai
npm run test:ai
```

Back in the framework repository root, run `npm run verify:archive` after packing both archives. This validates independent consumers, package exports, declarations, the CLI, Atlas/Studio assets, and compiled production deployments. It requires registry access for security checks and PostgreSQL permissions to create and drop uniquely named temporary databases. It never opens an HTTP listener. `pack:local` archives are development artifacts; they are not validated release candidates.

By default, the creator generates an exact npm dependency on the compatible framework version. With `--framework-archive`, it copies the archive into the generated application's `vendor` directory instead. It never installs dependencies or contacts a registry itself. `src/packages/create-kestrel/template` is the canonical template; `src/apps/playground` follows its rendered `kestrel-playground` identity, and `npm run check:playground` detects drift. The playground uses the repository infrastructure on the same ports as the standalone starter; use `npm run dev:database --workspace=@kestrel/playground` for its Drizzle Studio instead of starting the playground’s standalone Compose stack. To develop the playground, run `npm run dev --workspace=@kestrel/playground`; its database migrations run through `npm run db:migrate --workspace=@kestrel/playground`.

The archive command above uses the current `0.1.0-alpha.0` filename; after a version change, use the filename printed by `npm run pack:local`. Choose a missing or empty destination outside the framework checkout. To test only the generator against the published framework, run `node src/packages/create-kestrel/bin/create.mjs <app-name>` without an archive override.

To install an archive into an existing consumer, run `npm install /absolute/path/to/kestreljs-framework-0.1.0-alpha.0.tgz` from that application's directory. Rebuild and repack after framework changes, then update the consumer installation. The generated application's commands run independently of the framework repository.

## Maintain the documentation

The canonical guides live in `docs/`; the Docusaurus application lives in `src/apps/docs`. Keep usage and implementation references aligned when changing APIs. Add new pages to `src/apps/docs/sidebars.js`. Run `npm run docs:build` to check links and build the search index; `npm run docs:dev` and `npm run docs:preview` are available for manual browsing. See the [website maintenance guide](https://github.com/antarestupin/kestrel-framework/blob/main/src/apps/docs/README.md).

### Focus code examples with hidden lines

Revealed lines briefly highlight with the theme's primary color, fading out over two seconds to help readers locate the additions. With reduced motion enabled, the highlight stays fixed for two seconds and then disappears.

Surround supporting imports or setup with `hide-start` and `hide-end` comments, each on its own line. Keep the concept being explained visible. The [action example](usage/actions.md#define-and-run-an-action) demonstrates this behavior.

````md
```ts
// hide-start
import { defineAction } from "@kestreljs/framework/actions";
// hide-end

const greet = defineAction({
  name: "greeting.greet",
  handler: () => "Hello!",
});
```
````

On the website, **Show N hidden lines** reveals every marked section in that block; **Hide extra lines** folds them again. **Copy** always copies the complete example without magic comments, including folded lines. Line numbers refer to the complete example. The full code remains visible on GitHub, without JavaScript, and when printing.

Always specify a language on the code fence and use its comment syntax: `// hide-start` / `// hide-end` for TypeScript or JavaScript, `# hide-start` / `# hide-end` for Bash, and `-- hide-start` / `-- hide-end` for SQL. Sections must be paired and must not nest. When the block starts or ends with a hidden section, exposed blank separators at that boundary fold automatically and count toward the button's line total. They return when expanded and remain in copied code. Elsewhere, include adjacent blank lines inside the section if they should also disappear.

To combine folding and highlighting, use `highlight-next-line` or `highlight-start` / `highlight-end` comments. Do not add numeric highlight ranges such as `{2,4-6}` to a fence that uses magic comments: Docusaurus gives those ranges precedence and skips comment parsing. Numeric ranges still work normally on blocks without magic comments.

See [documentation website internals](implementation/documentation.md) for the rendering design and maintenance checks.

## Validate and publish a release

Publication requires explicit owner approval. Validation never publishes to npm.

From a checkout with dependencies installed and test infrastructure prepared, run:

```sh
# Build once, validate, and retain archives plus evidence in a new directory.
npm run release:validate

# Switch to the minimum Node runtime, reinstall the workspace lock, and reuse the same archives.
nvm use 24.11.0
npm install --global npm@11.9.0 --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund
npm run release:verify
```

Start validation on a recent Node 24 version other than 24.11.0 with npm 11.9.0 at both checkpoints. CI performs both runtime checkpoints automatically, also running source tests on the minimum runtime. `release:validate -- artifacts/candidate-2` selects a different output directory; `release:verify -- artifacts/candidate-2` verifies it. Existing directories are never overwritten by validation. A failed run remains available for diagnosis; use a new directory after fixing the problem. Tests assume the normal framework PostgreSQL/Redis infrastructure is available.

`candidate.json` records the source commit and dirty state, a digest of source inputs, tool versions, archive hashes, runtime verification results, and report hashes. A local dirty checkout may be validated for review; publication requires a candidate built from a clean commit and verified on both Node checkpoints. Download the complete CI candidate artifact into `artifacts/candidate` before publishing; preserve its directory structure. Check the successful `release-validation` result and the source commit before authorizing publication. Local checksums detect replacement, but do not authenticate a candidate received from an untrusted source.

| Root command | Purpose |
| --- | --- |
| `npm run pack:dry-run` | Build and inspect both npm packages without publishing. |
| `npm run release:validate` | Run all gates, pack once, verify consumers, and retain the candidate. |
| `npm run release:verify` | Verify the candidate on the current Node 24 runtime without rebuilding. |
| `npm run check:security` | Audit the workspace using the versioned security policy. |
| `npm run publish:kestrel` | Publish the candidate framework archive with the `next` tag. |
| `npm run publish:create-kestrel` | Publish the candidate creator archive with the `next` tag. |
| `npm run publish:next` | Publish the candidate framework, then creator; stop on failure. |

Publishing verifies artifact and report hashes, requires both runtime checkpoints, rejects expired security exceptions, and rejects evidence older than seven days. It passes the validated tarball directly to npm with lifecycle scripts disabled: no rebuild or repack occurs. For another candidate path, use `node scripts/release.mjs publish <directory> [all|framework|creator]` after approval. These commands perform real registry writes and require npm authentication and publishing rights. Published versions cannot be reused; if only creator publication fails, retry only the creator. Keep both package versions and the template/playground dependency aligned when changing release versions. Automatic publication, signed provenance, and a stable release policy remain deferred.
