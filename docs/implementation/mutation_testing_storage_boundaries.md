# Mutation review of database, lock and cache boundaries

[Coverage inventory](./mutation_testing_inventory.md) · [Contributor commands](../contributing/mutation-testing.md)

The November 12, 2026 review covers the 88 eligible sources in `db`, `lock`, `database` and `cache`. The starting revision is `ca41c5e`. Each profile retains static and hybrid mutants, forces fresh execution and has a ten-minute budget. The score remains informational.

The original combined `db-history` and `db-reference-counter` references, both full definition references, and the final combined `db-schema` run reached the budget. Their checkpoints are preserved as partial evidence. The comparison uses fresh references for the smaller profiles, taken from a snapshot of the original sources and tests in each selected scope. The scope audit checks that the partitions cover the full candidate sets without overlap, using fingerprints from the Stryker instrumenter. Reports and the unchanged-span comparison are archived under `artifacts/mutation/nov12-storage-boundaries/`.

Some profiles finished measuring mutations before the wrapper reported a PostgreSQL cleanup timeout. Their complete reports are included after a successful cleanup retry using each run's exact ownership manifest. The archived execution metadata records both results.

## Results

The completed runs compare 4,524 unchanged mutant fingerprints out of 4,718 baseline and 4,859 final mutants. Stryker classified 924 baseline and 950 final mutants as static or hybrid. The longest completed run took 583 seconds.

Among paired mutants, 471 prior survivors and 39 previously uncovered mutants are killed in the final reports. Stryker includes individual execution timeouts as detections and excludes runtime errors from its score. A profile stopping at its wall-clock deadline is partial evidence.

| Component | Paired mutants | Before K / S / NC / T / RE | After K / S / NC / T / RE | Stryker score |
| --- | ---: | --- | --- | --- |
| `db` | 2380 | 1880 / 483 / 14 / 17 / 132 | 2299 / 188 / 9 / 12 / 127 | 79.24% → 92.15% |
| `lock` | 1144 | 974 / 158 / 22 / 8 / 8 | 1119 / 42 / 3 / 3 / 8 | 84.51% → 96.14% |
| `database` | 152 | 134 / 18 / 4 / 0 / 0 | 172 / 16 / 0 / 0 / 0 | 85.90% → 91.49% |
| `cache` | 848 | 724 / 118 / 12 / 2 / 10 | 817 / 31 / 1 / 2 / 10 | 84.81% → 96.24% |

## Profile executions

| Profile | Before mutants | After mutants | Paired | Before seconds | After seconds | Stryker score |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `db-provider` | 357 | 359 | 326 | 296 | 251 | 78.65% → 91.62% |
| `db-instrumentation` | 363 | 357 | 330 | 114 | 202 | 73.76% → 80.90% |
| `db-repository` | 302 | 329 | 297 | 81 | 107 | 86.42% → 96.35% |
| `db-history-declarations` | 62 | 62 | 62 | 366 | 302 | 57.69% → 80.77% |
| `db-history-column-types` | 118 | 118 | 118 | 564 | 330 | 67.05% → 100.00% |
| `db-history-identities` | 104 | 92 | 88 | 484 | 279 | 67.47% → 95.77% |
| `db-history-events` | 239 | 246 | 225 | 509 | 583 | 77.42% → 91.28% |
| `db-reference-counter-declarations` | 184 | 181 | 154 | 544 | 257 | 73.86% → 90.34% |
| `db-reference-counter-discovery` | 48 | 48 | 48 | 152 | 101 | 68.09% → 97.92% |
| `db-reference-counter-runtime` | 135 | 135 | 135 | 155 | 221 | 86.15% → 94.57% |
| `db-schema-table-metadata` | 100 | 116 | 96 | 365 | 301 | 88.78% → 97.37% |
| `db-schema-migrations` | 418 | 496 | 405 | 190 | 115 | 83.73% → 94.76% |
| `db-schema-descriptions` | 96 | 96 | 96 | 303 | 276 | 92.71% → 96.88% |
| `lock-acquisition` | 186 | 186 | 186 | 54 | 52 | 78.49% → 99.46% |
| `lock-ownership` | 459 | 470 | 457 | 125 | 140 | 89.98% → 94.04% |
| `lock-adapters` | 365 | 359 | 341 | 92 | 114 | 87.67% → 97.21% |
| `lock-contracts` | 160 | 160 | 160 | 48 | 59 | 67.76% → 96.05% |
| `component-database` | 156 | 188 | 152 | 58 | 109 | 85.90% → 91.49% |
| `component-cache` | 866 | 861 | 848 | 232 | 299 | 84.81% → 96.24% |

The input manifest and report hashes are in the local archive. Related test files from other profiles could gain assertions after a profile ran. The comparisons identify those files individually. The final reports match the current production source within each selected file or range.

The full framework suite passed 4,026 tests in 338 files, and all 122 mutation infrastructure tests passed. The framework typecheck, framework and playground builds, documentation build and ownership-boundary check passed.

## Database runtime and repositories

Reading an error's code could throw from the pool's diagnostic listener. That lookup now preserves the original driver failure even when an accessor or proxy throws. Query instrumentation now distinguishes a rejected promise with a nullish reason from a successful driver callback and observes synchronous driver throws in callback mode. Resolving an optional observation sink can fail without stopping the underlying query. A deterministic clock test asserts query latency as elapsed time.

