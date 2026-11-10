# Mutation testing pilot: first baseline

[Testing implementation](./testing.md#mutation-testing-pilot) · [Contributor guide](../contributing/mutation-testing.md#run-the-mutation-testing-pilot)

This document records the historical adapter/circuit pilot. The current [framework-wide configuration](./testing.md#framework-mutation-testing) includes all framework components and integration suites, with no score threshold. The former 88% floor and pilot scores below no longer describe the current command. The last pilot reports were preserved as `artifacts/mutation/before-framework-scope.json` and `before-framework-scope.html`; subsequent targeted reports do not establish a framework-wide score.

## Scope and execution

The first fresh run on November 9, 2026 used StrykerJS 10.1.1, Vitest 4.1.11 and Node 24.14.0. `npm run test:mutation` completed in 50 seconds with two workers and 20 selected tests, without PostgreSQL, Redis or HTTP listeners. This is a local timing observation, not a CI performance guarantee. The HTML and JSON reports live at `artifacts/mutation/mutation.html` and `artifacts/mutation/mutation.json`; subsequent runs overwrite them. Mutant identifiers below refer to this baseline and can change after source edits.

The pilot mutates the complete adapter definition/lifecycle module and circuit-specific ranges in the throttling manager. It does not measure the entire DI container, all throttling admission behavior or the ability of the broader test suite to detect these mutations. No production behavior or existing assertions were changed for the baseline.

## Results

| Scope | Mutants | Killed | Survived | No coverage | Score |
| --- | ---: | ---: | ---: | ---: | ---: |
| Adapter lifecycle (`di/adapter.ts`) | 89 | 67 | 20 | 2 | 75.28% |
| Circuit ranges (`throttling/manager.ts`) | 273 | 161 | 92 | 20 | 58.97% |
| Total | 362 | 228 | 112 | 22 | 62.98% |

There were zero timeouts and zero mutation errors. The overall score includes uncovered mutants; considering only covered mutants gives 67.06%. The score measures the selected runtime tests and mutation operators, not the probability that Kestrel is correct. No TypeScript checker was enabled, so type-invalid survivors have not been filtered out.

## Behavioral gaps to prioritize

1. **Rejected adapter reuse.** Mutants 30 and 40 remove the retained-validation-error guard or prevent the invalid flag from being set (`adapter.ts:77,83`). The validation-failure test currently verifies rejection and eventual disposal, but does not call `get()` or `boot()` again afterward. Add repeated-access assertions that preserve the original error, avoid a second factory/validation call and still dispose the rejected instance exactly once.
2. **Resolving the registered adapter through DI.** Mutant 59 replaces the factory registered under the adapter's public DI identifier with `() => undefined` (`adapter.ts:109`). Existing tests use the registration handle, so the mutation survives. Resolve the adapter descriptor directly and assert that it returns the same instance as the handle, with the expected ownership and disposal behavior. Also exercise `get()` and `boot()` after disposing an unused registration (mutant 73).
3. **Half-open success threshold.** Mutant 271 replaces the success-threshold condition with `true` (`manager.ts:1322`). The current multi-probe test still passes if the first successful probe closes the circuit immediately. Assert that the circuit remains half-open after the first success and continues enforcing the probe bound, then assert the closed state after the required number of successes.
4. **Probe compensation with multiple outstanding probes.** Mutant 150 changes `Math.max` to `Math.min` when returning a probe after a later constraint rejects (`manager.ts:1136`). With only one active probe, both produce zero. Keep another probe outstanding during compensation and verify that admission cannot exceed the configured bound.
5. **Inspection and queue wakeups.** Nineteen uncovered mutants concern acquisition/inspection/wakeup code, including the half-open inspection branch and the loop over circuit-blocked queues. Removing the cooldown refresh in `inspect()` also survives (181), as does removing `wakeCircuitQueues()` (201). Test inspection before/at cooldown expiry and with all probes occupied. Add a waiter scenario where probe completion releases capacity before its existing timer would wake it, so a missing notification becomes observable.
6. **Throttling without a future retry time.** The cooldown fallback at `manager.ts:1304` is uncovered (248). Exercise `throttled` feedback with an omitted, past or current retry time and assert that the configured cooldown is used. The existing explicit future-retry test covers a different path.

These are gaps in the selected tests demonstrated or suggested by the generated mutations, rather than observed defects in unmodified production code. Reproduce each contract with public APIs when strengthening the tests; private state assertions would unnecessarily couple tests to implementation.

## Other survivors and interpretation

Circuit event construction and the ISO retry-time helper account for 38 of the 92 circuit survivors. The instrumentation test asserts operation order and one completion feedback value, but not the circuit events' outcome, previous state, feedback or retry timestamp. Removing `getCircuitRetryAtIso()` entirely survives (357). Assert the documented event payloads for closed, open and half-open transitions if these fields are part of the observability contract.

The capability-copy mutation (3) survives because adapter tests use empty capabilities. Exercise a nonempty capability and the promised immutable definition. Some remaining changes may be equivalent under reachable states or the public contract: decrementing rather than incrementing the generation counter (300) still creates distinct generations for equality checks; explicitly retaining an optional property with value `undefined` may behave like omitting it. These are candidates for review, not proven equivalents, and no exclusions were added. Error-message mutations also deserve separate treatment from lifecycle failures.

Do not set a global blocking score from this first run. Prioritize the lifecycle and circuit contract gaps above, measure the resulting score and duration, then decide whether per-module thresholds are useful. Checking suspicious survivors against additional unit tests, enabling a compatible TypeScript checker and expanding to real adapters or integration tests remain deferred.

## Validation and dependency security

`npm run build:ai` passed. After the build completed, `npm run test:ai` passed all 249 files and 1,632 tests. An earlier concurrent build/test attempt raced with removal of generated distribution files; the successful validation ran after build completion. Stryker sandbox copying now excludes generated distributions and assets, and the successful mutation run used that configuration.

Before installation, exact Stryker versions were resolved into a temporary lockfile with scripts disabled and audited through `npm run check:security -- <temporary-directory> workspace`. The resulting installed lockfile exactly matched that audited candidate, with existing package entries unchanged. The baseline audit reported 65 vulnerable package entries; the candidate reported 68, including Stryker's dependency chain to the already-present `minimatch` moderate advisory. The two high-severity findings were already present at identical versions: `joi` 17.13.8 and `follow-redirects` 1.16.1. These counts include parent/metavulnerability entries and do not mean three new independent advisories.

The repository security-policy command failed on an existing expired advisory exception before it could produce a fresh policy evaluation. Security validation is therefore not green; the raw candidate audit and lockfile were retained under `artifacts/security`. No exception, dependency override or automatic audit fix was introduced as part of this pilot.

## Follow-up: stronger lifecycle and circuit assertions

The sections above describe the original baseline and its initial recommendations. A second fresh run on November 9, 2026 used the same production sources, Stryker configuration and set of 362 mutations, with 35 selected tests instead of 20. Only tests were changed. The original reports were preserved locally as `artifacts/mutation/baseline.json` and `baseline.html`; `mutation.json` and `mutation.html` now contain the follow-up results.

| Scope | Initial score | Follow-up score | Killed, before → after | Survived, before → after | Uncovered, before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Adapter lifecycle | 75.28% | 87.64% | 67 → 78 | 20 → 11 | 2 → 0 |
| Circuit ranges | 58.97% | 84.98% | 161 → 232 | 92 → 40 | 20 → 1 |
| Total | 62.98% | 85.64% | 228 → 310 | 112 → 51 | 22 → 1 |

The gain is 22.66 percentage points. Of the 82 additional kills, 64 were previously surviving mutants and 18 were previously uncovered. Three other uncovered mutants are now covered but still survive. Every previously killed mutation remains killed. The second run took 54 seconds versus 50 seconds initially, with zero timeouts and zero mutation errors. These local timings include different concurrent validation workloads and should not be interpreted as a controlled benchmark.

The tests now check nonempty immutable capabilities, direct DI resolution and the registration handle, retained validation errors on repeated access, activation after unused disposal, optional hooks and cleanup after drain failure. Circuit assertions now cover the half-open success threshold, multi-probe compensation, inspection at the exact cooldown boundary, cooldown fallback for omitted/past/current retry times, stale failures after recovery, immediate waiter notification and complete transition event payloads. Parameterized feedback cases check success, permanent, transient, timeout and throttled event outcomes. Managers are closed after each test even when mutation assertions fail; queued acquisition rejection handlers are attached before assertions.

Representative baseline mutants now killed include 3 (capabilities), 30/40 (validation error retention), 59 (public DI factory), 73 (unused disposal), 150 (multi-probe compensation), 181 (inspection refresh), 201 (queue wakeups), 248 (cooldown fallback), 271 (success threshold), 317/342 (event outcome/previous state) and 357 (ISO retry timestamp). This directly verifies the intended signal improvements rather than only comparing aggregate scores.

The 51 remaining survivors are not all equivalent. Further useful scenarios include queue notifications across different circuits, reopening while waiters exist, compensation after the circuit generation changes during an asynchronous rate reservation, and an explicit assertion that an unclassified failure is reported as `transient` (376). The sole uncovered mutation (149) is in the defensive branch that skips compensation for a missing/stale/non-half-open reservation. Some others remain candidates for equivalence review: generation direction (300), optional properties with `undefined`, or removing a factory lifetime while the underlying lifecycle still caches its singleton. No survivors or mutation operators were excluded, and no threshold was raised.

Validation: the 35 focused tests, framework typecheck, `npm run build:ai` and all 1,647 tests in 249 files passed. One earlier full-suite run failed in the unchanged Vite dependency-refresh watcher test; that file passed in isolation and the subsequent complete run passed. No production code, dependency version or mutation scope changed during this follow-up, so the dependency-security limitations recorded above remain unchanged.

## Final review: concurrent reservations, survivor classification and regression floor

The final test pass adds independent-circuit queue notifications, rescheduling to a new cooldown when a probe fails, stale compensation after an asynchronous reservation outlives its circuit generation, immediate notification after a valid compensation, and implicit `transient` failure classification. DI assertions also cover distinct adapters in one container, boot after a completed boot/disposal, cancellation before creation, and resolution by a singleton consumer. That last case catches a genuine difference between a singleton public DI binding and a transient factory returning a cached instance: strict lifetime checks can reject the latter.

The fake clock now drains promise continuations through one event-loop turn instead of assuming a fixed number of microtasks. Deferred backend reservations are resolved in `finally`, and queued acquisitions have rejection handlers before assertions. Tests still use public APIs, injected clocks/backends, no servers and no external stores. Production sources, mutation operators and ranges are unchanged.

| Scope | Previous score | Final score | Killed | Survived | Uncovered |
| --- | ---: | ---: | ---: | ---: | ---: |
| Adapter lifecycle | 87.64% | 93.26% | 83 | 6 | 0 |
| Circuit ranges | 84.98% | 89.01% | 243 | 30 | 0 |
| Total | 85.64% | 90.06% | 326 | 36 | 0 |

The final fresh run completed in 55 seconds with 42 tests and the same 362 mutations, with zero timeouts or mutation errors. It kills 15 of the previous 51 survivors and the last uncovered mutant, while retaining all 310 previous kills. This is a 4.42-point gain over the previous pass and a 27.08-point gain over the original baseline. The original report remains in `baseline.json`/`baseline.html`, and the preceding 85.64% report is preserved in `strengthened.json`/`strengthened.html`, all under `artifacts/mutation`. The standard `mutation.json`/`mutation.html` reports contain the final result. Framework typecheck, `npm run build:ai` and all 1,654 tests in 249 files passed.

### Complete survivor classification

Classification is based on the generated mutation and its call sites in the current implementation. It is a review of the present runtime contract, not a formal proof for every possible future refactor. IDs are qualified by their source file and refer to this unchanged set of mutations. No classification removes mutants from the raw score, and no Stryker exclusions were added.

| File | Mutant IDs | Classification | Rationale and disposition |
| --- | --- | --- | --- |
| `di/adapter.ts` | 6, 10, 91 | Lower-priority representation difference | Keeping an optional hook property with value `undefined` behaves like omission when calling hooks, but differs under own-key inspection. Define that shape contract before adding assertions for it. |
| `di/adapter.ts` | 24, 25 | Defensive teardown paths; further investigation | These weaken the internal resource disposal guard. Public handle disposal also sets `disposed`, so existing handle scenarios do not distinguish them. Container-driven resource disposal and reentrant resolution need a separate ownership review; these are not certified equivalent. |
| `di/adapter.ts` | 65 | Lower-priority extra work | Removing the outer `get()` guard still rejects via the inner guard, but can resolve a lifecycle registration before rejecting. Retain the early guard; additional internal-resolution assertions have little behavioral value here. |
| `throttling/manager.ts` | 109, 192 | Equivalent under current invariants | Closed circuits have zero probes and a positive maximum; open circuits have already been handled. The half-open qualifier adds no distinction to the subsequent probe-bound comparison on reachable states. |
| `throttling/manager.ts` | 136, 146 | Equivalent under current invariants | A matching-generation probe reservation is half-open. Non-probes either remain closed or have a stale generation and are skipped by the other guards. |
| `throttling/manager.ts` | 142, 213 | Unreachable defensive states | Circuit reservations come from states already inserted into the map, and the manager never deletes or clears those entries. A missing state currently requires violating that invariant. Retain the defensive checks without fabricating private state in tests. |
| `throttling/manager.ts` | 167, 168, 171 | Equivalent under current invariants | Open circuits have a retry timestamp; closed and half-open circuits do not. The remaining timestamp or state guard preserves the cooldown refresh behavior. |
| `throttling/manager.ts` | 206 | Lower-priority scheduling difference | Replacing `??` with `&&` can cause an unnecessary immediate retry before the queue restores its authoritative retry time. Admission remains blocked, but retry work and attempt telemetry can differ. This is deferred, not labeled equivalent. |
| `throttling/manager.ts` | 218, 220, 221 | Equivalent under current invariants | The generation guard rejects stale completions; matching half-open reservations are probes. Applying the clamped decrement to a closed circuit still leaves its probe count at zero. |
| `throttling/manager.ts` | 234, 237 | Equivalent under current classification | A `throttled` classification can only come from explicit throttled feedback, so the feedback object and kind have already been established. |
| `throttling/manager.ts` | 243 | Equivalent at runtime | Comparing an absent retry timestamp with the current time evaluates false, preserving the cooldown fallback even without the explicit undefined check. Type checking may still distinguish this mutation. |
| `throttling/manager.ts` | 281 | Equivalent under current invariants | Half-open feedback has already continued, and open-state completions have a stale generation. The remaining reachable feedback path is closed. |
| `throttling/manager.ts` | 300 | Equivalent generation identity | Increasing or decreasing the counter creates distinct generation identities for equality comparisons; the sign is not exposed. |
| `throttling/manager.ts` | 307, 309, 310 | Equivalent under current call paths | Keeping the previous retry timestamp internally during half-open does not expose it: retry helpers check the state, and later closed/open transitions delete/replace the value. Revisit if the internal state is exposed later. |
| `throttling/manager.ts` | 340, 344 | Lower-priority representation difference | These add optional event keys with value `undefined`; serialized event payloads are unchanged, but JavaScript own-key inspection can distinguish them. |
| `throttling/manager.ts` | 348, 350, 351, 354 | Equivalent under current call paths | The Date-returning retry helper is only called in branches already known to be open, where a retry timestamp exists. |
| `throttling/manager.ts` | 360, 361, 364 | Equivalent under current invariants | For the ISO helper, open state and presence of the timestamp agree; closed and half-open states have no timestamp. |

This leaves 25 mutations equivalent under the reviewed runtime invariants/call paths, four defensive cases (including two teardown guards requiring further investigation), and seven lower-priority observable differences. The complete ID inventory is also retained locally in `artifacts/mutation/classification.json` and checked against the actual report so no survivor is omitted or counted twice. Equivalence claims must be revisited if the corresponding state or ownership invariants change. Representation changes and extra queue work remain explicit deferred cases.

### Blocking floor

`test:mutation` now fails below a raw score of **88%**. This applies to the combined pilot and includes every survivor and any uncovered mutation; it does not use an adjusted score that discounts reviewed equivalents. The floor leaves a small margin below the measured baseline while avoiding an unreachable 100% target or exclusions introduced to inflate the score. A 90% floor would leave almost no headroom for harmless additions or changes to the mutation set.

At the current fixed count of 362 mutations, 319 detections are required to pass. Starting from 326 kills, seven lost detections would still pass and an eighth would fail. This is a deliberate small regression budget, not protection against each individual lost assertion. The normal fresh command passed with the configured 88% floor.

The failure path was also checked with an ignored local control configuration setting the floor to 100%. Stryker reused all 362 results from a copy of the final report, confirmed that none of the 42 tests or mutated sources had changed, and exited with code 1 because 90.06% is below that control floor. This took two seconds, did not rerun mutations and did not overwrite the final HTML/JSON reports or change the repository's 88% configuration.

This gate is intentionally a coarse regression floor. Individual new survivors can still pass, improvements in one file can offset losses in another, and timeouts count as detected mutations under Stryker's scoring. Continue reviewing the HTML report and runtime outcomes, especially after source, tool or scope changes. Per-file gates, a rule rejecting new behavioral survivors, automated CI integration and TypeScript checker adoption remain deferred.

## Disposal guard investigation

Reviewing the two `adapter.ts:76` survivors (24 and 25 in the pre-fix report) revealed a missing container-owned teardown scenario, rather than justification to remove the guards. Awilix snapshots and clears its singleton cache before awaiting disposers. The adapter resource's disposer previously set only its local `disposePromise`, while explicit registration disposal also set the shared `disposed` flag. Consequently, after `container.dispose()` entered an asynchronous `beforeDispose` callback, `registration.get()` could resolve a new lifecycle and create a second adapter. The old resource's promise guard was never consulted on that new lifecycle. The same issue allowed activation after cleanup completed.

The regression test uses a real container and a deferred drain callback. It failed against the original implementation because `get()` did not throw. The fix sets the shared `disposed` flag synchronously at the start of resource disposal, covering both ownership paths. The test now verifies rejection of `get()`, `boot()` and fresh public DI resolution while draining, rejection after completion, one creation and one disposal. It also cleans up any resurrected resource if an assertion fails. Build, framework typecheck and all 1,655 tests passed.

The two mutations have different outcomes after this fix. Mutant **24**, which changes `disposed || disposePromise !== undefined` to `disposed && disposePromise !== undefined`, is now killed: a fresh public DI resolution during container shutdown can reach a newly constructed lifecycle with `disposed === true` and no local disposal promise. The shared flag must reject that access on its own. This was a real missing test scenario. Mutant **25**, which removes only the `disposePromise` predicate, still survives and is redundant for the reviewed public access paths: resource disposal now always sets `disposed` before yielding. At this stage the predicate was retained as an internal defensive check; the subsequent cleanup below removes it while preserving the promise for idempotent asynchronous cleanup.

The fresh Stryker run took 55 seconds: 328 killed, 35 surviving, no uncovered mutants, timeouts or errors, with a raw score of **90.36%** (adapter lifecycle 94.44%; circuits unchanged at 89.01%). The mutation set grew from 362 to 363 because the new shared-state assignment is itself mutated and killed by the regression test. The score is therefore not a comparison over an identical mutation set. The 88% floor remains unchanged and passes. The previous inventory and its mutation IDs describe `artifacts/mutation/pre-disposal-fix.json`, preserved before changing production code; IDs after the new assignment can shift. `classification.json` is explicitly labeled as that historical inventory.

The remaining two circuit-map defensive survivors are unrelated to this ownership issue. General container closed-state enforcement, including unused registrations whose lifecycle never materialized, is a separate deferred contract; no container-wide behavior was changed here.

## Redundant disposal guard removal

The resource's `get()` now checks only the shared `disposed` flag. Both registration-owned and container-owned disposal set this flag synchronously before waiting for initialization or draining consumers. The redundant `disposePromise !== undefined` predicate has been removed without changing the promise's declaration, lazy `??=` assignment or returned value. Repeated disposal still shares the same cleanup operation and retains its rejection; draining and resource disposal remain ordered and idempotent. The existing lifecycle and container-driven disposal regression tests are unchanged.

The preceding 90.36% reports are preserved as `artifacts/mutation/before-guard-removal.json` and `before-guard-removal.html`. They provide the comparison for this production simplification; raw scores must not be interpreted as new assertion coverage because removing a condition also changes the mutation set. The shared terminal-state assignment and rejection of public DI access during container shutdown remain protected by the regression test. No mutation categories, individual mutants or selected tests were excluded, and the blocking floor stays at 88%.

| Scope | Previous score | Current score | Killed | Survived | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Adapter lifecycle | 94.44% | 95.40% | 83 | 4 | 87 |
| Circuit ranges | 89.01% | 89.01% | 243 | 30 | 273 |
| Total | 90.36% | 90.56% | 326 | 34 | 360 |

The fresh Stryker run completed in 55 seconds with the same 43 selected tests, zero uncovered mutants, zero timeouts and zero mutation errors. The previous run had 363 mutants, 328 killed and 35 surviving. Simplifying the guard removes three generated mutations on balance, including the redundant survivor; the higher raw score is a consequence of that smaller set, not of stronger tests. The current HTML/JSON reports remain at `artifacts/mutation/mutation.html` and `mutation.json`.

The 34 remaining survivors retain their reviewed classifications: 25 equivalent under current runtime invariants, seven lower-priority observable differences and two circuit-map defensive cases. There are no remaining disposal-promise guard mutants. `artifacts/mutation/classification-current.json` records the current survivor IDs, matched to the historical review by source expression, mutation operator and replacement rather than stale line numbers or IDs. The historical `classification.json` inventory remains labeled with its original report. At the new total of 360 mutations, an 88% floor requires 317 detections; nine lost detections from the present 326 would still pass, and a tenth would fail.

Validation after this cleanup: both adapter suites passed, framework typecheck and `npm run build:ai` passed, and `npm run test:ai` passed all 1,655 tests in 249 files. The existing tests still verify repeated disposal, retained cleanup failure, in-flight initialization ownership, and rejection of access during and after container-owned teardown. No tests or dependencies were changed for this simplification.
