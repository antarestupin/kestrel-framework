# Mutation follow-up for authentication, throttling, tokens and outbound HTTP

[Lot inventory](./mutation_testing_inventory.md) · [November 12 component baselines](./mutation_testing_coverage_reassessment.md) · [Contributor commands](../contributing/mutation-testing.md)

This follow-up reruns 18 profiles from the November 12 component baselines after changes to the tests. It matches all 7,221 mutants by file, source span, operator and replacement. The compared reports use identical production source and Stryker configuration. Each rerun keeps static and hybrid mutants, including 405 across the selected profiles. Each uses a ten-minute budget and an informational score. The longest finished in 261 seconds. The local reports and fingerprint comparison are archived under `artifacts/mutation/nov12-gap-followup/`.

The four unchanged profiles, `authentication-sessions`, `password-verification`, `throttling-contracts` and `throttling-storage`, retain their November 12 evidence. The table measures the rerun scopes. The inventory records the outstanding review of survivors.

The full suite passed 3,505 tests across 309 files. All 98 mutation infrastructure tests passed. The archived reports contain the test sources from the final working tree.

## Results

| Component | Matched mutants | Killed | Survived | No coverage | Stryker timeout | Runtime error | Vitest deadline kills |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `authentication` | 1,237 | 945 → 976 | 230 → 204 | 15 → 11 | 1 → 0 | 46 → 46 | 0 → 0 |
| `throttling` | 3,558 | 2,954 → 3,020 | 553 → 491 | 24 → 24 | 25 → 23 | 2 → 0 | 95 → 53 |
| `tokens` | 1,297 | 1,044 → 1,108 | 212 → 166 | 24 → 6 | 0 → 0 | 17 → 17 | 0 → 0 |
| `outbound_http` | 1,129 | 956 → 973 | 166 → 149 | 6 → 6 | 1 → 1 | 0 → 0 | 43 → 32 |
| Total | 7,221 | 5,899 → 6,077 | 1,161 → 1,010 | 69 → 47 | 27 → 24 | 65 → 63 | 138 → 85 |

Tests now kill 153 former survivors and 20 formerly uncovered mutants. Six former Stryker timeouts now fail tests without a Vitest deadline. One previous kill is now detected by Stryker's execution limit, and two prior runtime errors now hit the same limit in the queue profile. Fifty-six mutants previously first reported by a Vitest deadline now fail without a deadline. Three move the other way, all in the throttling queue profile. Vitest deadline kills are included in the Killed column.

## Authentication

The first test signs in through Fastify injection with a registered account and a wrong password. It asserts the generic 401 response, an absent session cookie and an empty session store for that account. In the first rerun, the mutation that replaces `!verified || credential === undefined` with `&&` in `authentication/mechanisms/password/mechanism.ts` fails with an HTTP 200 instead of the expected 401. The final rerun also kills it through a password mechanism case where a custom hasher accepts its dummy hash for a missing user. Other mechanism tests exercise the maximum-length boundary, bounded dummy verification above that boundary and suppression of unnecessary rehashing. The rate-limit HTTP test exercises the generic 429 response without looking up credentials or creating a session.

In `authentication-http`, the IP quota test asserts that exhausting one IP's quota preserves another IP's allowance. The origin test checks a configured HTTPS origin among several trusted origins. Sign-out now asserts its `Cache-Control: no-store` header. Together these kill eight former survivors. In `authentication-contracts`, seven former survivors and all four previously uncovered 429 response mutants now fail. The empty sign-in action definition mutant was previously a Stryker timeout and now throws during a test.

The memory adapter tests exercise per-account security versions, session listing across accounts and an absolute expiry boundary with a later idle expiry. The composed adapter test checks that security-version changes reach the base store and session operations reach the selected session store. Eight memory adapter mutants and three composed adapter mutants move from survived to killed. The PostgreSQL provider and production-migration schema still need their own integration fixture. The existing adapter cases supply the adapter with dedicated test tables.

