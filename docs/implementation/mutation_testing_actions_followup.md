# Actions, cache and application boundary assessment

[Framework assessment](./mutation_testing_framework.md) · [Coverage inventory](./mutation_testing_inventory.md) · [Contributor commands](../contributing/mutation-testing.md)

This November 10, 2026 session began at 12:48:15 UTC with a thirty-minute global work budget. Every Stryker execution used a ten-minute profile budget including baseline tests, retained static/hybrid mutations and ran fresh without incremental reuse. Comparisons below are selected-scope evidence, not a framework-wide score. The CRUD/pagination slice overlaps the complete actions assessment and must not be added to it.

## CRUD and pagination

The initial profile selected the complete `actions/model_actions.ts`, `actions/pagination.ts` and `actions/cursor_pagination.ts` files. The repository fake previously returned rows regardless of `returning`; six mutations dropping or disabling that option therefore survived. The strengthened fake now mirrors returned-row semantics, snapshots returned rows and records write/query arguments. Six new cases cover missing records, executable list/lookup actions, parsed queries and identifier-free update payloads. Existing asynchronous compositions now dispose their App in `finally` even when a mutation fails an assertion.

Thirty-seven additional pagination cases cover the bounded default even with `allowAll: true`, independent page/page-size validation, controller parsing, numbered output metadata, mapped input preservation, cursor encoding/decoding failures, null cursors and safe lookahead boundaries. No tests pin arbitrary diagnostic wording merely to increase the score.

| Result | Before | After |
| --- | --- | --- |
| Mutants | 176 | 176 |
| Killed | 142 | 168 |
| Survived | 26 | 8 |
| NoCoverage | 8 | 0 |
| Raw score | 80.68% | 95.45% |
| Stryker elapsed | 85 seconds | 70 seconds |
| Baseline tests | 780 | 823 |

### Confirmed production defect

Numbered pagination configuration accepted unsafe integers because it used `Number.isInteger`. For example, setting both `defaultPageSize` and `maxPageSize` to `Number.MAX_SAFE_INTEGER + 1` made `parse(undefined)` return an unsafe page size. Providing the same page size explicitly failed the schema's safe-integer validation. Zod defaults bypass field parsing, so configuration validation must uphold that invariant itself.

Two new regression cases failed against the original implementation and passed after changing the internal option guard to `Number.isSafeInteger`. The public option contract is documented in the [usage guide](../usage/pagination.md) and [implementation reference](./pagination.md). Numbered `Number.MAX_SAFE_INTEGER` remains allowed; cursor pagination retains its additional room-for-lookahead restriction. This change does not assess or change lower-level numbered query-window/offset arithmetic.

The fix changes source expressions and line locations. Equal totals do not imply identical mutation corpora: normalized expression/operator/replacement/occurrence matching pairs 169 sites, with seven unmatched variants on each side. Every matched previous kill remains killed. The [slice classification](./mutation_testing_actions_classification.json) retains the source-change comparison, regression proof and eight residual diagnostic mutations. Before reports are archived under `artifacts/mutation/actions-crud-pagination-before-tests/`.

## Complete actions component

The assessment was then extended through `npm run test:mutation:component -- actions` to all nine candidate source files, including collection input, definition, input mapping, runner, middleware and exports. Eight files generate mutations; the export-only index naturally generates none. This is the first complete primary-component review in the inventory, with the declared limitations below; dependencies such as database query arithmetic and the cursor codec are not mutated by this profile.

The full-component reference was taken after the numbered-default fix and CRUD/pagination tests. Nineteen new collection cases exercise all twelve documented filter operators, structured/JSON/repeated-JSON inputs, both sorting directions, empty field rejection and malformed JSON with structured issue codes/paths. An existing async-policy test now checks the declared default validation policy before binding the action, replacing a timeout-driven detection of an empty factory body with a direct assertion.

| Result | Full-component reference | Final |
| --- | --- | --- |
| Mutants | 238 | 238 |
| Killed | 212 | 226 |
| Survived | 22 | 12 |
| NoCoverage | 4 | 0 |
| Raw score | 89.08% | 94.96% |
| Stryker elapsed | 130 seconds | 100 seconds |
| Baseline tests | 978 | 1001 |

All 238 fingerprints and production file contents match between these full-component runs; every original kill remains killed. There are no final timeout-driven kills, zero-completed-test executed outcomes, Stryker timeouts or initialization/compilation errors. Intermediate full runs remain historical evidence, not an additional component scope. The twelve remaining mutations comprise ten unconstrained diagnostic changes and two optional-description representations. Adding an explicit `description: undefined` differs in own-property enumeration but preserves the documented optional metadata reads; it is not classified as unconditional JavaScript object-shape equivalence. An empty Zod issue object still defaults to the same custom issue code/path and rejection while changing human-readable text.

The [component classification](./mutation_testing_actions_component_classification.json) retains every residual fingerprint, test/report hashes and the timeout improvement. The full reference is archived under `artifacts/mutation/component-actions-before-collection-tests/`; final reports live under `artifacts/mutation/component-actions/`. Keep all survivors visible and re-review when diagnostics, optional-property introspection, schema behavior or source contracts change. A reviewed mutation scope does not prove every possible application behavior or type-level guarantee.

