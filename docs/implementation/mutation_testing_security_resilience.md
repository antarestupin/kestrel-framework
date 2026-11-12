# Security and resilience mutation review

[Lot inventory](./mutation_testing_inventory.md) · [Framework assessment](./mutation_testing_framework.md) · [Running mutation tests](../contributing/mutation-testing.md)

On November 12, 2026, this review assessed all runtime sources selected for authentication, tokens, throttling and outbound HTTP. Each profile ran with static mutants enabled and a 600-second wall-clock budget, including its initial test run. The before and after runs used the same operators and freshly evaluated their mutants. The 95% target is informational and applies to each component's aggregate.

The instrumenter verified that the profiles partitioned all 126 candidate files. This includes the password hasher's Kestrel wrapper, generated schema declarations, and TypeScript wrappers for storage protocols. Stryker can replace complete SQL or Lua strings but does not systematically mutate their internal semantics. Tests against PostgreSQL and Redis exercise the affected atomicity, admission, revocation and schema behavior directly. Outbound tests use injected fetch and controlled streams.

Two larger attempts reached the wall-clock budget. Authentication's adapters were split into the PostgreSQL schema and adapter runtime. Throttling's contracts were split into definition factories, definition validation, the PostgreSQL schema and the remaining public contracts. Partial checkpoints remain in the local archive. The comparison uses fresh complete pairs for the smaller partitions.

## Results

The completed runs compare 8,070 unchanged mutant fingerprints out of 8,528 baseline and 8,647 final mutants. Stryker classified 751 baseline and 769 final mutants as static or hybrid. The longest completed run took 548 seconds.

Among paired mutants, 811 prior survivors and 32 previously uncovered mutants are killed in the final reports. Stryker includes individual execution timeouts as detections and excludes runtime errors from its score. A profile stopping at its wall-clock deadline is partial evidence.

The final reports contain 27 Stryker timeouts and 94 outcomes marked killed after a Vitest test deadline. The latter indicate a failure to make progress within the test budget. Two previously killed authentication Action mutations now survive because the manager independently filters undefined IP address and user agent metadata. Two throttling definition mutations detected by a validation error in the baseline are now detected by execution timeouts.

| Component | Paired mutants | Before K / S / NC / T / RE | After K / S / NC / T / RE | Stryker score |
| --- | ---: | --- | --- | --- |
| `authentication` | 1544 | 1326 / 228 / 14 / 0 / 46 | 1575 / 48 / 0 / 0 / 46 | 84.57% → 97.04% |
| `tokens` | 1221 | 1108 / 166 / 6 / 0 / 17 | 1249 / 36 / 2 / 0 / 17 | 86.56% → 97.05% |
| `throttling` | 4292 | 3699 / 702 / 29 / 23 / 35 | 4162 / 268 / 17 / 26 / 35 | 83.58% → 93.63% |
| `outbound_http` | 1013 | 973 / 149 / 6 / 1 / 0 | 1112 / 52 / 1 / 1 / 0 | 86.27% → 95.45% |
| **Fourth lot** | 8070 | 7106 / 1245 / 55 / 24 / 98 | 8098 / 404 / 20 / 27 / 98 | 84.58% → 95.04% |

## Profile executions

