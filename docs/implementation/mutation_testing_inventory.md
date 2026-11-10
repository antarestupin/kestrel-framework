# Framework mutation coverage inventory

[Testing reference](./testing.md#framework-mutation-testing) · [Running assessments](../contributing/mutation-testing.md#run-framework-mutation-testing) · [Results and classifications](./mutation_testing_framework.md) · [Machine-readable inventory](./mutation_testing_inventory.json)

Updated November 10, 2026. This is an inventory of mutation assessment progress, not line coverage, a global mutation score or a claim that tests are absent. The 35 primary lots partition all 631 TS/TSX candidate sources currently selected by the full Stryker configuration. This includes type-only and re-export files that may generate no mutants. The empty `ui` directory is retained explicitly; it may be absent in a fresh Git checkout.

## Scope and states

Each primary lot owns one top-level component directory and every nested adapter. They are tracking scopes, not a promise that a component-wide run fits ten minutes. Split an oversized component into named file/range sublots before treating it as complete; record the exact union and verify that it covers the parent without gaps or overlap. Selected samples and method ranges below are evidence inside parent lots, not additional primary lots to count twice.

- **Not assessed:** no dedicated complete component reference. Historical partial monolithic observations may exist.
- **Partial / selected evidence:** one or more selected slices have results; the full component is not established.
- **Assessment complete; review pending:** the selected full component assessment finished, but remaining errors/survivors have not been reviewed.
- **Reviewed:** the full declared scope has results, material survivors and uncovered paths have classifications, and limitations are documented. No primary component currently claims this state.
- **No candidate sources:** no eligible runtime-source candidates exist in this checkout. This is not a 100% mutation score.

Source counts do not measure executable lines, mutant volume or test strength. A `NoCoverage` observation is a test/instrumentation finding, not a completed behavior review. Fast-mode results never establish a full-mode reference. Mode, date and source/test/configuration revisions must remain attached to future evidence.

## Primary lots

| Lot | Candidate files | Assessment state | Next focus / subdivision | Evidence |
| --- | ---: | --- | --- | --- |
| `actions` | 9 | Not assessed | Validation, CRUD repository contracts, cursor and page pagination | — |
| `app` | 11 | Partial / selected evidence | Startup, execution ownership and catalog pending; shutdown slice reviewed (three equivalents) | `app-shutdown` |
| `atlas` | 51 | Not assessed | Collections, routing, actions/responses, rendering and adapters | — |
| `authentication` | 44 | Partial / selected evidence | Account/session manager and Argon2id hasher reviewed with documented limits; adapters, HTTP and other authentication sources pending | `configuration-sample`, `authentication-sessions`, `password-verification` |
| `authorization` | 23 | Partial / selected evidence | Decision manager reviewed; requirement builders, scoped stores and other authorization sources pending | `authorization-decisions` |
| `background` | 4 | Not assessed | Runtime admission, drain and failure propagation | — |
| `cache` | 24 | Not assessed | Memory, PostgreSQL and Redis contracts; expiry and pruning | — |
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
| `outbound_http` | 17 | Not assessed | Retries, budgets, abort, middleware and dependency failures | — |
| `scheduled_tasks` | 19 | Partial / selected evidence | PostgreSQL extendLease reviewed; reservation lifecycle, scheduler and other adapter operations pending | `postgres-ownership` |
| `scheduling` | 4 | Not assessed | Clock, scheduling and cancellation primitives | — |
| `studio` | 95 | Not assessed | Server/extensions, client state, routing and rendering | — |
| `testing` | 1 | Assessment complete; review pending | Public HTTP policy helper; PostgreSQL/Redis fixtures excluded | `testing-component` |
| `throttling` | 34 | Partial / selected evidence | Leased inspection/reconciliation reviewed; admission, other lease methods and adapters pending | `configuration-sample`, `adapter-circuit-pilot`, `throttling-inspection` |
| `tokens` | 31 | Not assessed | Issuance, lookup, expiry, revocation and adapter consistency | — |
| `ui` | 0 | No candidate sources | Empty source directory in this checkout; retain explicit inventory entry | — |
| `utils` | 5 | Not assessed | Codecs, identifiers, catalog and boundary validation | — |
| `workers` | 23 | Not assessed | Delivery, retries, scheduler, publication and adapters | — |
| `workflows` | 38 | Partial / selected evidence | PostgreSQL retryTask reviewed; serialization, runtime, scheduler and other adapter operations pending | `postgres-ownership` |

The current total is 24 not-assessed lots, nine partially assessed lots, one completed assessment awaiting review, and one lot without candidate sources. These are manual assessment states; no completion percentage is derived from them.

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