## Additional planned lots

### Cache pruning

Eighteen cases now verify physical deletion through public operations that do not lazily expire records, explicit limits different from defaults, fresh-first bounded scans, expiry equality, invalid limits and PostgreSQL expired-plus-overflow pruning in one call. Memory bounds entries examined; PostgreSQL bounds rows deleted. The tests preserve this documented distinction rather than forcing adapter algorithms to be identical.

The fixed prune/limit-guard scope moves from 37 Killed / 17 Survived / 4 NoCoverage to 51 Killed / 7 Survived / 0 NoCoverage across the same 58 fingerprints, in 12 and 13 seconds respectively (83 and 101 baseline tests). Production code is unchanged. Two residual diagnostic strings are unconstrained; one optional `COUNT` result guard is equivalent under standard ungrouped PostgreSQL count semantics. Four zero-work guard mutations preserve healthy-store deletion results but add queries and expose additional failure observations: they are not strict work/failure equivalences. Direct row identity, count and ordering assertions supplement SQL syntax-tree mutation.

See the [cache classification](./mutation_testing_cache_pruning_classification.json). The parent cache component stays partial; other methods, Redis and broader concurrency contracts are not established by this slice. No production bug was demonstrated here.

### Execution diagnostics

Eight new public-contract cases verify exact inclusive UTF-8 entry/aggregate budgets, the next byte's atomic rejection, append/replacement accounting, diagnostic-to-internal budget release, preservation of rejected updates and unknown destination handling. The fixed budget/destination scope moves from 33 Killed / 4 Survived / 2 NoCoverage to 38 Killed / 1 Survived / 0 NoCoverage across the same 39 fingerprints, in 22 and 21 seconds (949 and 966 baseline tests).

The remaining mutation empties an unknown-destination diagnostic message; the rejection type and atomic state/budget behavior remain intact. There are no timeout-driven detections. See the [diagnostic classification](./mutation_testing_execution_diagnostics_classification.json). Other execution-context methods and application startup/ownership remain outside this slice. No production bug was demonstrated here.

### Catalog identity wiring

Four public composition cases exercise distinct definitions with identical CLI commands or worker queues across catalog branches, positive unique identities and usability of the existing registry after single-definition rejection. All owned Apps are disposed. The fixed initializer scope moves from six survivors to four kills and two survivors across the same six fingerprints, in 15 and 13 seconds (784 and 788 baseline tests).

The two residuals only change human-readable category labels in duplicate-identity errors; rejection and registry contents remain tested. The tests do not establish rollback of an arbitrary multi-definition contribution. See the [catalog classification](./mutation_testing_catalog_identities_classification.json). The rest of the catalog/registry implementation is not mutated in this slice. No production bug was demonstrated here.

### Atlas collection URL state

The final bounded extension selects the complete portable `atlas/client/src/collection.ts` helper, not browser interactions or the rest of Atlas. Tests exercise established URL normalization: invalid/nonpositive/fractional/nonfinite page inputs fall back to defaults rather than becoming schema exceptions. Backend-specific maximum page sizes are not imposed by this URL helper. Accepted filter operators, mixed malformed filter neighbors, ordered sorting and serializer omission/round trips are also covered.

The recorded reference has 162 mutations: 93 Killed, 61 Survived and eight NoCoverage in 15 seconds with 32 baseline tests. The final run records 156 Killed / 6 Survived / 0 NoCoverage in 18 seconds with 85 baseline tests. All 162 fingerprints and production contents match; no prior kill regressed. The six residuals comprise five redundancies under ordinary primitive-string/JSON parsing and one optional search-property representation. The [Atlas classification](./mutation_testing_atlas_collection_classification.json) records exact assumptions and fingerprints. No production source change is included in this extension. Reserved delimiter characters in sort field names remain a deferred contract question; this work does not claim arbitrary-field wire-format round trips.

## Evidence and validation

All before reports are retained separately from current profile reports under ignored `artifacts/mutation/` paths. Durable classifications and the [session evidence](./mutation_testing_actions_session.json) record counts, exact scopes, report/input hashes, semantic limits and remaining work. Profiles share guarded worker isolation and deadline cleanup. The profile catalog was extended for independent lots during the session; each archived before-input manifest remains attached to its original report.

Scores remain informational: no ignore directives, adjusted scores, blocking thresholds or CI gates are introduced. The complete actions lot is reviewed with explicit diagnostic/metadata limitations. Cache, Atlas and app evidence remains partial at parent-component level. Browser behavior, SQL/Lua semantic mutation and lower-level pagination arithmetic are not inferred from these scores.

The completed validation passes 1,953 ordinary tests across 261 files with `--no-isolate`, framework typechecking, the framework/playground build, the documentation build, all 45 mutation infrastructure checks and the 35-lot/631-source inventory audit. Work completed within the thirty-minute global budget, approximately 26 minutes after starting. All assessment processes exited and their wrappers completed owned-resource cleanup.
