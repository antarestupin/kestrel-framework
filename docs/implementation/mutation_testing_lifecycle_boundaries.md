# Mutation review of lifecycle and composition boundaries

[Coverage inventory](./mutation_testing_inventory.md) · [Contributor commands](../contributing/mutation-testing.md)

This review covers `app`, `di`, `background`, `concurrency`, `events`, `configuration` and `definitions` from the November 12, 2026 framework checkout. The starting revision is `b7bb98e`. Every profile retains static and hybrid mutants, forces fresh execution, and has a ten-minute budget. The 95% objective guides test selection. The Stryker score remains informational.

The application profiles partition composition, startup, execution admission, scope teardown, shutdown coordination, execution context, catalog and other contracts. The scope audit uses Stryker's instrumenter to verify the union against the full eligible source set. Profiles rerun from isolated baseline snapshots retain the original mutated source and its direct tests. Reports, execution metadata and unchanged-span comparisons are archived under `artifacts/mutation/nov12-lifecycle-boundaries/`.

## Results

The completed runs compare 2,326 unchanged mutant fingerprints out of 2,631 baseline and 2,722 final mutants. Stryker classified 321 baseline and 322 final mutants as static or hybrid. The longest completed run took 462 seconds.

Among paired mutants, 229 prior survivors and 10 previously uncovered mutants are killed in the final reports. Stryker includes individual execution timeouts as detections and excludes runtime errors from its score. A profile stopping at its wall-clock deadline is partial evidence.

The final reports record 60 kills through Vitest deadlines, 38 Stryker timeouts and 25 runtime errors. Twenty-two paired detections moved from a Vitest deadline to a direct kill, and ten moved in the other direction.

| Component | Paired mutants | Before K / S / NC / T / RE | After K / S / NC / T / RE | Stryker score |
| --- | ---: | --- | --- | --- |
| `app` | 942 | 870 / 112 / 7 / 5 / 18 | 993 / 26 / 0 / 8 / 18 | 88.03% → 97.47% |
| `di` | 271 | 290 / 33 / 7 / 6 / 0 | 328 / 15 / 1 / 5 / 0 | 88.10% → 95.42% |
| `background` | 120 | 134 / 10 / 0 / 1 / 0 | 137 / 2 / 0 / 1 / 0 | 93.10% → 98.57% |
| `concurrency` | 345 | 333 / 43 / 0 / 17 / 0 | 379 / 19 / 0 / 17 / 0 | 89.06% → 95.42% |
| `events` | 137 | 154 / 47 / 1 / 5 / 4 | 203 / 4 / 0 / 6 / 4 | 76.81% → 98.12% |
| `configuration` | 447 | 368 / 79 / 2 / 1 / 3 | 451 / 10 / 1 / 1 / 3 | 82.00% → 97.62% |
| `definitions` | 64 | 71 / 10 / 0 / 0 / 0 | 86 / 4 / 0 / 0 / 0 | 87.65% → 95.56% |

## Profile executions

| Profile | Before mutants | After mutants | Paired | Before seconds | After seconds | Stryker score |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `app-composition` | 92 | 92 | 92 | 107 | 153 | 73.91% → 97.83% |
| `app-execution` | 71 | 83 | 37 | 123 | 88 | 84.51% → 96.39% |
| `app-startup` | 68 | 74 | 61 | 84 | 104 | 80.88% → 98.65% |
| `app-shutdown` | 117 | 117 | 117 | 92 | 100 | 97.44% → 97.44% |
| `app-shutdown-coordination` | 179 | 188 | 158 | 308 | 282 | 78.21% → 95.74% |
| `app-execution-context` | 238 | 238 | 238 | 117 | 143 | 94.12% → 98.74% |
| `app-catalog` | 160 | 166 | 152 | 174 | 148 | 95.00% → 96.39% |
| `app-contracts` | 87 | 87 | 87 | 134 | 59 | 89.86% → 100.00% |
| `component-di` | 336 | 349 | 271 | 462 | 418 | 88.10% → 95.42% |
| `component-background` | 145 | 140 | 120 | 100 | 60 | 93.10% → 98.57% |
| `component-concurrency` | 393 | 415 | 345 | 408 | 374 | 89.06% → 95.42% |
| `component-events` | 211 | 217 | 137 | 437 | 261 | 76.81% → 98.12% |
| `component-configuration` | 453 | 466 | 447 | 294 | 282 | 82.00% → 97.62% |
| `component-definitions` | 81 | 90 | 64 | 118 | 88 | 87.65% → 95.56% |

The input manifest and report hashes are in the local archive. Related test files from other profiles could gain assertions after a profile ran. The comparisons identify those files individually. The final reports match the current production source within each selected file or range.

The full framework suite passed 4,122 tests in 340 files, and all 131 mutation infrastructure tests passed. The framework typecheck, framework and playground builds, documentation build and ownership-boundary check passed.

## Application