| Profile | Before mutants | After mutants | Paired | Before seconds | After seconds | Stryker score |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `authentication-sessions` | 146 | 172 | 132 | 74 | 154 | 95.89% → 97.09% |
| `password-verification` | 231 | 221 | 212 | 68 | 79 | 90.91% → 96.83% |
| `authentication-adapters-postgres-schema` | 145 | 145 | 145 | 211 | 239 | 0.00% → 83.17% |
| `authentication-adapters-runtime` | 465 | 471 | 448 | 338 | 352 | 90.97% → 98.30% |
| `authentication-http` | 266 | 269 | 264 | 187 | 344 | 89.06% → 98.13% |
| `authentication-contracts` | 361 | 391 | 343 | 201 | 483 | 88.06% → 98.46% |
| `tokens-adapters` | 486 | 479 | 452 | 191 | 272 | 78.89% → 96.32% |
| `tokens-strategies` | 416 | 425 | 397 | 108 | 170 | 89.42% → 96.94% |
| `tokens-contracts` | 395 | 400 | 372 | 173 | 300 | 92.66% → 98.00% |
| `throttling-admission` | 571 | 559 | 497 | 366 | 205 | 78.46% → 92.13% |
| `throttling-queues` | 180 | 162 | 134 | 166 | 162 | 77.22% → 85.19% |
| `throttling-circuits` | 293 | 293 | 293 | 151 | 112 | 90.44% → 90.78% |
| `throttling-completion` | 514 | 529 | 490 | 548 | 193 | 85.60% → 95.84% |
| `throttling-postgres-admission` | 333 | 333 | 333 | 160 | 329 | 90.69% → 95.20% |
| `throttling-postgres-leases` | 294 | 303 | 275 | 145 | 331 | 90.14% → 96.04% |
| `throttling-leased` | 465 | 489 | 451 | 143 | 236 | 84.52% → 92.43% |
| `throttling-adapter-wrappers` | 464 | 466 | 446 | 128 | 188 | 85.34% → 91.85% |
| `throttling-storage` | 475 | 475 | 474 | 524 | 530 | 77.54% → 94.70% |
| `throttling-provider` | 444 | 444 | 444 | 286 | 350 | 88.96% → 93.69% |
| `throttling-definitions-factories` | 118 | 118 | 118 | 237 | 193 | 89.83% → 99.15% |
| `throttling-definitions-validation` | 181 | 181 | 181 | 250 | 391 | 86.74% → 100.00% |
| `throttling-schema` | 77 | 77 | 77 | 228 | 123 | 0.00% → 77.08% |
| `throttling-public-contracts` | 79 | 79 | 79 | 226 | 51 | 65.79% → 100.00% |
| `outbound-resilience` | 348 | 334 | 322 | 168 | 162 | 90.23% → 94.91% |
| `outbound-client` | 426 | 444 | 393 | 215 | 146 | 81.69% → 95.95% |
| `outbound-contracts` | 355 | 388 | 298 | 253 | 118 | 87.89% → 95.36% |

The local archive records the input manifest, the report hashes and the exact comparison. Every baseline report matches the selected sources and related test snapshots from the initial revision. The final reports match the current production source within each selected file or range. The comparison also identifies related test files that changed after individual final runs.

The throttling storage report predates the final PostgreSQL factory and Redis arithmetic assertions. Those assertions passed in the targeted and ordinary test suites.

## Authentication

Session inspection now sends `Cache-Control: no-store` with the authenticated principal and claims. HTTP tests compare the status and body for a known account with an incorrect password and an unknown account, verify that neither creates a cookie or a session, and check that neither triggers password rehashing. These assertions cover the observable HTTP response.

Password sign-in now binds the verified credential to an account security version. The regression cases control resets while verification is pending, after proof creation, and during application claims computation. Successful verification reads the current account and credential. The manager rechecks account state and version after persistence before exposing the grant. A stale row is revoked, and a failed recheck or revocation cannot expose a token. An explicit allowlist also prevents attempt metadata from overwriting the verified account, claims or token digest.

Memory storage now advances the security version when re-enabling an account and copies nested claims and revocation dates at its persistence boundary. Session touches in memory and PostgreSQL keep last-seen and idle-expiry watermarks monotonic and respect the absolute expiry. PostgreSQL preserves supplied revocation metadata when inserting a session and respects the application's column defaults when the values are omitted. The Redis script rejects unsupported operation names before reaching account-wide revocation. The manager returns parsed claims after a touch, including for adapters that retain a legacy representation. The Argon2id hasher snapshots supplied pepper bytes, so clearing the caller's input buffer cannot invalidate subsequent verification.

## Tokens

Direct memory and PostgreSQL prune operations validate their limits before touching storage. Invalid negative or non-finite limits could previously remove eligible tokens. A memory issuance batch now snapshots every payload before applying replacements or inserting records, so an uncloneable item cannot partially apply the batch. PostgreSQL replaces each subject at its own recorded time in a mixed-time batch.

Redis consumption and subject revocation now check that an indexed record still matches the digest or subject before changing it. The provider honors hybrid-only configuration and the manager resolves only explicitly registered strategies. JWT validation rejects expiry values outside the JavaScript date range, issuance rejects dates its own verifier would reject, and keyring snapshots preserve the values of supported getter-backed descriptors.

## Throttling

PostgreSQL and Redis reserve an oversized lease request exactly when its cost exceeds the maximum individual grant. The old branch could admit the operation and charge only the smaller grant. PostgreSQL also accepts a return-only allocation with no new requests and returns unused quota once. A two-connection test confirms that a refund waiting for a bucket lock preserves a newer refill timestamp and the reconciled balance. Moving the timestamp back could credit the same interval again. Inspection of disabled and zero-cost rate constraints skips authoritative storage.

