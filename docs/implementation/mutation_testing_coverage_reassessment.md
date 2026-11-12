# Mutation reassessment after branch coverage

[Lot inventory](./mutation_testing_inventory.md) · [Contributor commands](../contributing/mutation-testing.md) · [Historical framework assessment](./mutation_testing_framework.md) · [Regression test follow-up](./mutation_testing_gap_followup.md)

The November 12, 2026 wave reassesses `throttling`, `authentication`, `tokens`, and `outbound_http` after the branch-coverage follow-ups at source and test revision `52ea51d3c8920ac303786133a72ac98acfa08de2`. The normal suite passed 3,458 tests in 309 files, and all 98 mutation infrastructure tests passed. The full Stryker dry run instrumented 634 candidate files, generated 43,782 mutants, and passed 3,436 framework baseline tests in 24 seconds. The dry run validates instrumentation and baseline execution. The component reports provide the mutation outcomes.

Named profiles retain static and hybrid mutants and enforce a ten-minute budget per execution, including the instrumented baseline. Reports are fresh and scores remain informational. Local artifacts under `artifacts/mutation/nov12-coverage-reassessment/` retain the individual reports, the scope audit and the machine-readable comparisons. The local `inputs.json` and `verified-results.json` record inputs and report hashes. Only completed, disjoint scopes contribute to component totals. Stryker includes its timeouts among detections and excludes runtime errors, compile errors and ignored mutants from its score. Vitest deadlines that Stryker reports as kills are counted separately in the analysis.

Historical mutants are paired by file, mutator, replacement and exact source span. The comparison uses identical coordinates for unchanged files and maps uniquely located unchanged line blocks across edits. Unpaired source changes and added mutation scopes are excluded from status transitions. An unchanged expression can still run with different dependencies or selected suites. Attributing gains specifically to the added tests requires comparing the test suites against a fixed production revision. Comparisons with the stopped November 9 campaign describe only the outcomes recorded before it stopped.

## Complete component baselines

The 22 executions cover all 126 candidate files in the four components, including type-only and re-export files that generate zero mutants. The scope audit verifies disjoint coverage against the mutations generated for each complete component. All runs finished within the budget. The longest took 236 seconds. The campaign kept 749 static or hybrid mutants in the 8,528 total outcomes. The inventory records these assessments as complete, with residual review pending.

| Component | Candidate files | Mutants | Killed | Survived | No coverage | Stryker timeout | Runtime error | Static or hybrid | Vitest deadline kills | Stryker score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `throttling` | 34 | 4,488 | 3,633 | 764 | 29 | 25 | 37 | 364 | 97 | 82.18% |
| `authentication` | 44 | 1,614 | 1,295 | 254 | 18 | 1 | 46 | 206 | 4 | 82.65% |
| `tokens` | 31 | 1,297 | 1,044 | 212 | 24 | 0 | 17 | 137 | 0 | 81.56% |
| `outbound_http` | 17 | 1,129 | 956 | 166 | 6 | 1 | 0 | 42 | 43 | 84.77% |

## Throttling