Application startup now freezes the boot plan before hooks can change its workloads or running mode. Bootstrap checks the shutdown deadline after the last provider hook, preventing a timed-out startup from publishing completion. Null-prototype providers receive an anonymous diagnostic name. The catalog reports invalid primitive branches explicitly, including strings that previously recursed by character.

Execution disposal publishes its promise before invoking completion callbacks. A reentrant callback now joins the original disposal. Scope initialization releases its partial resources when the error handler or another early step throws. Completion and teardown preserve independent failures and release the container even if the bus fails to close.

Transport drains registered during an active drain are included before the application releases shared resources. Deadline errors identify a phase still awaiting work. A synchronous failure while installing a signal wait prevents runtime startup from being scheduled.

Residual application variants include diagnostic strings, redundant lifecycle guards, defensive descriptor and array-index paths, and timing-only variants. The observation contract uses a direct dynamic-import test because Studio can load those declarations lazily. Invalid lifecycle event schema mutations that fail during module import remain separate from assertion kills.

## Dependency injection

The DI binding now checks the adapter lifecycle on every lookup, including after a previous lookup cached a consumer. A lightweight registration is owned immediately, so an unused handle cannot construct a backend after disposal. Adapter cleanup retains independent consumer-drain and backend-release failures. Container disposal publishes its pending result before invoking reentrant async-factory disposers and waits for all synchronous registration disposers, preserving their failures before rejecting.

The 15 DI survivors cover equivalent resolver defaults, private descriptor brands, cache retention, the outer aggregate's label, and a progress variant that substitutes an empty list for the pending factories. The last variant can spin while externally gated work remains pending. The previously asserted outer label survives after the test changed to assert the aggregate's causes. The single uncovered mutant substitutes the implicit transient fallback's default literal. Five mutants time out and eight other detections come from Vitest deadlines.

## Background workloads

The combined host now observes a polling lifetime published by the current workload's `start()` before its readiness promise settles. Previously the failure could remain unobserved while startup waited indefinitely. A bare `--workload` argument previously selected every available runtime and now fails during selection. Tests also cover steady-state polling termination and preserve reverse cleanup across sibling failures.

The two remaining variants are equivalent under the host's supervisor contract. The signal is always passed, and a never-settling race for an absent polling lifetime has the same result as waiting only on the shutdown signal. A backward parser index hits the runner's execution limit.

## Concurrency

The aggregation helper recognizes complete synchronous and asynchronous generator protocols. Returning a plain cursor or iterator preserves it as global result data. Large batch delays use bounded native timers measured from the first admission. An aggregate accessor failure records one failed batch, preserving agreement between the batch outcome and awaited values.

Deferred tasks establish ownership before adopting a thenable that can reenter `close()`. If diagnostic metadata closes the group before registration, admission is checked again. Reporter lookup and invocation share a protected boundary, so a throwing reporter accessor cannot replace the task failure or leave the group stuck in closing.

Concurrency retains 19 survivors in partial generator-protocol checks, redundant batch branches and timer portability, and internal deferred state or diagnostics. Fifteen mutants hit Stryker's execution limit. Two more time out when active batches remain registered. Twenty-two kills use Vitest deadlines, down from 41. Sixteen paired deadline detections now use direct assertions.

## Events

Dispatch reserves one-time listeners before any callback can reenter dispatch. It consumes each registration when its synchronous callback runs or its asynchronous work is admitted. A previous listener's synchronous failure or a child's closed task group formerly dropped pending one-time listeners and could strand `waitFor()`. Scope identities and their ancestry are frozen, and callable thenables are rejected through the synchronous listener contract. The event tests exercise recursive error containment, deferred task diagnostics, closed-scope rejection and removal from the shared registry.

Four survivors affect idempotent closing work, a default exact-scope marker and clearing reservations on persistent listeners. Six mutants hit Stryker's execution limit and four invalid event declarations fail during import. One other kill relies on a Vitest deadline.

## Configuration

Invalid selectors now preserve `ConfigurationError` and its Zod cause when the supplied value is a bigint, cyclic object or value with a throwing serialization hook. Tests cover exact paths and validation causes, reserved prefixes, supported object wrappers, excluded unstable inputs, and optional branches affected by overrides.

Ten survivors concern private markers, redundant discovery and override guards, defensive shape handling and equivalent acronym conversion. The uncovered root-label fallback is outside ordinary object definitions. The remaining timeout stops an unwrapping loop, and three invalid option mutations produce errors during module import.

## Definition registries

An empty registration path could create an invisible root definition that blocked every later path. It now fails before registration. The registries expose frozen metadata snapshots and preserve original definition identities. Mutating a caller-owned provenance object or a returned catalog view can no longer rewrite later diagnostics or make an indexed definition disappear.

The four survivors are equivalent under the public contracts. An absent identity never participates in the uniqueness lookup, and every mode other than the explicit asynchronous option uses synchronous schema parsing.