## Throttling

Manager tests attempt admission at the exact local concurrency cap, verify that independent limits retain separate capacity, and verify that a later rejection returns a half-open probe. The queue cases cover a later caller with an earlier deadline, slot reclamation after abort and success, listener removal, and shutdown ordering while an adapter reservation is in flight. They kill twelve queue survivors. Three prior queue kills now first fail by Vitest deadline, covering wake-time arithmetic and a suppressed waiter rejection. Two mutants of the queue-empty condition previously caused runtime errors and now hit Stryker's execution limit. In the completion profile, emptying the manager's clock reader also hits that limit before the existing invalid-clock assertion reports a failure.

PostgreSQL cases check queued reservation handoff after expiry, exact remaining budgets and retry dates for rejected atomic batches, and the guard-band boundary for leases. A separate client holds an existing bucket row locked while the adapter requests a lease, exercising the shared capacity decision across connections. These cases kill eleven previous admission survivors and seven previous lease survivors. The cache wrapper checks the complete cached denial and consults storage for a changed cost or at exact expiry, killing five previous survivors.

The leased wrapper exercises memoized shutdown and batches that supply the same keys in reverse order. Two former survivors now fail, and all five Stryker timeouts now fail without a Vitest deadline. Forty mutants previously first reported as deadline kills now fail an assertion. The controlled lease fixture observes reservation and closure while a grant is held, then releases it to check return and backend close ordering.

Resource pressure cases combine independent signal readers with different refresh deadlines and separate hysteresis for constraints sharing one signal. Provider tests check the scheduling and dependency metadata for maintenance. The provider profile kills twelve former survivors.

## Tokens

The hybrid strategy rejects a correctly signed token if the persisted record differs independently in subject, creation time or expiry. It also validates the signed hybrid marker shape, including primitive payloads. JWT tests re-sign malformed time and identity claims, and exercise exact lifetime and serialized-length boundaries. In `tokens-strategies`, all 33 new kills come from former survivors, including the three dropped persisted-state comparisons.

PostgreSQL lifecycle cases exercise single revocation and bulk revocation and deletion. They check exact affected counts, isolation by token definition and subject, and the treatment of expired, consumed and revoked records. Twelve previously uncovered mutants and one former survivor are killed in `tokens-adapters`. Manager tests exercise strategy capabilities and enforce the exact UTF-8 payload budget. Stryker mutates the TypeScript surrounding SQL strings. The integration assertions verify the stored lifecycle and isolation behavior directly.

Six uncovered adapter mutants remain. Four are in the PostgreSQL adapter factory. The other two mutate mapping of `revokedAt` in PostgreSQL and Redis lookup results. Both stores filter revoked rows before returning them from a lookup or consume operation, so ordinary lifecycle tests cannot exercise those mapping branches.

The first `tokens-contracts` rerun lost detection of the stored strategy's exact byte-length guard. Truncating a random bearer can also make the encoding noncanonical, which the unchanged round-trip check rejects independently. The fixture now encodes a fixed short byte array, and the final report preserves the previous detection. A stored-strategy pruning test verifies the advertised capability, affected count and retained token. Two previously uncovered catch-block mutants now run and survive. An empty serialization catch falls through to the same error when the encoding is undefined. An empty resolved-payload catch still yields undefined from the asynchronous function.

## Outbound HTTP

The outbound tests exercise cache restoration directly at the decoded byte limit with each base64 padding length. An oversized cache hit now checks that decoding never runs. The standalone middleware runner propagates either abort source into a replacement request. A queued admission can also be canceled by its configured signal while the owning request remains active. These cases kill seven former cache survivors, two replacement request mutants and one admission signal mutant. Structured calls reject both absolute and network-path route templates that resolve to the configured origin, killing seven more survivors. A previously deadline-detected mutation that drops the request's explicit signal now first fails a transport error assertion.