Of 273 circuit mutants in the November 9 pilot, 267 pair with the current manager. All 237 paired kills and 30 paired survivors retain their outcome. Six former kills sit on spans that cannot be paired after edits. The November 10 leased inspection and reconciliation sample pairs all 47 mutants and retains 46 kills and one survivor. The five static configuration samples also retain their four kills and one runtime error. The paired samples have no change in Vitest deadline detections. See the [circuit pilot](./mutation_testing_pilot.md) and [leased inspection reference](./mutation_testing_inventory.md#security-and-coordination-selected-lot-evidence).

The older interrupted framework checkpoint recorded 697 uncovered throttling mutants. Of the 691 that pair with the current component, 592 are killed (two by Vitest deadline), 70 survive after execution, and 29 remain uncovered. Six cannot be paired across edits. This is evidence of improved detection on the recorded overlap. The component's 4,488 current outcomes establish its first complete baseline.

The local concurrency cap has an actionable assertion gap. Mutants that remove the admission predicate in `throttling/manager.ts:1259` or replace `active >= limit` with `active > limit` survive. Tests verify that inspection reports the limit and that a waiting acquisition can finish after release. Assert that the second acquisition is denied in immediate mode, or stays pending in waiting mode while the first permit is held. The mutation that inverts the comparison is killed by a Vitest deadline. Controlled rejection and release assertions can exercise progress directly.

Two uncovered mutants in the conflicting-capacity error at `throttling/manager.ts:1249–1251` exercise a defensive branch. Policy registration compares the signatures for the same constraint key and rejects a conflicting limit before attempting concurrency admission. The public conflict test verifies that earlier check. This is distinct from the cap survivors on valid registered policies.

The PostgreSQL adapter also retains denial-response gaps. In `throttling/adapters/postgres/adapter.ts:1035–1044`, mutations can remove or invert the filter that selects denied dimensions for the retry date, or discard the entries of the remaining-budget map. Two arithmetic mutations in `calculateWaitMs` also survive. A batch with one admitted dimension, two denied dimensions with distinct refill rates, and a fixed clock can verify the exact remaining budgets and latest retry date. The current profile also reports deadline kills in the PostgreSQL reservation gate. Those outcomes detect a loss of progress, while the gate's exact admission and settlement rules need direct assertions.

Shutdown ordering remains worth asserting. Dropping all queue drain promises from `ThrottlingManager.close()` survives (`throttling/manager.ts:496–498`). The queued-reservation test checks the resulting rejection of both waiters, but releases the in-flight adapter operation immediately after calling `close()`. A gated test can observe that neither adapter closure nor the manager close promise completes before that operation settles.

The denial-cache wrapper still permits a mutation that reuses a cached single denial after the same key's request signature changes (`throttling/adapters/denial_caching/adapter.ts:282`). The batch-cache expiry comparison can also change from strict to inclusive. Verify a same-key request with a changed cost and a batch lookup exactly at expiry so a cached result cannot reject new work on stale inputs.

The queue profile reports 20 Stryker timeouts, including 19 execution hit limits. It also reports 35 Vitest deadline kills and two runner crashes with a serialization error when the queue-empty check is removed or inverted before restarting the drain. These results highlight where controlled progress and settlement assertions would improve the evidence. Six static runtime errors come from invalid Zod union construction in configuration and the Redis adapter. The PostgreSQL schema accounts for 29 more static runtime errors, mostly from removing mandatory table or column descriptions at import.

The leased adapter tests detect removing the post-allocation expiry check and skipping the error when local capacity is lost. The same profile still reports five Stryker timeouts and 42 Vitest deadline kills, including some mutations affecting lock and shutdown progress. Removing the cached close-promise check survives (`throttling/adapters/leased/adapter.ts:241`). Concurrent calls should share one shutdown and close the authoritative backend once.

## Authentication

The exact November 10 manager and Argon2id profiles reproduce all 377 outcomes. The manager remains at 140 kills, four survivors and two uncovered decoder-catch mutants under the documented primitive-string input domain. The Argon2id adapter remains at 210 kills, including four Vitest deadline kills, 20 survivors and one uncovered mutant. The native error propagation detections are retained. See the [manager review](./mutation_testing_framework.md#authentication-account-and-session-review) and [Argon2id follow-up](./mutation_testing_framework.md#argon2id-native-error-propagation).

The most important new survivor is the password verification guard in `authentication/mechanisms/password/mechanism.ts:58`. Replacing `!verified || credential === undefined` with `&&` would allow a known username with a wrong password to reach trusted-proof creation. Existing negative cases use a missing username or an oversized password. A sign-in test with a registered account and a wrong password should assert the generic 401 response and the absence of both a session cookie and a new stored session. This is a regression the tests could miss if introduced.

The rate-limit error's HTTP representation has four uncovered mutants (`authentication/errors.ts:78–82`). The guard tests verify the exception class. An injected throttled sign-in can also verify the public 429 status and generic response body. The eight historical cookie configuration samples retain their kills in the current profile.

All 1,408 authentication observations from the stopped framework checkpoint pair with the new assessment. Of the old survivors, 231 are now killed and 123 remain. Of the previously uncovered mutants, 141 are killed, 18 now execute and survive, and 18 remain uncovered. None of those new kills report a Vitest deadline. The 877 prior kills yield 876 current kills and one Stryker timeout when the password sign-in action definition is emptied (`authentication/actions.ts:51`). The four old Vitest deadline kills remain deadline kills. The remaining 206 outcomes are outside this checkpoint, including static import failures. The complete authentication component reports 46 static runtime errors, 44 of them in the PostgreSQL schema.

## Tokens

This wave establishes the first complete token reference. The stopped framework checkpoint has only 110 uncovered observations in the component. All pair with the current source, where 84 are killed, two now execute and survive, and 24 remain uncovered. The current assessment records no Stryker timeouts or Vitest deadline kills. The 17 runtime errors are static PostgreSQL schema mutations.

The remaining behavioral gaps include PostgreSQL `revoke`, `revokeForSubject` and `deleteForSubject` (`tokens/adapters/postgres/adapter.ts:93–130`). Mutations in those methods are uncovered. Integration cases can assert affected-row counts and verify that a different definition or subject keeps its tokens. For revocation, check that consumed, expired and already-revoked tokens are excluded as specified. Stryker does not systematically mutate SQL predicates, so the database tests need those assertions directly.

Two token validation contracts also need direct cases. The JWT profile check can stop comparing `nbf` with `iat` without detection, and the inclusive maximum lifetime can become exclusive (`tokens/strategies/jwt/codec.ts:233–253`). Use a correctly signed token with distinct but otherwise valid time claims and a token at the configured lifetime limit. The hybrid strategy retains survivors that independently drop the persisted expiration, creation-time or subject match with signed metadata (`tokens/strategies/hybrid/strategy.ts:171–173`). A lifecycle row differing in exactly one field can verify rejection for each mismatch.

## Outbound HTTP

The historical resilience profile matches all 348 mutants and reproduces the same raw counts of 313 kills, 33 survivors, one uncovered mutant and one Stryker hit-limit timeout. Of the 313 kills, 30 remain Vitest deadline kills and 278 remain kills without a reported Vitest deadline. Five kills previously reported as assertion failures now report a Vitest deadline as the first failure. Four of those changes occur in the body budget and one in the deadline code.

Of 182 uncovered mutants in the stopped framework checkpoint, 178 pair with the current component. 148 are now killed (two by Vitest deadline), 24 execute and survive, and six remain uncovered. Four cannot be paired across edits. The full wave adds the client, response types, configuration, middleware composition, cache and throttling integration to the earlier resilience scope.

The cache restoration size check can be removed without detection (`outbound_http/middleware/cache/index.ts:193–194`). The client also guards its response body. A cache middleware test with a seeded oversized entry can verify rejection at the earlier resource boundary before restoration allocates a decoded buffer.

The standalone middleware runner retains a survivor that drops both abort signals from a replacement request (`outbound_http/middleware.ts:69–72`). The current standalone test asserts the replacement URL and attempt. A direct runner test should assert propagation from each source signal independently. The full client also attaches the execution deadline at its fetch terminal, which can preserve end-to-end cancellation when the middleware-level behavior is mutated.

Structured URL validation has overlapping guards. Mutations that remove the absolute/network-path check survive because the later origin check still rejects external origins. Absolute and network-path inputs using the configured origin can distinguish the relative-only template contract (`outbound_http/client.ts:541`).

A separate unmodified-code reproduction canceled a caller after the fetch attempt started. The caller received `OutboundHttpAbortedError`, and the throttling policy changed from available to limited with `failureThreshold: 1`. The local reproduction is `artifacts/mutation/nov12-coverage-reassessment/reproduce-outbound-abort-circuit.mjs`. Throttling documents that an unclassified failed completion counts as transient, and outbound HTTP documents typed caller cancellation. The effect of caller cancellation on partner health still needs an explicit policy for this composition. [Throttling feedback](./throttling.md) · [Outbound HTTP middleware](./outbound_http.md)

## Profile executions

Times are the reported Stryker durations, rounded to seconds. The campaign elapsed time reflects concurrent execution of profiles within each component and isolated databases for their workers. There were zero compile errors and zero ignored mutations in these profiles.

| Profile | Killed | Survived | No coverage | Stryker timeout | Runtime error | Static or hybrid | Vitest deadline kills | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `throttling-admission` | 441 | 127 | 3 | 0 | 0 | 0 | 6 | 193 |
| `throttling-queues` | 105 | 51 | 2 | 20 | 2 | 0 | 35 | 162 |
| `throttling-circuits` | 261 | 30 | 2 | 0 | 0 | 0 | 1 | 88 |
| `throttling-completion` | 438 | 75 | 1 | 0 | 0 | 0 | 1 | 147 |
| `throttling-postgres-admission` | 291 | 38 | 4 | 0 | 0 | 0 | 8 | 115 |
| `throttling-postgres-leases` | 258 | 34 | 2 | 0 | 0 | 0 | 0 | 96 |
| `throttling-leased` | 386 | 72 | 2 | 5 | 0 | 0 | 42 | 198 |
| `throttling-adapter-wrappers` | 391 | 71 | 2 | 0 | 0 | 0 | 2 | 83 |
| `throttling-storage` | 366 | 101 | 5 | 0 | 3 | 30 | 2 | 151 |
| `throttling-contracts` | 313 | 110 | 0 | 0 | 32 | 311 | 0 | 236 |
| `throttling-provider` | 383 | 55 | 6 | 0 | 0 | 23 | 0 | 97 |
| `authentication-sessions` | 140 | 4 | 2 | 0 | 0 | 0 | 0 | 45 |
| `password-verification` | 210 | 20 | 1 | 0 | 0 | 3 | 4 | 41 |
| `authentication-adapters` | 412 | 144 | 10 | 0 | 44 | 163 | 0 | 180 |
| `authentication-http` | 228 | 37 | 0 | 0 | 1 | 4 | 0 | 74 |
| `authentication-contracts` | 305 | 49 | 5 | 1 | 1 | 36 | 0 | 116 |
| `tokens-adapters` | 357 | 94 | 18 | 0 | 17 | 76 | 0 | 85 |
| `tokens-strategies` | 339 | 77 | 0 | 0 | 0 | 19 | 0 | 54 |
| `tokens-contracts` | 348 | 41 | 6 | 0 | 0 | 42 | 0 | 77 |
| `outbound-resilience` | 313 | 33 | 1 | 1 | 0 | 7 | 35 | 185 |
| `outbound-client` | 341 | 80 | 5 | 0 | 0 | 12 | 4 | 142 |
| `outbound-contracts` | 302 | 53 | 0 | 0 | 0 | 23 | 4 | 114 |