The manager now handles caller cancellation as neutral circuit feedback, releases half-open probes, and preserves queued callers' opportunity to proceed. A full global queue no longer creates an empty policy queue with a stale deadline. A new waiter joining an empty queue while the previous drain finalizes uses the fresh denial's retry time and blocker. The controlled regression delays the first retry to 1,000 ms, cancels the first waiter at 10 ms and verifies that the next waiter retries at its own 10 ms deadline. Long waits use bounded timer intervals so a valid delay above Node's timer limit does not become repeated one-millisecond wakeups. Closing publishes the shared result before waking sleepers, so reentrant cancellation handlers cannot start a second adapter teardown. Lease return and close failures are both preserved. Completion preserves a rejection with an undefined reason and aggregates distinct operation and reconciliation errors.

Both denial caches snapshot retry dates and remaining quota on insertion and give each caller its own result. Previously, an authoritative response or a later cache hit exposed objects that could overwrite the denial metadata seen by other calls. The leased cache also allows new attempts after emergency-local denials so healthy storage can resume admission immediately.

## Outbound HTTP

Structured URL templates reject authority-like syntax before transport. Tests reproduce paths reinterpreted as an authority through a backslash, ASCII control characters, or an empty leading segment created by interpolation. Error body decoding now recognizes the JSON media type case-insensitively and ignores content-type parameters when classifying it. A failing optional observation dependency leaves explicit instrumentation and client creation usable.

Retry and throttling agree on [`Retry-After` syntax](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3). Invalid delay values formerly accepted by the JavaScript date parser use the configured fallback. A retry requests cancellation of a discarded response without waiting for an injected stream's pending cancellation promise.

A cancelled HTTP caller releases throttling capacity without recording a dependency failure. A cancelled cache load owner or one exceeding its own byte budget no longer makes active coalesced callers inherit that failure. The tests include a signal attached to a replacement request and hold the owner and a waiter at explicit checkpoints to verify that the waiter makes its own attempt. Concurrent continuations that reuse the same native request also keep their unsuccessful response streams separate.

## Interpreting the remaining mutants

- **Authentication.** PostgreSQL schema survivors include empty explicit column names and timestamp modes for which Drizzle chooses the same defaults. Invalid static schema declarations still cause module initialization errors. The Argon2id parser has early guards whose outcomes are covered by the validated numeric bounds before native code. The fixed native callback failure cases continue to preserve their original error.
- **Tokens.** Nine static storage survivors use equivalent Drizzle column-name and date-mode defaults. The two uncovered PostgreSQL and Redis revoked-time conversions are outside the active lookups, which exclude revoked records. JWT survivors include defensive checks followed by JOSE rejection and alternative representations of omitted options.
- **Throttling.** Queue and circuit mutants include alternate generation counters and guards for state transitions already excluded by the manager's invariants. The manager rejects a conflicting registered concurrency limit before the state-level check can report it. Optional pressure signal defaults follow a denial shape that already supplies the signal IDs. Schema survivors use Drizzle's implicit names or default date mode. Some queue mutants affect the number or timing of backend probes, and execution timeouts record lost progress separately from assertion failures. Storage tests verify selected SQL and Lua behavior against live test backends. Native event-loop histogram shutdown remains indirectly tested through the Node reader and pressure monitor.
- **Outbound HTTP.** Remaining variants include defensive duplicate checks on signals and stream ownership, internal diagnostics, and omitted-versus-undefined option representations. The retry loop's fallback error is uncovered because the final validated attempt returns its response or throws. The decrementing attempt counter is detected by Stryker's mutation hit limit. Cache verification uses the local single-flight implementation with injected transport.

The reported scores use Stryker's raw counts. Backend defaults, lifecycle invariants and supported inputs define the scope of equivalent behavior.

## Validation

`npm run test:ai` passed 4,354 tests in 350 files with `--no-isolate`. The final outbound HTTP runs restore fake-clock spies before reinstalling real timers. This removed two Vitest deadline detections from the preliminary result. Both variants survive under the existing cancellation invariants. A pre-aborted operation is rejected by the initial deadline check, and internal calls to read the cancellation error follow a signal with an abort reason. The mutation infrastructure passed 137 checks. Framework typechecking, the framework and playground build, the ownership-boundary check and the inventory check also passed.