The body tests use pre-buffered chunks and controlled settlement checks. A discarded error-body suffix and an oversized decoded response must settle while the source is still open. The stalled-body test observes rejection at the simulated deadline. All 348 raw `outbound-resilience` statuses stay the same. Ten kills formerly first reported by a Vitest deadline now fail an assertion, including all five body and deadline mutants whose first-failure evidence weakened in the previous wave.

The uncovered retry diagnostic is after the attempt loop. The validated attempt count is positive and the final iteration returns the response or throws the attempt error. One timeout in that profile comes from Stryker's execution-hit limit.

Caller cancellation after the transport starts remains a contract question. An unclassified failed completion counts as transient, while permanent feedback resets the closed circuit's failure count and counts toward half-open recovery. A neutral completion would require releasing the permit and waking any eligible waiter while preserving circuit health counters. [Prior reproduction](./mutation_testing_coverage_reassessment.md#outbound-http)

## Profile executions

Times are the reported Stryker durations for the final reruns, rounded to seconds.

| Profile | Mutants | Killed | Survived | No coverage | Stryker timeout | Runtime error | Vitest deadline kills | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `authentication-adapters` | 610 | 412 → 423 | 144 → 133 | 10 → 10 | 0 → 0 | 44 → 44 | 0 → 0 | 238 |
| `authentication-http` | 266 | 228 → 236 | 37 → 29 | 0 → 0 | 0 → 0 | 1 → 1 | 0 → 0 | 90 |
| `authentication-contracts` | 361 | 305 → 317 | 49 → 42 | 5 → 1 | 1 → 0 | 1 → 1 | 0 → 0 | 158 |
| `throttling-admission` | 571 | 441 → 448 | 127 → 120 | 3 → 3 | 0 → 0 | 0 → 0 | 6 → 5 | 261 |
| `throttling-queues` | 180 | 105 → 117 | 51 → 39 | 2 → 2 | 20 → 22 | 2 → 0 | 35 → 36 | 180 |
| `throttling-circuits` | 293 | 261 → 265 | 30 → 26 | 2 → 2 | 0 → 0 | 0 → 0 | 1 → 0 | 108 |
| `throttling-completion` | 514 | 438 → 439 | 75 → 73 | 1 → 1 | 0 → 1 | 0 → 0 | 1 → 0 | 219 |
| `throttling-postgres-admission` | 333 | 291 → 302 | 38 → 27 | 4 → 4 | 0 → 0 | 0 → 0 | 8 → 8 | 162 |
| `throttling-postgres-leases` | 294 | 258 → 265 | 34 → 27 | 2 → 2 | 0 → 0 | 0 → 0 | 0 → 0 | 124 |
| `throttling-leased` | 465 | 386 → 393 | 72 → 70 | 2 → 2 | 5 → 0 | 0 → 0 | 42 → 2 | 108 |
| `throttling-adapter-wrappers` | 464 | 391 → 396 | 71 → 66 | 2 → 2 | 0 → 0 | 0 → 0 | 2 → 2 | 97 |
| `throttling-provider` | 444 | 383 → 395 | 55 → 43 | 6 → 6 | 0 → 0 | 0 → 0 | 0 → 0 | 191 |
| `tokens-adapters` | 486 | 357 → 370 | 94 → 93 | 18 → 6 | 0 → 0 | 17 → 17 | 0 → 0 | 136 |
| `tokens-strategies` | 416 | 339 → 372 | 77 → 44 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 76 |
| `tokens-contracts` | 395 | 348 → 366 | 41 → 29 | 6 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 127 |
| `outbound-resilience` | 348 | 313 → 313 | 33 → 33 | 1 → 1 | 1 → 1 | 0 → 0 | 35 → 25 | 198 |
| `outbound-client` | 426 | 341 → 348 | 80 → 73 | 5 → 5 | 0 → 0 | 0 → 0 | 4 → 3 | 201 |
| `outbound-contracts` | 355 | 302 → 312 | 53 → 43 | 0 → 0 | 0 → 0 | 0 → 0 | 4 → 4 | 150 |
