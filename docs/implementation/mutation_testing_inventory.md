# Framework mutation coverage inventory

[Testing reference](./testing.md#framework-mutation-testing) · [Running assessments](../contributing/mutation-testing.md#run-framework-mutation-testing) · [Results and classifications](./mutation_testing_framework.md) · [Machine-readable inventory](./mutation_testing_inventory.json)

Updated November 11, 2026. This is an inventory of mutation assessment progress, not line coverage, a global mutation score or a claim that tests are absent. The 35 primary lots partition all 631 TS/TSX candidate sources currently selected by the full Stryker configuration. This includes type-only and re-export files that may generate no mutants. The empty `ui` directory is retained explicitly; it may be absent in a fresh Git checkout.

## Scope and states

Each primary lot owns one top-level component directory and every nested adapter. They are tracking scopes, not a promise that a component-wide run fits ten minutes. Split an oversized component into named file/range sublots before treating it as complete; record the exact union and verify that it covers the parent without gaps or overlap. Selected samples and method ranges below are evidence inside parent lots, not additional primary lots to count twice.

- **Not assessed:** no dedicated complete component reference. Historical partial monolithic observations may exist.
- **Partial / selected evidence:** one or more selected slices have results; the full component is not established.
- **Assessment complete; review pending:** the selected full component assessment finished, but remaining errors/survivors have not been reviewed or material follow-up remains outstanding.
- **Reviewed:** the full declared scope has results, material survivors and uncovered paths have classifications, and limitations are documented. The current actions component has this state, with its diagnostic/metadata limitations recorded.
- **No candidate sources:** no eligible runtime-source candidates exist in this checkout. This is not a 100% mutation score.

Source counts do not measure executable lines, mutant volume or test strength. A `NoCoverage` observation is a test/instrumentation finding, not a completed behavior review. Fast-mode results never establish a full-mode reference. Mode, date and source/test/configuration revisions must remain attached to future evidence.

## Primary lots

| Lot | Candidate files | Assessment state | Next focus / subdivision | Evidence |
| --- | ---: | --- | --- | --- |
| `actions` | 9 | Reviewed | All nine current source candidates assessed; 12 diagnostic/optional-metadata residuals classified; re-review after contract changes | `actions-crud-pagination`, `actions-component` |
| `app` | 11 | Partial / selected evidence | Shutdown, diagnostic budgets/destinations and CLI/worker identity wiring reviewed; startup, ownership and other catalog paths pending | `app-shutdown`, `execution-diagnostics`, `catalog-identities` |
| `atlas` | 51 | Partial / selected evidence | Portable collection URL helper reviewed; other client/server, routing, rendering and adapter scopes pending | `atlas-collection-query` |
| `authentication` | 44 | Partial / selected evidence | Account/session manager and Argon2id hasher reviewed with documented limits; adapters, HTTP and other authentication sources pending | `configuration-sample`, `authentication-sessions`, `password-verification` |
| `authorization` | 23 | Partial / selected evidence | Decision manager reviewed; requirement builders, scoped stores and other authorization sources pending | `authorization-decisions` |
| `background` | 4 | Assessment complete; review pending | All four candidate files assessed; synchronous stop-drain bug fixed; controlled steady-state completion assertions and residual policy follow-up pending | `component-background` |
| `cache` | 24 | Partial / selected evidence | Memory/PostgreSQL pruning reviewed; other adapter methods, Redis and broader concurrency contracts pending | `cache-pruning` |
| `cli` | 8 | Not assessed | Parsing, dispatch and exit/signals; subprocess observation limit | — |
| `client` | 10 | Not assessed | Client generation and development/build adapters | — |
| `concurrency` | 4 | Not assessed | Queue, batch and cancellation contracts | — |
| `configuration` | 1 | Not assessed | Parsing and composition contracts | — |
| `controllers` | 2 | Not assessed | Contract/type exports; establish whether runtime mutations exist | — |
| `database` | 8 | Not assessed | Seeder and legacy/public database contracts | — |
| `db` | 33 | Partial / selected evidence | Provider, pools, repositories, history and counters; configuration sample assessed | `configuration-sample` |
| `definitions` | 5 | Not assessed | Definition validation and composition | — |
| `di` | 5 | Partial / selected evidence | Container/scopes; historical adapter-lifecycle pilot | `adapter-circuit-pilot` |
| `email` | 34 | Not assessed | Composition, rendering, transport failures and adapter ownership | — |
| `errors` | 4 | Not assessed | Public errors and error handling | — |
| `events` | 4 | Not assessed | Dispatch, asynchronous failures, scopes and close semantics | — |
| `http` | 28 | Not assessed | Routing, validation, access and lifecycle through injection | — |
| `lock` | 22 | Partial / selected evidence | Batch renewal and extension validation reviewed with handle-composition limit; acquisition, handle and adapter sources pending | `lock-renewal` |
| `log` | 13 | Not assessed | Redaction, formatting, filtering and transport ownership | — |
| `middleware` | 2 | Not assessed | Composition and error propagation | — |
| `observability` | 15 | Not assessed | Context, buffering, redaction and flush/disposal | — |
| `outbound_http` | 17 | Partial / selected evidence | Entire deadline/body/retry files assessed; remaining client/middleware/provider files and resource/interleaving residuals pending | `outbound-resilience` |
| `scheduled_tasks` | 19 | Assessment complete; review pending | All 19 candidate files assessed. Runtime deadline detections converted to direct test failures. Remaining lifecycle and adapter gaps in review. | `scheduled-runtime-timeout-followup`, `postgres-ownership`, `scheduled-runtime`, `scheduled-adapters`, `scheduled-contracts` |
| `scheduling` | 4 | Not assessed | Clock, scheduling and cancellation primitives | — |
| `studio` | 95 | Not assessed | Server/extensions, client state, routing and rendering | — |
| `testing` | 1 | Assessment complete; review pending | Public HTTP policy helper; PostgreSQL/Redis fixtures excluded | `testing-component` |
| `throttling` | 34 | Partial / selected evidence | Leased inspection/reconciliation reviewed; admission, other lease methods and adapters pending | `configuration-sample`, `adapter-circuit-pilot`, `throttling-inspection` |
| `tokens` | 31 | Not assessed | Issuance, lookup, expiry, revocation and adapter consistency | — |
| `ui` | 0 | No candidate sources | Empty source directory in this checkout; retain explicit inventory entry | — |
| `utils` | 5 | Not assessed | Codecs, identifiers, catalog and boundary validation | — |
| `workers` | 23 | Assessment complete; review pending | Scheduler admission, ownership and delivery assessed alongside publication, adapters and contracts. Remaining saturation, batching and failure paths in review. | `workers-scheduler`, `workers-delivery-ownership-refresh`, `workers-publication`, `workers-delivery`, `workers-adapters`, `workers-contracts` |
| `workflows` | 38 | Partial / selected evidence | Retry identity and key contention tested with separate PostgreSQL sessions. Other concurrency cases, runtime, scheduler and adapter operations pending. | `workflow-postgres-retry-races`, `postgres-ownership`, `workflow-task-ownership`, `workflow-execution-retry`, `workflow-terminal-control` |

The current total is 18 not-assessed lots, 11 partially assessed lots, 1 reviewed lot, 4 completed assessments awaiting review or follow-up, and 1 lot without candidate sources. These are manual assessment states.

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

The four survivors are equivalent under current snapshot, Zod and return-value invariants. Two decoder-catch mutants remain uncovered for ordinary primitive-string inputs; one would change exceptional decoder failure behavior and is not equivalent. Raw score remains 95.89%; no exclusions or gate. Adapters, mechanisms, proof construction, HTTP and the remaining authentication sources are outside this mutation scope, so the parent stays partial.

### adapter-circuit-pilot

2026-11-09; components: `di`, `throttling`. Scope: Historical adapter lifecycle and circuit ranges. Assessment: **historical**; review: **historical**.

Recorded outcomes: 326 Killed, 34 Survived; elapsed 55 seconds. Local report: `artifacts/mutation/before-framework-scope.json`. [Analysis](mutation_testing_pilot.md).

Older selected suites and source revision; not a current full-component reference.

### testing-component

2026-11-10; components: `testing`. Scope: All eligible testing component source (HTTP access helper). Assessment: **complete**; review: **pending**.

Recorded outcomes: 1 RuntimeError; elapsed 6 seconds. Local report: `artifacts/mutation/component-testing/mutation.json`. [Analysis](mutation_testing_inventory.md).

Initialization error has not been classified; completion does not mean validated behavior.

## Security and coordination selected-lot evidence

All five profiles below completed fresh before/after assessments on November 10, 2026, retaining static mutants and enforcing a ten-minute budget per execution. Production sources and all 402 selected mutation fingerprints are unchanged between references and final runs. Every previous kill is preserved. Assessment and residual review are complete **with the stated limitations**; no parent component is promoted to reviewed.

| Evidence | Scope | Final Killed / Survived / NoCoverage | Seconds | Review limit |
| --- | --- | --- | ---: | --- |
| `authorization-decisions` | Entire authorization manager | 33 / 0 / 0 | 11 | Other authorization sources pending |
| `password-verification` | Entire Argon2id hasher | 210 / 20 / 1 | 36 | Native errors covered; bounded-work distinctions and four unrelated progress-timeout kills remain |
| `postgres-ownership` | Workflow `retryTask`, scheduled-task `extendLease` | 14 / 0 / 0 | 7 | Direct predicate tests supplement SQL AST mutation; other adapter methods pending |
| `throttling-inspection` | Leased `reconcile`, `inspectMany` | 46 / 1 / 0 | 7 | Equivalent preallocation for dense batches; rest of adapter pending |
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

Fresh static-inclusive before/after assessments cover scheduled tasks, workers, workflow ownership/operator control, outbound resilience and the adjacent background host. All runs completed inside their ten-minute budgets. The three scheduled profiles partition all 19 current candidate files; material follow-up remains, so the parent is not marked reviewed. Worker/workflow/outbound parents retain partial states for their explicit range/file gaps. Counts include distinct raw outcomes; assertion timeouts, Stryker execution guards and runtime-invalid declarations are not interchangeable with direct behavior assertions.

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

## Historical global campaign

The interrupted November 9 campaign has 18,525 recorded statuses out of 42,816 generated mutations. It is incomplete, uses older tests and does not establish any current complete component baseline. Keep `artifacts/mutation/checkpoint-stopped-by-user.json` as a historical observation. Do not merge its counters with selected slice reports or average component scores to produce a framework score.

## Updating the inventory

1. Choose a pending lot or a documented sublot. Run all related baseline tests, then a fresh complete mutation assessment with the ten-minute profile budget. Record partial outcomes if the budget expires.
2. Preserve the previous report before adding tests, then compare identical source/location/operator/replacement fingerprints. Record any production-source changes separately.
3. Add dated evidence with exact scope, mode, report path, result counts, duration, source/test/configuration revision and known observation limits. Reuse incremental results only when their inputs remain valid.
4. Review survivors, uncovered branches, errors, timeouts and guard-only detections separately. Keep unresolved findings visible.
5. Promote a parent to reviewed only after its full scope has a valid assessment and all material findings are classified. A successful dry-run, source count, sampled 100% score or exited process is insufficient.
6. Update the JSON source counts and this table when the scope changes. Run `npm run check:mutation-inventory` to detect new/missing component lots, count drift, duplicate component scopes or broken evidence references.

The audit command reads the actual Stryker inclusion/exclusion patterns and source tree; it never starts tests, provisions databases or changes assessment states. A green audit certifies inventory alignment only. Schema/type contracts with no generated mutations, browser interactions, subprocess coverage and embedded SQL/Lua semantics still require explicit review. Extending the checker to validate arbitrary file/range sublot partitions and automating report ingestion remain deferred; the current automated partition check covers primary component lots only.