Numbered pagination accepted non-finite values supplied through the repository API. A NaN page size could reach Drizzle as an unbounded select. The numbered query and result helpers validate the page, page size, lookahead and offset before executing SQL or constructing the result.

Provider and query residuals concern optional data shapes, diagnostic values and work without a sink, driver coercions, and private proxy reuse or defensive branches for malformed driver calls. Two previously killed provider guard mutants now survive because sink resolution failures are also contained by the query wrapper. The repository residuals include equivalent default offsets and dispatch or minimum-page paths; the lookahead and unsafe-limit paths have direct assertions.

The final `db` reports include 36 kills recorded through Vitest test or hook deadlines, mainly in pool and counter integration tests. Two paired counter mutants moved from an assertion kill to a Stryker timeout. Stryker records its 12 final `db` timeouts and 127 runtime errors in separate categories.

## History and schema

PostgreSQL truncates identifiers by UTF-8 bytes. Two valid Unicode source names previously generated colliding history trigger function names, routing an event into the wrong history table. The shared history identifier helper now reserves space for a stable suffix within the byte limit. Generated history SQL also qualifies default-schema relations as `public`. A live PostgreSQL test proves that a tenant-first search path cannot redirect an explicitly public write into a tenant's same-named history table. Regenerate the schema contributions to update installed triggers. If a database already has several triggers referencing one truncated legacy function, review the generated migration so it drops those triggers before dropping their shared function. Previously misfiled events need separate repair.

Migration generation validates journal structure and unique basename tags before Kestrel reads or rewrites paths derived from them. A generated tag containing `../` could previously make Kestrel rewrite a sibling file. The wrapper reads its embedded snapshot as a separate section so it can recover the metadata when SQL contains marker-like text or a maintainer appends SQL after the section. Equality now compares SQL lifecycle fields independently of property serialization order, so equivalent contributions no longer generate needless cleanup or reinstall SQL.

The reference-counter definition now matches PostgreSQL foreign-key columns by table and physical column name. Drizzle exposes different wrapper objects for columns supplied through table-level `foreignKey()` declarations, so previously a valid single-column constraint was rejected. Rebuild tests verify the explicit READ COMMITTED requirement against a connection with a SERIALIZABLE default, and verify that cancellation after the final partial batch preserves its committed count and resume cursor. Integration tests verify that the trigger SQL targets `public` even with a tenant-first search path and that removing a counter cleans up its trigger functions and allows target-key updates again.

The history column-type and cursor reader tests exercise accepted PostgreSQL types, malformed types and event paging. Remaining history mutations concern equivalent Drizzle builder defaults, internal property flags, identity inference, uncommon quoted identifiers and unusual PostgreSQL type spellings. Many static type and constraint mutations produce invalid declarations during imports, before a test body can execute. Reference-counter declaration survivors include defensive constraint combinations, uncommon accepted key types and internal metadata flags. Runtime survivors concern empty-batch and zero-delay behavior or a defensive timer failure. Schema migration residuals include redundant planning checks, filesystem argument defaults, generated SQL formatting and command diagnostics. The report keeps runner limits and import failures visible alongside assertion outcomes.

## Maintenance and seeding

A generated step formerly reported every identity present in its table, including rows from earlier steps that shared the table or fired a trigger that populated it. Dependent records could then be assigned to the wrong step. The seeder now compares the table's identities before and after each generated step, including structured values decoded by PostgreSQL. Tests cover generated and curated predecessors, version and seed reproducibility, the caller-owned transaction option, and all maintenance commands through the CLI. Reset and migration fixtures use owned temporary files and test doubles for destructive SQL.

The sixteen final maintenance survivors are default option omission, redundant preflight queries or select projections, and primitive-versus-structured comparison optimizations. All maintenance mutants run through an executed test, including the static command registrations.

## Lock

The manager snapshots the lease identity and expiry returned by an adapter, including values exposed through class getters. Mutating an adapter's retained object could previously redirect release toward a successor's lease. Concurrent releases now share one storage operation and its result, and storage errors leave release retryable.

Redis batch acquisition validates the representability of expiry against Redis time before any write or fencing allocation. Previously, a process-clock check could pass while a Redis-calculated expiry failed later. The Redis renewal script now validates each stored lease's identity, expiry and fencing value before writing any member of the batch. A malformed later record previously could leave earlier renewals committed even though the adapter rejected the result.

The lock review classifies 42 survivors as equivalent defaults, ordering/comparator variants, internal defensive paths or instrumentation and diagnostics. Three uncovered branches protect internal invariants. Stryker's hit limit accounts for three non-progress detections and invalid schema variants account for eight runtime errors. The final reports use no Vitest test deadlines for lock detections. Seventeen matched baseline deadline detections now have direct assertions.

## Cache

The memory adapter now skips a candidate that exceeds the entire capacity before eviction. It previously could evict unrelated entries and then discard the candidate too. PostgreSQL overflow pruning calculates and selects the bounded, ordered candidate set in a single statement before claiming rows. In the two-connection regression, the second pass leaves a row outside the overflow set alone while the first deletion is still uncommitted.

All 93 Redis cache mutants are killed. The remaining 31 survivors cover equivalent defaults and fallbacks, optional property shape, diagnostics or redundant work when no observation sink exists. The single uncovered branch guards eviction from an empty map, which valid size accounting cannot reach. Two non-progress eviction variants hit Stryker's limit, and ten runtime errors arise from invalid schema or comment mutations.
