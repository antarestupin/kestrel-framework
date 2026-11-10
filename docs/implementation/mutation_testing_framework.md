# Framework mutation assessment

[Testing reference](./testing.md#framework-mutation-testing) · [Running mutation tests](../usage/testing.md#run-framework-mutation-testing) · [Historical pilot](./mutation_testing_pilot.md)

## Assessment status

**PRELIMINARY: the campaign was stopped at the user's request at 21:35 Europe/Paris on November 9, 2026.** The complete framework assessment has not finished. The final saved checkpoint contains 18,525 of 42,816 mutation statuses: 6,135 killed, 2,212 survived, 31 timed out, 10,143 uncovered and four ignored; 24,291 remain unresolved. No runtime or compilation errors are recorded. These are partial observations, not a framework mutation score. Stryker scheduled static mutants after runtime mutants, so the early results cannot establish the quality of configuration, schema declarations or other module-initialization behavior. The guarded campaign started at 20:52 with no cached outcomes reused, then resumed from checkpoints as described below.

The stopped snapshot is `artifacts/mutation/checkpoint-stopped-by-user.json`, with a machine-readable summary in `artifacts/mutation/checkpoint-stopped-by-user-summary.json`. Its results remain available in the incremental cache. The wrapper stopped its process group and completed temporary database cleanup; no mutation process remains active. Existing `mutation.html` and `mutation.json` files must not be presented as a completed framework report. Stryker's last remaining-time estimate was approximately 35 hours, but it was unstable and static mutants had not yet been measured; this is not a reliable completion forecast.

The November 9, 2026 scope contains 631 TypeScript/TSX source files in 34 component directories and generates 42,816 mutations. The instrumented baseline executes all 1,633 framework tests from 244 test files. Application and generator tests are outside this assessment. Tests, declaration files, PostgreSQL/Redis connection fixtures and worker conformance test assertions are excluded from mutation, while browser clients, adapters and public runtime helpers remain included. Four mutations around the literal Vite glob declaration are ignored because conditional instrumentation prevents Vite from compiling the unmodified baseline.

## Bounded static sample

On November 10, 2026, the dedicated sample profile completed a fresh assessment of nine import-time declarations across authentication, throttling and PostgreSQL configuration. All 18 generated mutants were classified static. The final standalone run completed in 17 seconds with two workers, including a 527-test baseline taking approximately five seconds. No previous results were reused. Results: eight killed, nine survived, one runtime initialization error, no timeouts and no uncovered mutants. Reports are `artifacts/mutation/static-sample/mutation.{html,json}`; the sample's events and cache are separate from the interrupted global campaign. The ten-minute cutoff was not reached. The deadline/checkpoint/cleanup path is independently tested with an injected short budget.

An initial numeric-default selection generated only one mutation with the enabled operators and was replaced. A preliminary run of the corrected sample overlapped other checks and took 20 seconds with the same statuses; the final run above had no concurrent build or framework test campaign. Small infrastructure assertions were the only concurrent check. These observations are not a controlled general performance benchmark.

Authentication contributes six survivors: accepted SameSite values and the non-default path through its enum, cookie-name default, and cookie-path literal/default. PostgreSQL contributes one survivor for the explicit `include` observation option. Throttling contributes two survivors changing the explicit `reject`/`emergency-local` discriminator values. These changes are not all equivalent: direct schema tests should accept documented alternatives, reject unsupported values, and assert security-sensitive defaults. Zod defaults can bypass validation of the default itself, allowing invalid mutated schema alternatives to survive tests that exercise only omitted input. The initialization error removes a discriminated-union option's shape and makes Zod reject the module outside a test; it is reported separately from assertion kills. None of these results establishes a production defect in the unchanged implementation.

The sample spent roughly 11 seconds after the baseline on 18 static outcomes, about 1.6 outcomes per wall-clock second across two workers. This includes different test-suite sizes, early failures and initialization overhead; it is not a measured standalone reload cost. Survivors completed 34 tests for authentication, 205 for PostgreSQL and 313 for throttling. No survivor completed zero tests. This directly demonstrates that a static mutant need not rerun the 1,633-test full baseline. The sample is deliberately selected from three configuration modules, so extrapolating its throughput to all approximately 3,500 static mutants would be unjustified. In particular, the previous 35-hour remaining-time estimate is not validated by this experiment.

### Configuration regression tests: before and after

The follow-up added 18 configuration cases: nine authentication cases for cookie defaults, valid/invalid SameSite values and explicit root-path validation; five throttling cases for default, explicit and invalid failure strategies; and four PostgreSQL cases for accepted/rejected query-parameter observation options. These exercise the public configuration parsers directly. Production code and sample selections are unchanged.

The fresh run regenerated exactly the same 18 static mutations, verified by file, location, mutator and replacement, with identical production sources in both reports. No cached outcomes were reused. All nine former survivors are now killed; all eight original kills remain kills, and the same invalid discriminated-union shape still fails during module initialization outside the tests.

| Result | Before | After |
| --- | --- | --- |
| Killed | 8 | 17 |
| Survived | 9 | 0 |
| Runtime initialization errors | 1 | 1 |
| Timeout / NoCoverage | 0 / 0 | 0 / 0 |
| Stryker score, excluding the initialization error | 47.06% | 100% |
| Baseline tests | 527 | 545 |
| Elapsed time, rounded | 17 seconds | 15 seconds |

The runtime figures are local observations, not a performance comparison: the follow-up briefly overlapped the build. Both runs remained well below the ten-minute mutation budget. The 100% score applies only to the 17 mutants in this sample's scoring denominator; the initialization error is excluded and this is not a framework-wide score. The former survivors represent missing regression assertions rather than equivalent mutations.

The original HTML/JSON reports and measurement are archived under `artifacts/mutation/static-sample-before-config-tests/`. Current reports remain under `artifacts/mutation/static-sample/`; `config-tests-comparison.json` records the nine exact status transitions. The complete normal test suite now passes 1,673 tests, and the build passes.

### Classification of the remaining initialization error

The remaining `RuntimeError` is classified as **runtime-invalid schema construction**, not as a surviving behavior mutation or a test-infrastructure failure. Its fingerprint is `src/packages/kestrel/src/throttling/configuration.ts`, line 34, columns 12–45, `ObjectLiteral`, replacement `{}` (sample ID `13`, which is not a stable identifier). It removes `strategy: z.literal("reject")` from the first `z.object` option. Zod then reports `Invalid discriminated union option at index "0"` when import-time configuration parsing prepares the test modules, before individual test assertions run.

Keep this mutation visible with its original Stryker status and exclude it from the score using Stryker's existing error handling. Do not convert it to `Killed`, add an ignore directive, or alter production code to normalize the report. On future sample runs, match the source expression/location, mutator and replacement, then inspect the reason again: this classification applies only while the missing discriminator causes the initialization error. A different reason, such as unavailable infrastructure, requires investigation rather than automatic acceptance. The current report has a separate classification record at `artifacts/mutation/static-sample/classification.json`; the Stryker report itself is unchanged.

## Historical execution and interpretation

The first full-scope attempts exposed two execution constraints: cumulative coverage metadata can exhaust a non-isolated runner's heap, and repeated runner startup dominates many small mutation runs. Deterministic projects containing at most six non-isolated test files were an intermediate workaround that passed the complete instrumented baseline. Their checkpoints remain historical observations.

The current configuration uses one non-isolated Vitest project, the forks pool and two Stryker workers. A custom runner snapshots each completed file's coverage metadata and clears only the shared per-test map. It preserves the coverage object's identity because cached instrumented functions retain that object; replacing it would silently lose coverage from later files. A real Stryker regression probe compares this optimization with isolated files, including semantic covering-test identities, static activation and recovery after module-import errors. Agreement in that probe supports the optimization, but does not validate every framework mutant. Native `related: true` limits static-mutant suites through the dependency graph, while runtime mutants additionally use per-test coverage. The absolute CLI-entrypoint rerun trigger preserves graph-opaque subprocess suites in the full-scope baseline; targeted source selections can still omit those suites.

An interrupted checkpoint at 20:33 Europe/Paris contains 17,410 recorded statuses: 5,274 killed, 1,967 survived, 21 timed out, 10,144 uncovered and four ignored. None of its completed active mutations are static mutants. These counts are useful for locating missing assertions, but their ratio is not a complete framework score. Its 1,636 reported test identities are collection metadata, not a replacement for the 1,633 executed baseline tests. The ignored local artifact is `artifacts/mutation/checkpoint-batched-003.json`; the HTML/JSON final-report paths must not be assumed to describe this checkpoint or a complete run.

The run was stopped after identifying a possible connection-routing escape in a mutation of `db/provider.ts`: removing the `createPoolConfig()` body passes `undefined` to `pg.Pool`, allowing the driver's ambient defaults. There is no evidence that another database was contacted. A guard outside the mutation scope now validates effective connection and PostgreSQL startup coordinates before transport connection, preserving callback/Promise behavior and rejecting discrepancies rather than correcting mutated configuration. The final execution configuration passed all 1,633 baseline tests in 19 seconds, and its 28 infrastructure checks pass without PostgreSQL or Redis connections. These checks include actual driver instances, cached-module coverage and subprocess interruption/cleanup paths.

The npm wrapper provisions a separate temporary PostgreSQL database per Stryker worker. Schema randomization alone is insufficient because fixtures also use database-scoped advisory locks and database-wide activity queries. Cleanup uses exact run-owned manifest records and waits for owned subprocesses to terminate before dropping databases; it preserves the manifest when cleanup cannot safely complete. The configured test role needs database creation/deletion privileges on the dedicated test service. Redis fixtures already use UUID prefixes on database 2, but a mutant can remove an adapter prefix. An outgoing guard outside the mutation scope now checks serialized physical keys, declared Lua `KEYS` and scan patterns against the test UUID namespace, rejecting unsupported commands. These guards reject invalid mutated operations instead of repairing them. A detection caused solely by a guard needs its own classification: it protects the assessment but does not demonstrate an assertion in a framework behavior test. Changes to this non-mutated infrastructure require a fresh assessment rather than blind reuse of earlier results.

Classify results by observable contract before deciding which tests to add. A survivor can expose a missing assertion, an equivalent expression, an intentionally unconstrained diagnostic or a type-level contract that runtime tests do not enforce. `NoCoverage` means Stryker did not observe execution; it does not prove that no test exists. Child Node processes used by some CLI/Vite checks have separate globals, and React server rendering does not exercise browser interactions.

Stryker mutates the JavaScript/TypeScript syntax tree, not the semantics of embedded SQL or Lua. It can mutate interpolated expressions or replace an entire script string with an empty string, but this does not systematically challenge SQL ownership predicates or Lua atomicity and token checks. Killing an empty SQL/Lua literal through a syntax error does not establish that its `WHERE` conditions, reservation tokens or all-or-nothing writes are tested. Keep direct adapter contract tests for stale ownership, concurrent operations and atomic failure behavior even when the surrounding source has a high mutation score.

Native Stryker timeouts and Vitest test timeouts need separate review. In checkpoint 003, 75 `Killed` results have a reason matching `Test timed out in`, while 19 of the 21 `Timeout` results reached Stryker's execution hit limit. The latter are loop-execution guards, not elapsed-time measurements; two timeout results have no recorded reason. A five-second Vitest timeout can detect lost progress or cleanup, but it is weaker evidence for a particular value assertion. Do not sum recorded mutant test durations and call that elapsed campaign time; incremental results can also omit duration metadata while retaining statuses.

### Stable test identities and incremental reuse

A real Stryker probe confirmed that collection-time dates in parameterized test names can break per-test filtering: the baseline collects one name, but a later mutant run collects a different timestamp. With a dynamic date, a five-mutant fixture reported four survivors with `testsCompleted: 0` and one uncovered mutant. Using a constant date produced three kills, one legitimate survivor and the same uncovered mutant. Keep generated test names stable across collection and filtered reruns, including names derived from dates or random fixtures. A survivor with zero completed tests needs investigation; a positive count alone also does not establish that every selected test ran, because other covering tests can complete while the intended regression case is omitted.

`workflows/serialization.test.ts` now uses the fixed date `2026-01-01T00:00:00.000Z`, with an English comment explaining name stability. Its seven targeted tests pass. The campaign resumed at 21:07:24 Europe/Paris after this single tracked test-file change, adding two lines and removing one. Frozen manifest v3 preserves v2 and records only this fixture change. Stryker detected the changed test file and reused all 12,982 non-ignored cached results: the old date case covered none of those already recorded mutants, so no recorded result was affected by that case's replacement. This is a tracked incremental continuation, not permission to reuse outcomes after arbitrary infrastructure changes.

The resumed unmodified baseline passed all 1,633 tests in 19 seconds at 21:07:47 Europe/Paris. At resumption, 29,830 mutants remained to execute. The campaign is still running; neither cache reuse nor this baseline establishes a complete mutation score.

## Highest-priority behavioral gaps

### Application shutdown and concurrent stop

Several mutations remove ordinary failure collection from shutdown phases in `app/app.ts`, or let a second `stop()` caller return before the existing stop promise settles. Existing deadline tests do not distinguish every ordinary rejection because the deadline coordinator retains its own error separately.

Independent memory-only public-API probes compared the current implementation, an unchanged reference copy and exact source mutations. Removing error collection for a rejecting runtime-stop listener, transport drain or observation flush lets disposal resolve silently; the current implementation preserves the original cause and disposes an owned resource once. Removing the cached stop-promise return lets a second caller resolve while a gated first stop remains pending. These are confirmed missing regression scenarios, not defects observed in the current implementation.

Add ordinary rejection tests for each phase, asserting cause preservation, continued cleanup and final disposed state. Add a gated concurrent-stop test asserting that both callers remain pending until the same work completes.

### Authentication account state and positive authorization

Mutations of `authentication/manager.ts` can remove the active-account check when completing trusted proof or resolving an existing session. Independent public-API probes confirm that the current implementation refuses a disabled account, while the exact mutations create a session or authenticate the old session. Add account invalidation between proof creation and completion, and disable an account after issuing a valid session. Assert refusal and absence of a new session write.

The `allOf` authorization branch also needs a positive case with every required permission granted. An exact mutation rejecting this branch survives the current tests, while an independent probe distinguishes it from the correct implementation. Keep denial cases, and assert both successful evaluation and successful enforcement for the fully granted case.

Account-wide revocation is uncovered at the manager boundary. Test two sessions for one account and a session for another, checking account isolation, returned count, supplied reason and clock value. Claims-size tests should use valid variable-sized UTF-8 data at and immediately beyond the byte limit, rather than relying on schema-invalid values to reject before the size check.

Argon2id verification limits need stronger fixtures. The five parameter-budget cases use nonmatching zero-filled tags, so a mutant can perform the otherwise forbidden derivation and still return false for the password; `needsRehash()` also remains true because the stored parameters differ. Generate valid hashes just above small configured verification limits and verify rejection with the correct password, alongside checks that expensive derivation is avoided. The encoded-length limit already has a valid-hash fixture. Separately test that a peppered hash verifies only with the configured pepper: the current hasher tests do not exercise pepper propagation. These are missing regression distinctions, not observed violations in the current implementation.

### Database-backed ownership and lease operations

`workflows/adapters/postgres/adapter.ts` has no observed coverage for `retryTask()`, although `retryExecution()` is exercised. Add an activity reservation with a current token, verify the future availability time and cleared reservation, and verify rejection for stale tokens and non-activity tasks.

`scheduled_tasks/adapters/postgres/adapter.ts` has no observed coverage for `extendLease()`. Verify that the expiration advances only for the matching task and reservation token, that stale reservations return false, and that another reservation remains unchanged. These operations directly support scheduler ownership and deserve tests ahead of cosmetic survivors.

### Leased throttling and partial lock failures

The leased throttling adapter's `reconcile()` forwarding and `inspectMany()` paths are uncovered. Cover mixed exact/leased requests and result order, a locally available lease, expired or exhausted leases falling back to authoritative inspection, the fractional-cost boundary, unsupported capabilities and incomplete authoritative results. Verify reconciliation arguments and the returned authoritative result.

The lock manager's batch-extension failure paths need backend rejection and malformed/incomplete-result cases. Assertions should show that all pending attempts settle, affected handlers receive cancellation and owned resources are released. Testing only a successful extension leaves compensation behavior unconstrained.

## Other useful gaps

| Area | Missing distinction | Useful assertion |
| --- | --- | --- |
| Model CRUD actions | The repository fake always returns a row even when `returning: true` is removed. | Use a faithful fake or call assertions, together with the observable create/update/delete response. |
| Pagination defaults | Explicit `type: "all"` coverage does not validate the default when that option is available. | Parse `undefined` and verify a bounded first page; independently test zero, negative and safe-integer lookahead limits. |
| Memory cache pruning | A prune count can remain correct even if the expired record is retained; the explicit limit equals the configured default in the existing test. | Assert physical removal through a public operation that does not itself lazily expire the entry, and use an explicit limit different from the default. |
| PostgreSQL cache pruning | Expired and overflow pruning are tested separately. | Combine both in one call and verify the total work respects the limit. |
| Execution diagnostics | Overflow is covered, but exact inclusive UTF-8 budgets and unknown destinations are not. | Accept exactly the entry/aggregate limit, reject the next byte atomically, and preserve existing diagnostics after invalid input. |
| Catalog identities | Duplicate actions/workflows are covered more thoroughly than CLI commands and worker queues. | Contribute distinct definitions with identical runtime identity and assert rejection. |
| Atlas collection parsing | One malformed string does not distinguish numeric validation branches. | Reject zero, negative and fractional page/page-size values in number and string form. |
| Atlas navigation/runtime | Disabled routes and one resource/effect do not constrain positive routes or ordering. | Exercise enabled create/edit routes, multiple resources/effects and malformed successful HTTP envelopes. |

Do not classify retention-related survivors as equivalent solely because shutdown still completes: removing a disposed execution from an active-execution collection can matter during a long-running application even when its resolved promise no longer delays shutdown. Prefer a behavioral retention contract over a test that only inspects a private set.

Some session-expiration checks overlap valid adapter invariants. Review their exact accepted inputs before adding artificial tests: an idle deadline bounded by absolute expiration and an adapter that rejects an expired touch can make individual manager guards redundant for conforming adapters. This differs from the confirmed active-account checks above. Likewise, an invalid token rejected by a digest lookup is not automatically an authentication bypass when a canonical-format guard is removed.

## Coverage volume and sequencing

The initial coverage pass reports 10,144 uncovered mutations. Studio accounts for 3,591 and Atlas for 1,967, together 5,558 (54.8%) of that volume. Workflow code contributes 1,195, throttling 697 and scheduled tasks 417. These numbers describe observed coverage gaps in this source scope; they are not a risk ranking and may change when test infrastructure or instrumentation changes.

First add the confirmed shutdown and authentication/authorization scenarios, including password-verification budgets, then the database-backed retry/lease and coordination failure cases. Follow with faithful CRUD fakes and boundary tests. Treat browser interaction coverage and subprocess instrumentation as explicit workstreams: adding Node assertions alone cannot necessarily close those observation gaps. Pure collection, routing and API-response helpers can already receive focused Node tests. Keep every source component visible while investigating them.

There is no blocking mutation-score threshold. A meaningful future gate needs a completed reproducible campaign, separate review of static initialization errors and timeouts, and classification of material survivors. The original adapter/circuit pilot score is not comparable to this expanded scope. Pending work includes a complete fresh campaign under the optimized runner and guarded worker isolation, broader runtime measurements, subprocess coverage, browser interactions and TypeScript-checker compatibility. Do not merge historical checkpoint statuses into that fresh result merely because source mutations still have matching identifiers.
