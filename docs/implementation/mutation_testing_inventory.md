# Framework mutation coverage inventory

[Testing reference](./testing.md#framework-mutation-testing) · [Running assessments](../contributing/mutation-testing.md#run-framework-mutation-testing) · [Results and classifications](./mutation_testing_framework.md) · [Machine-readable inventory](./mutation_testing_inventory.json)

Updated November 12, 2026. The 35 primary lots partition all 639 TS/TSX candidate sources currently selected by the full Stryker configuration. The inventory tracks mutation assessment progress. Source candidates include type-only and re-export files that may generate no mutants. The empty `ui` directory is retained explicitly and may be absent in a fresh Git checkout.

## Scope and states

Each primary lot owns one top-level component directory and every nested adapter. They are tracking scopes, not a promise that a component-wide run fits ten minutes. Split an oversized component into named file/range sublots before treating it as complete; record the exact union and verify that it covers the parent without gaps or overlap. Selected samples and method ranges below are evidence inside parent lots, not additional primary lots to count twice.

- **Not assessed:** no dedicated complete component reference. Historical partial monolithic observations may exist.
- **Partial / selected evidence:** one or more selected slices have results; the full component is not established.
- **Assessment complete; review pending:** the selected full component assessment finished, but remaining errors/survivors have not been reviewed or material follow-up remains outstanding.
- **Reviewed:** the full declared scope has results, material survivors and uncovered paths have classifications, and limitations are documented.
- **No candidate sources:** no eligible runtime-source candidates exist in this checkout. This is not a 100% mutation score.

Source counts do not measure executable lines, mutant volume or test strength. A `NoCoverage` observation is a test/instrumentation finding, not a completed behavior review. Fast-mode results never establish a full-mode reference. Mode, date and source/test/configuration revisions must remain attached to future evidence.

## Primary lots

| Lot | Candidate files | Assessment state | Next focus / subdivision | Evidence |
| --- | ---: | --- | --- | --- |
| `actions` | 9 | Reviewed | All nine current source candidates assessed; 12 diagnostic/optional-metadata residuals classified; re-review after contract changes | `actions-crud-pagination`, `actions-component` |
| `app` | 11 | Reviewed | Composition, startup, scope teardown, transport draining, catalog and diagnostic contracts reviewed | [Lifecycle review](mutation_testing_lifecycle_boundaries.md#application) |
| `atlas` | 53 | Partial / selected evidence | Portable collection URL helper reviewed; other client/server, routing, rendering and adapter scopes pending | `atlas-collection-query` |
| `authentication` | 44 | Assessment complete; review pending | Review remaining survivors, including production PostgreSQL provider and migration wiring | [Coverage reassessment](mutation_testing_coverage_reassessment.md#authentication) · [Follow-up](mutation_testing_gap_followup.md#authentication) |
| `authorization` | 23 | Reviewed | Requirement evaluation, scoped composition, denial semantics and role stores reviewed | [Boundary review](mutation_testing_http_boundaries.md#authorization) |
| `background` | 4 | Reviewed | Selection, startup and steady-state polling, rollback and transport drain reviewed | [Lifecycle review](mutation_testing_lifecycle_boundaries.md#background-workloads) |
| `cache` | 24 | Reviewed | Capacity, pruning, coordination, adapter ownership and all storage contracts reviewed | [Storage review](mutation_testing_storage_boundaries.md#cache) |
| `cli` | 8 | Not assessed | Parsing, dispatch and exit/signals; subprocess observation limit | — |
| `client` | 10 | Not assessed | Client generation and development/build adapters | — |
| `concurrency` | 4 | Reviewed | Deferred admission, batch timing and outcome ownership, and generator protocol reviewed | [Lifecycle review](mutation_testing_lifecycle_boundaries.md#concurrency) |
| `configuration` | 1 | Reviewed | Environment resolution, override precedence, supported paths and diagnostics reviewed | [Lifecycle review](mutation_testing_lifecycle_boundaries.md#configuration) |
| `controllers` | 2 | Not assessed | Contract/type exports; establish whether runtime mutations exist | — |
| `database` | 8 | Reviewed | Maintenance commands, caller-owned transactions and generated identity isolation reviewed | [Storage review](mutation_testing_storage_boundaries.md#maintenance-and-seeding) |
| `db` | 34 | Reviewed | Pool and query diagnostics, pagination, history, counters and schema contributions reviewed | [Storage review](mutation_testing_storage_boundaries.md#database-runtime-and-repositories) |
| `definitions` | 5 | Reviewed | Path and identity validation, immutable registration metadata and schema parsing reviewed | [Lifecycle review](mutation_testing_lifecycle_boundaries.md#definition-registries) |
| `di` | 5 | Reviewed | Adapter ownership, dependency resolution, graph validation and disposal reviewed | [Lifecycle review](mutation_testing_lifecycle_boundaries.md#dependency-injection) |
| `email` | 34 | Not assessed | Composition, rendering, transport failures and adapter ownership | — |
| `errors` | 5 | Reviewed | Transport representation lookup, opaque fallback and cyclic diagnostics reviewed | [Boundary review](mutation_testing_http_boundaries.md#errors-and-middleware) |
| `events` | 4 | Reviewed | Dispatch, one-time listener reservations, error propagation and scope teardown reviewed | [Lifecycle review](mutation_testing_lifecycle_boundaries.md#events) |
| `http` | 28 | Reviewed | Routing, access and lifecycle, Host admission, client transport and generation reviewed | [Boundary review](mutation_testing_http_boundaries.md#http) |
| `lock` | 22 | Reviewed | Acquisition, lease ownership, batch renewal and all adapter contracts reviewed | [Storage review](mutation_testing_storage_boundaries.md#lock) |
| `log` | 13 | Not assessed | Redaction, formatting, filtering and transport ownership | — |
| `middleware` | 2 | Reviewed | Entry, replay, dependency resolution and unwind failure behavior reviewed | [Boundary review](mutation_testing_http_boundaries.md#errors-and-middleware) |
| `observability` | 15 | Not assessed | Context, buffering, redaction and flush/disposal | — |
| `outbound_http` | 17 | Assessment complete; review pending | Review remaining survivors and define caller-cancellation circuit feedback | [Coverage reassessment](mutation_testing_coverage_reassessment.md#outbound-http) · [Follow-up](mutation_testing_gap_followup.md#outbound-http) |
| `scheduled_tasks` | 19 | Reviewed | Scheduler ownership and shutdown, adapter parity and operator contracts | [Component review](mutation_testing_scheduled_tasks.md#november-11-review) |
| `scheduling` | 4 | Reviewed | Timer limits, abort handling, lease extensions and polling budgets | [Component review](mutation_testing_scheduling_review.md) |
| `studio` | 99 | Not assessed | Server/extensions, client state, routing and rendering | — |
| `testing` | 1 | Assessment complete; review pending | Public HTTP policy helper; PostgreSQL/Redis fixtures excluded | `testing-component` |
| `throttling` | 34 | Assessment complete; review pending | Review residual queue and lease progress detections, storage wiring, and schema contracts | [Coverage reassessment](mutation_testing_coverage_reassessment.md#throttling) · [Follow-up](mutation_testing_gap_followup.md#throttling) |
| `tokens` | 31 | Assessment complete; review pending | Review remaining survivors and PostgreSQL provider wiring | [Coverage reassessment](mutation_testing_coverage_reassessment.md#tokens) · [Follow-up](mutation_testing_gap_followup.md#tokens) |
| `ui` | 0 | No candidate sources | Empty source directory in this checkout; retain explicit inventory entry | — |
| `utils` | 5 | Not assessed | Codecs, identifiers, catalog and boundary validation | — |
| `workers` | 23 | Reviewed | Scheduler admission and ownership, delivery, publication, adapters and contracts | [Component review](mutation_testing_workers_complete_review.md) |
| `workflows` | 38 | Reviewed | Runtime, replay, operator commands and adapter contracts | [Component review](mutation_testing_workflows_complete_review.md) |

The current total is 8 not-assessed lots, 1 partially assessed lot, 20 reviewed lots, 5 completed assessments awaiting review, and 1 lot without candidate sources. These are manual assessment states.

## Evidence ledger

Reports under `artifacts/` are ignored local artifacts and may be absent in a fresh clone. The linked analysis records are the durable explanation. Completed execution and completed review are separate fields in the JSON inventory.

### configuration-sample

2026-11-10; components: `authentication`, `db`, `throttling`. Scope: Nine selected import-time declarations, not complete configuration files. Assessment: **complete**; review: **complete**.

Recorded outcomes: 17 Killed, 0 Survived, 1 RuntimeError; elapsed 15 seconds. Local report: `artifacts/mutation/static-sample/mutation.json`. [Analysis](mutation_testing_framework.md#configuration-regression-tests-before-and-after).

One runtime-invalid discriminated union classified; no component-wide score.

### app-shutdown

2026-11-10; components: `app`. Scope: App.stop, dispose, finishAndDispose and runShutdownBoundary. Assessment: **complete**; review: **complete**.

Recorded outcomes: 114 Killed, 3 Survived, 0 NoCoverage; elapsed 58 seconds. Local report: `artifacts/mutation/shutdown/mutation.json`. [Analysis](mutation_testing_framework.md#shutdown-review-completed) · [Residual classification](mutation_testing_shutdown_classification.json).

Shutdown slice reviewed: the three surviving mutants are equivalent under the documented invariants. No uncovered mutation remains. `App.start` itself, `ApplicationShutdown`, process terminal policy and the rest of `app` remain outside this mutation scope; the parent lot stays partial. Re-review after lifecycle/coordinator changes.

### authentication-sessions

2026-11-10; components: `authentication`. Scope: Entire `authentication/manager.ts`, including private claims, token and renewal helpers. Assessment: **complete**; review: **complete with a documented input-domain limitation**.

Recorded outcomes: 140 Killed, 4 Survived, 2 NoCoverage, no timeout or error; elapsed 35 seconds. Local report: `artifacts/mutation/authentication-sessions/mutation.json`. [Analysis](mutation_testing_framework.md#authentication-account-and-session-review) · [Residual classification](mutation_testing_authentication_sessions_classification.json).

The four survivors are equivalent under the recorded snapshot, Zod and return-value invariants. Two decoder-catch mutants remain uncovered for ordinary primitive-string inputs. One changes exceptional decoder failure behavior. The raw score was 95.89%, with all outcomes included and no gate. The scope covered the manager only. The November 12 reassessment measures the full authentication component.

### adapter-circuit-pilot

2026-11-09; components: `di`, `throttling`. Scope: Historical adapter lifecycle and circuit ranges. Assessment: **historical**; review: **historical**.

Recorded outcomes: 326 Killed, 34 Survived; elapsed 55 seconds. Local report: `artifacts/mutation/before-framework-scope.json`. [Analysis](mutation_testing_pilot.md).

Older selected suites and source revision; not a current full-component reference.

### testing-component

2026-11-10; components: `testing`. Scope: All eligible testing component source (HTTP access helper). Assessment: **complete**; review: **pending**.

Recorded outcomes: 1 RuntimeError; elapsed 6 seconds. Local report: `artifacts/mutation/component-testing/mutation.json`. [Analysis](mutation_testing_inventory.md).

Initialization error has not been classified; completion does not mean validated behavior.

## Security and coordination selected-lot evidence

All five profiles below completed fresh before/after assessments on November 10, 2026, retaining static mutants and enforcing a ten-minute budget per execution. Production sources and all 402 selected mutation fingerprints are unchanged between references and final runs. Every previous kill is preserved. Assessment and residual review cover the selected scopes and stated limitations.

| Evidence | Scope | Final Killed / Survived / NoCoverage | Seconds | Review limit |
| --- | --- | --- | ---: | --- |
| `authorization-decisions` | Entire authorization manager | 33 / 0 / 0 | 11 | Other authorization sources pending |
| `password-verification` | Entire Argon2id hasher | 210 / 20 / 1 | 36 | Native errors covered; bounded-work distinctions and four unrelated progress-timeout kills remain |
| `postgres-ownership` | Workflow `retryTask`, scheduled-task `extendLease` | 14 / 0 / 0 | 7 | Direct predicate tests supplement SQL AST mutation; other adapter methods pending |
| `throttling-inspection` | Leased `reconcile`, `inspectMany` | 46 / 1 / 0 | 7 | Equivalent preallocation for dense batches. The rest of the adapter was outside this profile. |
| `lock-renewal` | Batch renewal and validation | 72 / 2 / 3 | 8 | Dormant custom-handle diagnostics; no final timeout-driven kills |

The Argon2id native-error follow-up adds three controlled callback-failure cases without production changes. Its pre-follow-up report is archived at `artifacts/mutation/password-verification-before-native-errors/mutation.json`. The same 231 fingerprints move one Survived and two NoCoverage mutations to direct assertion kills; all other statuses are unchanged. The current 21 residuals comprise ten equivalents, six bounded-work distinctions and five unconstrained literals. [Native-error analysis](mutation_testing_framework.md#argon2id-native-error-propagation).

Reports and reference archives use `artifacts/mutation/<evidence>/` and `artifacts/mutation/<evidence>-before-tests/`. [Before/after analysis](mutation_testing_framework.md#security-and-coordination-follow-up) · [Comparison and input hashes](mutation_testing_security_coordination_classification.json) · [Argon2id residuals](mutation_testing_password_verification_classification.json) · [Lock residuals](mutation_testing_lock_renewal_classification.json) · [PostgreSQL predicate analysis](mutation_testing_postgres_ownership.md).

## Actions and follow-up evidence

Fresh bounded assessments on November 10, 2026 completed the full actions component review and selected cache, app and Atlas slices. All retained static mutations and completed below the ten-minute per-execution budget. The CRUD/pagination slice overlaps the actions component; their counts must not be added together.

| Evidence | Final Killed / Survived / NoCoverage | Seconds | Extent / limits |
| --- | --- | ---: | --- |
| `actions-crud-pagination` | 168 / 8 / 0 | 70 | Three complete files; one demonstrated numbered-default bug fixed; diagnostic residuals |
| `actions-component` | 226 / 12 / 0 | 100 | All nine current source candidates; first reviewed primary component; diagnostic/optional metadata limits |
| `cache-pruning` | 51 / 7 / 0 | 13 | Memory/PostgreSQL prune and limit guards; work/failure-observation distinctions retained |
| `execution-diagnostics` | 38 / 1 / 0 | 21 | Exact UTF-8 budgets and destinations; diagnostic text residual |
| `catalog-identities` | 4 / 2 / 0 | 13 | CLI/worker identity wiring; diagnostic label residuals |
| `atlas-collection-query` | 156 / 6 / 0 | 18 | Portable URL parsing/serialization helper; other Atlas scopes pending |

[Analysis and before/after comparisons](mutation_testing_actions_followup.md) · [Session inputs/report hashes](mutation_testing_actions_session.json). The session record links each exact residual classification. No final execution in these scopes relies on a Vitest timeout or records an executed mutant with zero completed tests. All profiles remain informational with no score gate. Component completion applies to the declared current runtime mutation scope, not every possible input or downstream dependency contract.

## November 10 asynchronous runtime evidence

Fresh static-inclusive before/after assessments covered scheduled tasks, workers, workflow ownership/operator control, outbound resilience and the adjacent background host on November 10. All runs completed inside their ten-minute budgets. The three scheduled profiles partitioned all 19 candidate files and left material follow-up for the next review. The worker, workflow and outbound profiles covered selected ranges and files at that revision. Counts distinguish raw outcomes for assertion deadlines, Stryker execution guards and runtime-invalid declarations.

| Evidence | Final Killed / Survived / NoCoverage | Timeout / RuntimeError | Seconds |
| --- | --- | --- | ---: |
| `scheduled-runtime` | 419 / 71 / 5 | 18 / 0 | 312 |
| `scheduled-adapters` | 586 / 51 / 8 | 0 / 25 | 180 |
| `scheduled-contracts` | 275 / 16 / 0 | 1 / 0 | 87 |
| `workers-publication` | 159 / 20 / 0 | 0 / 0 | 56 |
| `workers-delivery` | 271 / 35 / 2 | 5 / 0 | 79 |
| `workers-adapters` | 498 / 55 / 0 | 0 / 41 | 170 |
| `workers-contracts` | 317 / 27 / 0 | 0 / 0 | 97 |
| `workflow-task-ownership` | 71 / 4 / 0 | 0 / 0 | 19 |
| `workflow-execution-retry` | 121 / 13 / 2 | 0 / 0 | 37 |
| `workflow-terminal-control` | 282 / 31 / 1 | 6 / 0 | 75 |
| `outbound-resilience` | 313 / 33 / 1 | 1 / 0 | 154 |
| `component-background` | 134 / 10 / 0 | 1 / 0 | 54 |

[Analysis, demonstrated bugs and next priorities](./mutation_testing_async_runtime.md) · [Resolved scopes, source/test/report hashes and timeout evidence](./mutation_testing_async_runtime_session.json). Dedicated classification files are linked from the machine-readable ledger. Older PostgreSQL ownership evidence overlaps the new adapter selections; do not add those counters. No score gate or residual exclusion was introduced.

## November 11 scheduler and retry follow-up

The three requested profiles have fresh before and after reports. The paired worker ranges cover the scheduler file. Scheduled runtime and workflow retry retain the November 10 reports as historical evidence.

| Evidence | Final Killed / Survived / NoCoverage / Timeout | Final Vitest deadline kills | Seconds |
| --- | --- | ---: | ---: |
| `workers-scheduler` | 487 / 175 / 67 / 2 | 8 | 186 |
| `scheduled-runtime-timeout-followup` | 431 / 71 / 5 / 6 | 0 | 119 |
| `workflow-postgres-retry-races` | 129 / 10 / 4 / 0 | 0 | 38 |
| `workers-delivery-ownership-refresh` | 288 / 40 / 2 / 6 | 0 | 97 |

[Analysis and residual limits](./mutation_testing_scheduler_followup.md) · [Report hashes and comparisons](./mutation_testing_scheduler_followup.json)

## November 11 component reviews

The four reviews cover 84 candidate sources across 29 disjoint profiles. The latest report scopes were checked against the current source spans and every candidate belongs to exactly one selected profile. Earlier ownership, retry and publication reports remain applicable to unchanged selected spans. All new completed executions finished within the ten-minute budget.

| Component | Candidate files | Profiles | Killed / Survived / NoCoverage | Timeout / RuntimeError | Evidence |
| --- | ---: | ---: | --- | --- | --- |
| `scheduling` | 4 | 1 | 139 / 1 / 0 | 3 / 0 | [Review](mutation_testing_scheduling_review.md) |
| `scheduled_tasks` | 19 | 3 | 1372 / 57 / 9 | 6 / 25 | [Review](mutation_testing_scheduled_tasks.md#november-11-review) |
| `workers` | 23 | 5 | 1875 / 227 / 16 | 1 / 41 | [Review](mutation_testing_workers_complete_review.md) |
| `workflows` | 38 | 20 | 5760 / 1029 / 105 | 30 / 106 | [Review](mutation_testing_workflows_complete_review.md) |

These are raw Stryker outcomes. The linked reviews distinguish direct assertion failures, Vitest test deadlines, Stryker execution limits and static import errors. Scores remain informational.

## November 12 reassessment after branch coverage

The initial wave measured code and tests at `52ea51d3c8920ac303786133a72ac98acfa08de2`. All 22 named profiles completed with static and hybrid mutants retained. The longest took 3 minutes 56 seconds within the ten-minute budget. The [analysis](mutation_testing_coverage_reassessment.md) records the per-profile outcomes, historical comparisons and initial findings. The local archive is `artifacts/mutation/nov12-coverage-reassessment/`.

| Component | Candidate files | Profiles | Killed / Survived / NoCoverage | Timeout / RuntimeError | Review |
| --- | ---: | ---: | --- | --- | --- |
| `throttling` | 34 | 11 | 3633 / 764 / 29 | 25 / 37 | Pending |
| `authentication` | 44 | 5 | 1295 / 254 / 18 | 1 / 46 | Pending |
| `tokens` | 31 | 3 | 1044 / 212 / 24 | 0 / 17 | Pending |
| `outbound_http` | 17 | 3 | 956 / 166 / 6 | 1 / 0 | Pending |

## November 12 targeted follow-up

The follow-up reassessed 18 named profiles against their exact branch-coverage baseline fingerprints. The comparison pairs 7,221 mutants across identical production sources and Stryker settings. Each run retained static and hybrid mutants and used the ten-minute limit. The longest profile took 261 seconds. Authentication and throttling results cover the selected follow-up scopes. Tokens and outbound HTTP results cover all profiles in their component partitions.

| Component | Scope | Profiles | Matched mutants | Killed / Survived / NoCoverage (before → after) | Timeout / RuntimeError (before → after) |
| --- | --- | ---: | ---: | --- | --- |
| `authentication` | Selected | 3 | 1237 | 945 → 976 / 230 → 204 / 15 → 11 | 1 → 0 / 46 → 46 |
| `throttling` | Selected | 9 | 3558 | 2954 → 3020 / 553 → 491 / 24 → 24 | 25 → 23 / 2 → 0 |
| `tokens` | Complete | 3 | 1297 | 1044 → 1108 / 212 → 166 / 24 → 6 | 0 → 0 / 17 → 17 |
| `outbound_http` | Complete | 3 | 1129 | 956 → 973 / 166 → 149 / 6 → 6 | 1 → 1 / 0 → 0 |

The [follow-up analysis](mutation_testing_gap_followup.md) records the behavior tested, deadline detections, and remaining material limits. The local comparison and input manifest are under `artifacts/mutation/nov12-gap-followup/`. The component review states remain pending.

## November 12 HTTP and authorization boundary review

All seven profiles completed with static and hybrid mutants retained. The scope audit matches the entire mutation set in the 58 candidate sources. The [boundary review](mutation_testing_http_boundaries.md) describes the confirmed defects, remaining mutants, and how unchanged source spans were paired.

| Component | Matched mutants | Killed / Survived / NoCoverage | Timeout / RuntimeError | Stryker score |
| --- | ---: | --- | --- | --- |
| `http` | 1236 | 1062 / 254 / 9 → 1322 / 48 / 1 | 11 / 6 → 4 / 6 | 80.31% → 96.44% |
| `authorization` | 212 | 172 / 38 / 9 → 236 / 4 / 0 | 0 / 9 → 0 / 9 | 78.54% → 98.33% |
| `errors` | 87 | 95 / 11 / 0 → 121 / 3 / 0 | 3 / 0 → 3 / 0 | 89.91% → 97.64% |
| `middleware` | 18 | 18 / 0 / 0 → 18 / 0 / 0 | 0 / 0 → 0 / 0 | 100.00% → 100.00% |

Local reports, exact comparisons and input hashes are archived under `artifacts/mutation/nov12-http-boundaries/`.

## November 12 storage boundary review

All completed comparisons retain static and hybrid mutants. The disjoint profiles account for the full mutation set in 88 candidate sources. The [storage boundary review](mutation_testing_storage_boundaries.md) records the confirmed bugs, remaining mutations, and the execution budget for each profile.

| Component | Matched mutants | Killed / Survived / NoCoverage | Timeout / RuntimeError | Stryker score |
| --- | ---: | --- | --- | --- |
| `db` | 2380 | 1880 / 483 / 14 → 2299 / 188 / 9 | 17 / 132 → 12 / 127 | 79.24% → 92.15% |
| `lock` | 1144 | 974 / 158 / 22 → 1119 / 42 / 3 | 8 / 8 → 3 / 8 | 84.51% → 96.14% |
| `database` | 152 | 134 / 18 / 4 → 172 / 16 / 0 | 0 / 0 → 0 / 0 | 85.90% → 91.49% |
| `cache` | 848 | 724 / 118 / 12 → 817 / 31 / 1 | 2 / 10 → 2 / 10 | 84.81% → 96.24% |

Local reports, exact comparisons and input hashes are archived under `artifacts/mutation/nov12-storage-boundaries/`.

## November 12 lifecycle boundary review

All completed comparisons retain static and hybrid mutants. The disjoint profiles account for the full mutation set in 34 candidate sources. The [lifecycle boundary review](mutation_testing_lifecycle_boundaries.md) records the confirmed bugs, remaining mutations, and the execution budget for each profile.

| Component | Matched mutants | Killed / Survived / NoCoverage | Timeout / RuntimeError | Stryker score |
| --- | ---: | --- | --- | --- |
| `app` | 942 | 870 / 112 / 7 → 993 / 26 / 0 | 5 / 18 → 8 / 18 | 88.03% → 97.47% |
| `di` | 271 | 290 / 33 / 7 → 328 / 15 / 1 | 6 / 0 → 5 / 0 | 88.10% → 95.42% |
| `background` | 120 | 134 / 10 / 0 → 137 / 2 / 0 | 1 / 0 → 1 / 0 | 93.10% → 98.57% |
| `concurrency` | 345 | 333 / 43 / 0 → 379 / 19 / 0 | 17 / 0 → 17 / 0 | 89.06% → 95.42% |
| `events` | 137 | 154 / 47 / 1 → 203 / 4 / 0 | 5 / 4 → 6 / 4 | 76.81% → 98.12% |
| `configuration` | 447 | 368 / 79 / 2 → 451 / 10 / 1 | 1 / 3 → 1 / 3 | 82.00% → 97.62% |
| `definitions` | 64 | 71 / 10 / 0 → 86 / 4 / 0 | 0 / 0 → 0 / 0 | 87.65% → 95.56% |

Local reports, exact comparisons and input hashes are archived under `artifacts/mutation/nov12-lifecycle-boundaries/`.

## Historical global campaign

The interrupted November 9 campaign has 18,525 recorded statuses out of 42,816 generated mutations. It is incomplete, uses older tests and does not establish any current complete component baseline. Keep `artifacts/mutation/checkpoint-stopped-by-user.json` as a historical observation. Do not merge its counters with selected slice reports or average component scores to produce a framework score.

## Updating the inventory

1. Choose a pending lot or a documented sublot. Run all related baseline tests, then a fresh complete mutation assessment with the ten-minute profile budget. Record partial outcomes if the budget expires.
2. Preserve the previous report before adding tests, then compare identical source/location/operator/replacement fingerprints. Record any production-source changes separately.
3. Add dated evidence with exact scope, mode, report path, result counts, duration, source/test/configuration revision and known observation limits. Reuse incremental results only when their inputs remain valid.
4. Review survivors, uncovered branches, errors, timeouts and guard-only detections separately. Keep unresolved findings visible.
5. Promote a parent to reviewed only after its full scope has a valid assessment and all material findings are classified. A successful dry-run, source count, sampled 100% score or exited process is insufficient.
6. Update the JSON source counts and this table when the scope changes. Run `npm run check:mutation-inventory` to detect new/missing component lots, count drift, duplicate component scopes or broken evidence references.

The audit command reads the actual Stryker inclusion/exclusion patterns and source tree. It never starts tests, provisions databases or changes assessment states. A green audit certifies inventory alignment. The mutation infrastructure suite checks that the workflow sublots, worker scheduler ranges and November 12 reassessment profiles partition their candidate sources. Schema and type contracts with no generated mutations, browser interactions, subprocess coverage and embedded SQL or Lua semantics still require explicit review. Validating arbitrary sublot partitions and automating report ingestion remain deferred.
