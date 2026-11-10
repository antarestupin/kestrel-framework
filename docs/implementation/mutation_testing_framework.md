# Framework mutation assessment

[Testing reference](./testing.md#framework-mutation-testing) · [Running mutation tests](../contributing/mutation-testing.md#run-framework-mutation-testing) · [Historical pilot](./mutation_testing_pilot.md) · [Lot inventory](./mutation_testing_inventory.md)

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

## Bounded application shutdown comparison

On November 10, 2026, `npm run test:mutation:shutdown -- --incremental --force` assessed `App.stop`, `dispose`, `finishAndDispose` and `runShutdownBoundary`, retaining all dependent framework suites and static/hybrid mutations. The profile selects anchored method boundaries in `app/app.ts` and automatically stops mutation work after ten minutes, including the initial tests, using the existing checkpoint and resource-cleanup mechanism. Each comparison run started fresh with zero cached outcomes reused. Reports and cache live under `artifacts/mutation/shutdown/`.

Six memory-only regression cases were added in `app/shutdown_errors.test.ts`: ordinary rejections from runtime listeners, transport drain, shutdown listeners and observation flush; simultaneous failures across those phases; and concurrent stop callers blocked on one runtime listener. They assert original-cause preservation, continued cleanup, exactly-once resource disposal, terminal state and absence of a deadline error. The concurrent-stop case uses an explicit gate and an event-loop turn, not elapsed-time thresholds. Cleanup releases the gate and owned resources in finally blocks. Production behavior was unchanged.

| Result | Before | After |
| --- | --- | --- |
| Mutants | 117 | 117 |
| Killed | 65 | 75 |
| Survived | 37 | 29 |
| NoCoverage | 15 | 13 |
| Timeout / errors | 0 / 0 | 0 / 0 |
| Raw score | 55.56% | 64.10% |
| Score over covered mutants | 63.73% | 72.12% |
| Baseline tests | 707 | 713 |
| Stryker elapsed time | 96 seconds | 98 seconds |

All 117 source/location/mutator/replacement fingerprints and production source text match across reports. The eight former survivors now killed remove the cached stop-promise return (two variants) or ordinary error collection for runtime stopping, transport draining and observation flushing (six variants). Two previously uncovered mutations remove collection of asynchronous shutdown-listener errors; both are now killed. Every original kill remains a kill. The remaining 29 survivors and 13 uncovered mutations are still visible and have not been blanket-classified as equivalent. Further review can distinguish diagnostic-only changes, overlapping fallback checks and missing startup/disposal or completion-listener scenarios.

Before reports are archived in `artifacts/mutation/shutdown-before-tests/`; `artifacts/mutation/shutdown/comparison.json` records the ten exact transitions. Both runs completed under their individual ten-minute budgets. These are local runtime observations rather than a controlled performance comparison; other validation briefly overlapped the second run. The complete regular suite passes 1,679 tests, the 31 infrastructure checks pass and the build passes. No global mutation threshold was added.

### Shutdown review completed

The November 10 follow-up reviewed all 29 surviving and 13 uncovered mutations from the preceding shutdown run. It added 24 cases in `app/shutdown_contract.test.ts` and strengthened the existing aggregate-error assertion. Scenarios include disposal during both startup states and failed startup, stop-only transport drain, pre-start stop behavior, synchronous and asynchronous completion failures, queued shutdown work after a synchronous listener error, child completion tasks, task/event sealing, deadline cancellation, exact timeout phases, and reentrant lifecycle calls. A custom preconfigured event bus also verifies that ordinary cleanup failure and coordinator expiry are both retained. It advances the monotonic-clock reading and uses the public coordinator's `wait()` to model a budget consumed by synchronous cleanup; no private coordinator error state is modified.

Three regression cases failed against the prior implementation: bootstrap callbacks could request disposal before `startPromise` was assigned and release resources during boot; a synchronous stopping listener could receive an already-resolved nested `stop()`; reentrant disposal could dispatch shutdown twice and encounter a closed event scope. `start`, `stop` and `dispose` now publish their in-flight promises before executing synchronous callbacks. State transitions remain synchronous. These changes fix observable lifecycle ownership defects; they are not exclusions introduced to improve a score. A separate once-bootstrap-listener case protects reentrant `start()` from duplicate provider boot.

| Result | Before review | Reviewed result |
| --- | --- | --- |
| Mutants | 117 | 117 |
| Killed | 75 | 114 |
| Survived | 29 | 3 |
| NoCoverage | 13 | 0 |
| Timeout / errors | 0 / 0 | 0 / 0 |
| Raw and covered score | 64.10% / 72.12% | 97.44% / 97.44% |
| Baseline tests | 713 | 737 |
| Stryker elapsed | 98 seconds | 58 seconds |

Both runs use the same anchored method scope, but production source changed, so they are not identical mutation corpora despite equal totals. Comparing method, normalized original expression, operator, replacement and occurrence matches 114 sites. All 42 formerly surviving/uncovered sites match: 26 survivors and all 13 uncovered sites are now killed, leaving three equivalents. Every matched original kill remains killed. Three body-level mutation expressions changed with the promise-publication fix; their new variants are killed as well. The final fresh run reused zero results, retained all 80 static/hybrid mutations and completed within its ten-minute budget. No kills relied on a Vitest test timeout. Timings are local observations with some validation overlap, not a performance benchmark.

The [durable classification](./mutation_testing_shutdown_classification.json) records the three residual mutants, source/test/configuration hashes and assumptions:

| Current sample ID | Equivalent change | Control-flow justification |
| --- | --- | --- |
| 24 | Remove `finishAndDispose`'s initial `shutdown.begin()` | The first startup wait or `stop()` initializes the same idempotent coordinator before external cleanup work. |
| 30 | Treat `startPromise !== undefined` as always true during disposal | The private `bootstrapping`/`ready` states imply a startup promise published before `finishStart`; the promise is never cleared. |
| 105 | Change `errors.length > 1` to `>= 1` | The preceding `length === 1` branch already throws, with no intervening callback or await. |

These classifications apply under the recorded lifecycle invariants, not arbitrary private-state modification. Re-review them when state transitions, coordinator initialization or error aggregation change. They remain visible as survivors; the raw score is not adjusted to 100% and no score gate is introduced. The deadline fallback is **not** equivalent: the custom event-bus failure scenario kills both its omitted-push and false-condition mutations, so the guard is preserved.

The initial review baseline is archived under `artifacts/mutation/shutdown-before-review/`. Current reports remain under `artifacts/mutation/shutdown/`, with `review-comparison.json` for site transitions and `classification.json` for the residuals. Validation passes all 1,703 regular tests and the build. The inventory marks the shutdown evidence reviewed; the parent `app` lot remains partial. Mutation of `App.start` itself, `ApplicationShutdown`, process terminal policy and other application modules is outside this particular scope, even though some of their contracts are exercised by these regression tests.

## Authentication account and session review

On November 10, 2026, `npm run test:mutation:authentication-sessions` assessed the entire `authentication/manager.ts` file, including proof completion, session resolution, revocation, principal construction, claims validation, canonical token validation and renewal/expiration helpers. Both reference and final runs were fresh, used two workers, retained static/hybrid activation and had a ten-minute budget including baseline tests. Neither reached the deadline. Adapter implementations, password mechanisms, proof construction and HTTP are dependencies rather than mutated sources in this lot.

The new `manager_contract.test.ts` adds 31 deterministic, memory-only public-contract cases. They cover disabling an account after proof creation and session issuance, missing accounts/subjects, security-version invalidation in separate and combined lookups, snapshot ownership, account-isolated revocation with count/reason/time, canonical tokens before storage access, valid UTF-8 claims at and beyond the byte limit, schema-invalid or oversized persisted claims, non-serializable claims, touch coalescing and its exact boundary, capped renewal, revocation racing with touch, and idle/absolute expiry boundaries. Rejection cases assert no session creation or renewal where appropriate. No production code changed and no HTTP listener is started.

The absolute-expiry cases deliberately keep idle expiry later and remain below the touch interval. `CreateStoredSession` accepts independent deadlines: memory creation, PostgreSQL insertion and the session table do not require idle expiry to precede absolute expiry. Sessions imported through that public contract must still respect their hard deadline. This distinguishes the manager's absolute check without private-state modification or a conditional-touch rejection masking the result. The tests therefore demonstrate a missing distinction, rather than assuming that the absolute check is redundant because manager-issued sessions normally have capped idle deadlines.

| Result | Before | After review |
| --- | --- | --- |
| Mutants | 146 | 146 |
| Killed | 93 | 140 |
| Survived | 41 | 4 |
| NoCoverage | 12 | 2 |
| Timeout / errors | 0 / 0 | 0 / 0 |
| Raw / covered score | 63.70% / 69.40% | 95.89% / 97.22% |
| Baseline tests | 38 | 69 |
| Stryker elapsed | 37 seconds | 35 seconds |

All 146 file/location/operator/replacement fingerprints and production source contents match exactly between these reports. Every original kill remains killed; 39 former survivors and eight formerly uncovered mutants are now killed. Two former survivors remain equivalent survivors, two formerly uncovered paths are now executed equivalent survivors, and the two decoder-catch mutations remain uncovered. All executed mutants completed at least one test; no kill relies on a Vitest timeout. An intermediate 28-case run recorded 138 Killed, 6 Survived and 2 NoCoverage in 36 seconds; the final three absolute-deadline cases kill the last two material survivors. These local timings are observations rather than a performance benchmark; the intermediate run overlapped the build.

The [durable classification](./mutation_testing_authentication_sessions_classification.json) includes exact fingerprints, report/input hashes, transitions and re-review conditions:

| Sample ID | Status | Classification |
| --- | --- | --- |
| 42 | Survived | Removing `combinedResolution?.account`'s optional chain is equivalent: this branch follows an active session obtained from the same defined snapshot. |
| 73, 74 | Survived | Removing the failed-schema early return is equivalent with the current Zod result contract: absent `data` reaches `assertClaimsSize(undefined)`, which throws and is caught, still returning anonymous access. |
| 77 | Survived | Removing the final catch's explicit `return undefined` leaves the same implicit async return. |
| 124 | NoCoverage | Emptying the token-decoder catch returns `undefined` rather than `false`; its sole negated consumer still refuses the token. The catch is not reached by ordinary primitive-string decoding. |
| 125 | NoCoverage | Returning `true` from that catch would change exceptional failure behavior, so this is **not equivalent**. Ordinary primitive strings, including malformed base64url, do not trigger a decoder exception. Unsupported runtime argument types and exceptional decoder/resource failures remain outside this assessment. |

Keep the four survivors and both uncovered statuses visible. No decoder mock, unsupported argument cast, ignore directive, adjusted score or blocking threshold is added to normalize the report. Re-review after changes to the manager's control flow, Zod failure shape, claims encoding, snapshot contract, token input type or Node decoder. Deliberate decoder fault injection and a possible runtime `unknown`-input contract are deferred; this result does not establish behavior for those cases.

Before reports and hashes are archived under `artifacts/mutation/authentication-sessions-before-tests/`; final reports, `review-comparison.json` and `classification.json` live under `artifacts/mutation/authentication-sessions/`. Validation passes 1,734 ordinary tests, framework typechecking and the build. The inventory records this manager sublot as reviewed with its limitation; the authentication component remains partial. The password verification and positive `allOf` cases were subsequently assessed in the [security and coordination follow-up](#security-and-coordination-follow-up). Adapter contracts, HTTP and other authentication modules still require their own assessments.

## Security and coordination follow-up

On November 10, 2026, five bounded profiles assessed the four planned workstreams: authorization decisions, password verification, PostgreSQL ownership operations, and coordination (split into leased throttling inspection and lock batch renewal). Each profile has its own reports/cache and a ten-minute budget including baseline tests. All reference/final runs were fresh, retained static activation, completed below that budget and cleaned their run-owned databases. Scores remain informational with no exclusions or blocking gate.

| Profile | Before Killed / Survived / NoCoverage | After Killed / Survived / NoCoverage | Raw score before → after | Seconds before → after | Baseline tests before → after |
| --- | --- | --- | --- | --- | --- |
| `authorization-decisions` | 31 / 2 / 0 | 33 / 0 / 0 | 93.94% → 100% | 11 → 11 | 9 → 13 |
| `password-verification` | 150 / 69 / 12 | 210 / 20 / 1 | 64.94% → 90.91% | 29 → 36 | 40 → 84 |
| `postgres-ownership` | 0 / 14 / 0 | 14 / 0 / 0 | 0% → 100% | 13 → 7 | 400 → 405 |
| `throttling-inspection` | 0 / 47 / 0 | 46 / 1 / 0 | 0% → 97.87% | 31 → 7 | 326 → 341 |
| `lock-renewal` | 31 / 19 / 27 | 72 / 2 / 3 | 40.26% → 93.51% | 16 → 8 | 132 → 142 |

These are selected-scope results, not framework or whole-component scores. All 402 file/location/operator/replacement fingerprints and production file contents match between reference and final reports. Every original kill remains killed, and every executed final mutant completes at least one test. There are no Stryker Timeout, compilation-error or runtime-error statuses. Some baseline tests are related across components; their counts should not be summed or interpreted as exactly the added cases. Timings are local observations, not a controlled performance benchmark. Intermediate runs overlapped small targeted checks; the final lock test improvement explains its shorter duration.

### Tests and observed behavior

The initial changes add 71 cases and strengthen one existing lock test; the native-error follow-up below adds three more cases. No production implementation changed and **no production bug was demonstrated**: the new tests distinguish previously undetected mutations from behavior that was already correct.

- **Authorization:** four cases cover fully granted `allOf` through both `check` and `require`, nested conjunction/disjunction, denial reasons, immutable decision identity and private permission snapshots. Both original material survivors are killed. Scope: the entire `authorization/manager.ts` file; requirement builders, provider/scoped stores and middleware implementations are not mutated.
- **Passwords:** 37 cases use real correct-password hashes at and immediately above five small verification budgets, verify matching/wrong/absent pepper, reject missing encoding anchors, validate generation settings and memory/lane boundaries, exercise native-valid hashes below Kestrel salt/tag minimums, and check reusable dummy hashes. Scope: the entire Argon2id hasher file. Small native costs keep the fixtures bounded; no production dependency or crypto mock is introduced.
- **PostgreSQL ownership:** five cases exercise activity retry dates, reservation clearing, stale/cross-task tokens, non-activity rejection and isolated server-clock lease extension. Scope: only workflow `retryTask` and scheduled-task `extendLease`. [Direct predicate assertions](./mutation_testing_postgres_ownership.md) supplement syntax-tree mutation: killing SQL literal mutations does not systematically challenge SQL/Lua semantics.
- **Throttling:** 15 cases cover authoritative reconciliation, unavailable capabilities/failures, local/exact mixed ordering, exact inspection on the same key as a warm local grant, advisory non-consumption, expired/exhausted leases, fractional inclusive tolerance, incomplete results and inspection after close. Scope: only leased `reconcile`/`inspectMany`; their unmodified helpers remain dependencies.
- **Locks:** ten cases cover rejected/incomplete/extra/mismatched/reordered extension batches, per-handle outcomes, ownership loss, publication of renewed leases, handler cancellation, cleanup and settlement of every fallback operation. Scope: only `extendMany` and `validateExtensionBatch`. An existing fallback test now releases its handler independently and asserts cancellation/error propagation, replacing four timeout-driven detections with direct assertions. Other acquisition/heartbeat/handle/adapter implementations are not mutated.

### Residuals and observation limits

The [comparison record](./mutation_testing_security_coordination_classification.json) contains input/report hashes and per-lot transitions. [Password classifications](./mutation_testing_password_verification_classification.json) and [lock classifications](./mutation_testing_lock_renewal_classification.json) retain exact expressions and re-review conditions. Numeric IDs below describe this report and are not stable identifiers.

- **Authorization and PostgreSQL:** no residual mutants in these declared scopes. Parent components remain partially assessed.
- **Throttling:** one survivor (ID 9) removes initial array preallocation. For ordinary dense request batches, all output indexes are filled locally or after a checked authoritative result count, so this does not change returned results. Sparse arrays/custom iteration and allocation-failure behavior are outside that classification. No capacity/performance guarantee is asserted.
- **Locks:** two survivors are equivalent under the current control flow and original manager-produced-handle composition: `errors.length > 1` after an earlier single-error throw, and the internal-handle type check. Three uncovered mutations concern the dormant unsupported-handle rejection/diagnostic and an impossible-success diagnostic after `completeExtension(undefined)` always throws. Substituted/custom handles are outside the assessment; these dormant guards are not all unconditional equivalents. The final report has zero timeout-driven kills.
- **Passwords:** the initial 24 residuals comprised 10 semantic equivalents, six bounded-work distinctions, five unconstrained literals (four diagnostic messages and the private dummy password), and three native callback-failure mutations. The latter three are now killed by the [native-error follow-up](#argon2id-native-error-propagation). The bounded-work distinctions preserve accept/reject outcomes but may decode or validate more before rejecting; the overall encoded-size cap still applies. They are **not** strict work equivalences. The initial callback-failure limitation has been closed with controlled module-level fault injection, without inducing resource exhaustion or changing production code.

Four final password `Killed` outcomes (IDs 75, 83, 89, 90) rely on Vitest's five-second deadline: the mutation leaves a derivation promise pending. They detect lost progress, not a particular value assertion, and are recorded separately from Stryker Timeout statuses. No timeout-driven kill remains in the other four profiles. Do not present all password kills as assertion detections or all residuals as equivalents.

All residual statuses remain visible, with no ignores or adjusted 100% score. Re-review after changes to the recorded source/test/configuration inputs and the native crypto, optional-secret, encoded-length or manager-handle contracts. The inventory now records nine partial primary components and 24 not-assessed components; this work does not certify the rest of any touched component. Validation passes 1,805 ordinary tests, framework typechecking, the framework/playground build and the Stryker infrastructure checks. An initial ordinary-suite attempt overlapped the build and temporarily lost generated playground imports; the sequential rerun passed.

### Argon2id native error propagation

The fresh profile completed in 36 seconds, below its ten-minute budget including the baseline, with no Stryker timeout or runtime/compilation error. Its timing overlapped the ordinary test suite and is not a performance comparison. The follow-up adds three cases in `native_errors.test.ts`, covering `hash`, `verify` and `getDummyHash`. Each uses a valid real hash, loads a fresh hasher through Vitest with only its `node:crypto` import mocked, and delivers a native callback failure asynchronously. After draining the injected callback and promise continuations through one event-loop turn, it asserts that the operation has settled with the exact original error. Missing rejection is an immediate failed settlement assertion, not a five-second test timeout. `finally` removes the mock and resets the module cache; a fresh import then performs a real hash/verification round trip. Node's crypto globals are not modified, and the ordinary suite verifies `--no-isolate` compatibility.

The archived pre-follow-up report is `artifacts/mutation/password-verification-before-native-errors/mutation.json`. The fresh complete profile keeps the same 231 mutation fingerprints and unchanged production file. It moves the error-condition mutant (85) from Survived to Killed and the omitted rejection block/call (87, 88) from NoCoverage to Killed. All three are killed by direct assertions in the new test file. Every previous kill is preserved; no other status changes.

| Result | Before native-error cases | After |
| --- | --- | --- |
| Killed | 207 | 210 |
| Survived | 21 | 20 |
| NoCoverage | 3 | 1 |
| Raw / covered score | 89.61% / 90.79% | 90.91% / 91.30% |
| Baseline tests | 81 | 84 |

The remaining 21 mutations comprise ten equivalents, six bounded-work distinctions and five unconstrained literals. The only NoCoverage mutation is the decoded-length rejection block already bounded by the encoded-field guards. Four unrelated success-path promise mutations still rely on Vitest progress timeouts; the new three failure-path kills do not. No ignored mutation, score adjustment or blocking gate is introduced.

No production bug was demonstrated: the current implementation already preserved native errors. Only tests and evidence changed. Validation passes 1,808 ordinary tests, framework typechecking and the framework/playground build. The dedicated classification and inventory record the current results and exact report/input hashes. The bounded-work observations remain outside output-only assertions; the callback-error propagation limitation is resolved.

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

**Historical observations:** shutdown, account/session management and the four security/coordination follow-ups now have reviewed selected-scope evidence above. The descriptions below explain the original findings; use the inventory and current follow-up sections for remaining scope and limitations.

### Application shutdown and concurrent stop

Several mutations remove ordinary failure collection from shutdown phases in `app/app.ts`, or let a second `stop()` caller return before the existing stop promise settles. Existing deadline tests do not distinguish every ordinary rejection because the deadline coordinator retains its own error separately.

Independent memory-only public-API probes compared the current implementation, an unchanged reference copy and exact source mutations. Removing error collection for a rejecting runtime-stop listener, transport drain or observation flush lets disposal resolve silently; the current implementation preserves the original cause and disposes an owned resource once. Removing the cached stop-promise return lets a second caller resolve while a gated first stop remains pending. These are confirmed missing regression scenarios, not defects observed in the current implementation.

Add ordinary rejection tests for each phase, asserting cause preservation, continued cleanup and final disposed state. Add a gated concurrent-stop test asserting that both callers remain pending until the same work completes.

### Authentication account state and positive authorization

**Manager follow-up completed:** the [account/session review](#authentication-account-and-session-review) now covers disabled accounts and account-wide revocation. The [security and coordination follow-up](#security-and-coordination-follow-up) also covers the password-verification and authorization cases. The observations below explain the original gaps, not current pending tasks.

Mutations of `authentication/manager.ts` can remove the active-account check when completing trusted proof or resolving an existing session. Independent public-API probes confirm that the current implementation refuses a disabled account, while the exact mutations create a session or authenticate the old session. Add account invalidation between proof creation and completion, and disable an account after issuing a valid session. Assert refusal and absence of a new session write.

The original `allOf` authorization tests lacked a positive case with every required permission granted. An exact mutation rejecting this branch survived those tests. The follow-up now asserts successful evaluation and enforcement alongside denial cases and kills this mutation.

Account-wide revocation is uncovered at the manager boundary. Test two sessions for one account and a session for another, checking account isolation, returned count, supplied reason and clock value. Claims-size tests should use valid variable-sized UTF-8 data at and immediately beyond the byte limit, rather than relying on schema-invalid values to reject before the size check.

The original Argon2id parameter-budget cases used nonmatching zero-filled tags, so bypassing a resource guard could still return false for the password. The follow-up now uses valid hashes at and above small limits and exercises pepper propagation. Bounded-work distinctions and native callback fault handling remain separately classified; the added fixtures do not establish all resource-failure behavior.

### Database-backed ownership and lease operations

The historical campaign lacked observed `retryTask()` coverage while exercising `retryExecution()`. The selected PostgreSQL follow-up now verifies the future availability time, cleared reservation and rejection of stale/cross-task tokens and non-activity tasks.

The historical campaign also lacked observed `extendLease()` coverage. The follow-up now verifies server-clock expiration, matching task/token ownership and preservation of unrelated reservations. Other scheduler ownership operations remain outside that scope.

### Leased throttling and partial lock failures

The original leased throttling inspection/reconciliation gaps are covered by the focused follow-up above, including mixed exact/leased ordering, warm-key exact requests, local capacity, expiry/exhaustion, fractional tolerance, unsupported capabilities and authoritative results. Other lease admission and lifecycle operations remain outside that mutation scope.

The original lock batch-extension failure gaps are now covered by backend rejection, malformed/incomplete results, settlement, cancellation and release assertions. The final assessment retains the documented handle-composition limitation and does not extend to every lock-manager or adapter method.

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

Shutdown, account/session management and the four security/coordination follow-ups now have reviewed selected-scope evidence above. Keep the documented residual limitations visible, then continue with the remaining adapter operations, faithful CRUD fakes and boundary cases below. Follow with faithful CRUD fakes and boundary tests. Treat browser interaction coverage and subprocess instrumentation as explicit workstreams: adding Node assertions alone cannot necessarily close those observation gaps. Pure collection, routing and API-response helpers can already receive focused Node tests. Keep every source component visible while investigating them.

There is no blocking mutation-score threshold. A meaningful future gate needs a completed reproducible campaign, separate review of static initialization errors and timeouts, and classification of material survivors. The original adapter/circuit pilot score is not comparable to this expanded scope. Pending work includes a complete fresh campaign under the optimized runner and guarded worker isolation, broader runtime measurements, subprocess coverage, browser interactions and TypeScript-checker compatibility. Do not merge historical checkpoint statuses into that fresh result merely because source mutations still have matching identifiers.
