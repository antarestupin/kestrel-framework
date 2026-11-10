# Mutation testing for framework contributors

[Contributor guide](../contributing.md) · [Implementation reference](../implementation/testing.md#framework-mutation-testing) · [Coverage inventory](../implementation/mutation_testing_inventory.md)

These commands assess Kestrel itself from a framework checkout. They are maintainer and contributor workflows; application testing recipes remain in the [application testing guide](../usage/testing.md).

<a id="run-the-mutation-testing-pilot"></a>

## Run framework mutation testing

Use the [coverage inventory](../implementation/mutation_testing_inventory.md) to select and track framework lots. `npm run check:mutation-inventory` verifies that every eligible source belongs to a recorded component; its success does not certify mutation coverage.

For routine feedback, use the fast profile. It skips pure static mutants and evaluates hybrid mutants only during tests. This reduces assessment coverage; its score is not comparable to the complete profile. It remains a framework-wide run and is not guaranteed to finish quickly.

```sh
npm run test:mutation:fast
npm run test:mutation:fast -- --incremental
# Keep static mutants and assess one existing framework component, including its adapters.
npm run test:mutation:component -- throttling
npm run test:mutation:component -- di --incremental
# Measure nine selected import-time declarations, stopping mutation work after ten minutes.
npm run test:mutation:static-sample -- --incremental --force
# Assess application stop/disposal/error collection with the same ten-minute budget.
npm run test:mutation:shutdown -- --incremental --force
# Assess account/session management, including all manager validation and renewal helpers.
npm run test:mutation:authentication-sessions
```

Component names are top-level directories under `src/packages/kestrel/src`; invalid names fail before provisioning databases. Dependent tests from other components remain eligible through Vitest's import graph. All named profiles have an automatic ten-minute budget per execution, including their initial instrumented tests. The explicit full/custom `test:mutation` command retains its existing unbounded behavior. The shutdown scope includes `App.stop`, disposal and shutdown error collection. The authentication-sessions scope selects the entire `authentication/manager.ts` file, including claims, token and expiration helpers. Both retain static and hybrid mutants and all dependent framework suites. At the deadline the wrapper requests a checkpoint, forcibly stops a stalled Stryker process group after five more seconds, and cleans owned databases. Cleanup can extend beyond the mutation budget. A budget stop exits nonzero with partial results; it does not produce a completed assessment.

Reports and incremental caches are separate: `artifacts/mutation/fast/`, `artifacts/mutation/component-<name>/`, `artifacts/mutation/static-sample/`, `artifacts/mutation/shutdown/` and `artifacts/mutation/authentication-sessions/`. The existing full command and its original reports remain unchanged. Use `--incremental --force` after configuration, infrastructure or dependency changes. The static sample also records Stryker events under its `events/` directory for examining baseline timing and individual outcomes. See the [static sample findings](../implementation/mutation_testing_framework.md#bounded-static-sample).

Focused behavioral profiles retain static mutants, use separate report/cache directories named after the profile, and share the ten-minute budget:

| Command | Mutated scope |
| --- | --- |
| `npm run test:mutation:authorization-decisions` | Entire authorization manager, including `allOf`/`anyOf` evaluation |
| `npm run test:mutation:password-verification` | Entire Argon2id hasher, including verification limits and pepper propagation |
| `npm run test:mutation:postgres-ownership` | Workflow PostgreSQL `retryTask` and scheduled-task PostgreSQL `extendLease` |
| `npm run test:mutation:throttling-inspection` | Leased throttling `reconcile` and `inspectMany` |
| `npm run test:mutation:lock-renewal` | Lock-manager `extendMany` and extension-batch validation |

These are selected sublots, not complete parent-component assessments. Range profiles resolve method/function anchors from the current source and fail if a boundary disappears. Preserve the previous report before changing tests; run fresh references for before/after comparisons. See the [security and coordination assessment](../implementation/mutation_testing_framework.md#security-and-coordination-follow-up).

From the repository root, prepare the dedicated PostgreSQL and Redis test infrastructure, then validate the instrumented test run before starting a complete mutation assessment:

```sh
npm run infra:up
npm run infra:prepare
npm run test:mutation:infrastructure
npm run test:mutation:dry-run
npm run test:mutation
```

Stryker mutates TypeScript and TSX runtime code throughout `src/packages/kestrel/src`, including adapters, browser clients, schemas and configuration modules. It excludes tests, declaration files, the repository-only PostgreSQL/Redis test helpers and shared worker conformance test assertions from mutation. The public `testing/http_access.ts` module remains in scope. All framework test files are eligible, including integration tests; application, documentation and generator suites remain outside this command. One non-isolated Vitest project uses the forks pool and snapshots per-file coverage metadata to retain module caching without unbounded metadata accumulation. Normal `npm run test:ai` continues to check full `--no-isolate` compatibility; tests must restore global state and close owned resources.

The npm wrapper gives each Stryker worker a separate temporary PostgreSQL database and cleans only databases recorded for its own run after the processes stop. The configured test role needs database creation/deletion privileges on the dedicated test PostgreSQL service. Connections are guarded against mutated configuration falling back to another destination. Redis tests retain their independent UUID key prefixes on database 2. Always use the npm commands for provisioning and cleanup. `test:mutation:infrastructure` checks routing, lifecycle ownership and the coverage optimization without connecting to PostgreSQL or Redis. Run it after upgrading Stryker or Vitest. A cleanup error reports a retained ownership manifest for recovery; never replace this with a broad prefix-based database deletion.

The dry-run command instruments the complete source scope and executes the unmodified tests without activating individual mutations. It checks that the selected test setup works but does not produce a complete mutation score. For the complete source scope, an absolute CLI entrypoint rerun trigger preserves all 1,633 baseline tests, including subprocess checks whose dependencies are opaque to the import graph. Static mutants then use Vitest's related-suite selection, and runtime mutants additionally use per-test coverage selection. Targeted scopes can select fewer dependent suites and omit graph-opaque subprocess tests; they do not replace a complete assessment. PostgreSQL provisioning applies even to targeted runs; Redis is needed when its integration suites are selected. Missing infrastructure fails rather than silently skipping those suites. See the [infrastructure helper reference](../implementation/testing.md#public-api) for dedicated database connection settings and cleanup.

For local investigation, target a component or file and let Vitest select its dependent framework suites:

```sh
npm run test:mutation -- --mutate src/packages/kestrel/src/utils/cursor_codec.ts
# Reuse unchanged mutation results while iterating locally.
npm run test:mutation -- --incremental
# Refresh the cache after dependencies, configuration or non-mutated helpers change.
npm run test:mutation -- --incremental --force
```

Open `artifacts/mutation/mutation.html` to inspect mutations and their covering tests. The machine-readable report is `artifacts/mutation/mutation.json`. Reports, the incremental cache and Stryker's temporary sandbox are ignored by Git. Targeted fresh runs overwrite the report with the selected scope, so retain a copy before comparing different scopes. A surviving mutant means the selected runtime tests did not detect that change; it does not automatically mean the mutation changes observable behavior.

The default command performs a fresh run. Its score is informational, with no minimum score gate (`thresholds.break: null`); setup and initial test failures still fail the command. Full-framework mutation runs can take substantially longer than the original pilot; use targeted or incremental assessments for local feedback while retaining fresh complete assessments as the reference. The [framework assessment](../implementation/mutation_testing_framework.md) records current findings and priorities. The [pilot analysis](../implementation/mutation_testing_pilot.md) is historical and does not describe the current framework-wide scope or an active score threshold. See the [implementation notes](../implementation/testing.md#framework-mutation-testing) for scope and deferred work.

