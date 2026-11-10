# Background runtime mutation assessment

[Framework assessment](./mutation_testing_framework.md) · [Coverage inventory](./mutation_testing_inventory.md) · [Background contract](./background.md)

The November 10, 2026 follow-up evaluates the complete small `background` component, including the composite runtime, provider, CLI selection parser and dependency declaration. Unlike the anchored workflow lots, this is a component profile. The before report is archived under `artifacts/mutation/component-background-before-two-hour-tests/`; the current report belongs under `artifacts/mutation/component-background/`. Both executions have the shared ten-minute deadline and retain static mutants.

The initial 144 mutants comprise 78 killed, 26 surviving, 39 uncovered and one timed out. The before run completed in 49 seconds with an eight-test baseline. That partial baseline lacked dedicated provider composition, invalid selection and failure-drain cases.

## Demonstrated failure-drain defect

`BackgroundRuntime` passed `started.reverse().map(runtime => runtime.stop())` to `Promise.allSettled`. JavaScript evaluates that complete argument before calling `allSettled`. A synchronous exception in the first stop callback therefore aborts the map and prevents later peers from being asked to stop. A declared `Promise<void>` return type does not prevent an implementation from throwing before returning its promise.

The new regression starts three workloads, makes the first reverse-order stop throw synchronously and another reject asynchronously, then checks every stop attempt and both original errors. It failed against the before source: only the first workload was stopped and its peers were skipped. Each callback is now scheduled with `Promise.resolve().then(() => runtime.stop())`, converting synchronous throws into independent rejections before settling the full drain set. Dispatch order remains reverse selection order; draining remains concurrent.

## Added contracts

Sixteen new cases supplement the four existing direct component cases. Runtime cases cover the mixed synchronous/asynchronous cleanup failure, empty selection, duplicate selection, cleanup after partial startup, interrupted startup after owner cancellation and both fulfilled/rejected polling completion while a later workload is still starting. The completion fixtures use controlled promise gates and one event-loop drain without storage or polling I/O, then release every gate before awaiting cleanup. A third selected workload must remain unstarted while an earlier start is blocked, so a mutant cannot mask lost startup supervision by failing later in steady state. This catches missing supervision with a direct missing-outcome assertion instead of awaiting a blocked mutation until a generic test deadline.

Parser cases cover invalid, empty and unavailable selections, deduplication, requested order and ignored unrelated arguments. Five provider compositions cover no runtimes, each runtime independently and all runtimes together; they inspect the singleton launcher, catalog/controller metadata, schema alternatives/defaults, selected-workload preparation and awaited handler forwarding. Application instances and owned shutdown coordinators are disposed; tests use no HTTP listener or emitted process signal.

The background implementation and usage guides now describe the actual ownership contract: application admission closes before draining, and a runtime is included before its start callback, so stop must tolerate partial startup. These documentation corrections follow existing behavior; only synchronous peer-stop failure handling changes production semantics.

## Before and after

| Result | Before | Final result |
| --- | ---: | ---: |
| Mutants | 144 | 145 |
| Killed | 78 | 134 |
| Survived | 26 | 10 |
| NoCoverage | 39 | 0 |
| Stryker Timeout | 1 | 1 |
| Killed by a Vitest test deadline | 7 | 5 |
| Baseline tests | 8 | 24 |
| Elapsed | 49 seconds | 54 seconds |

The [durable classification](./mutation_testing_background_classification.json) matches 140 method/expression/operator/replacement/occurrence sites. All 74 matched original kills remain killed, 20 former survivors and 35 uncovered sites are now killed. Four formerly uncovered sites now survive. Four previous body/site variants disappeared and five new variants were introduced by stop scheduling, so whole-file identity and equal mutation totals are not claimed. Both executions retain static mutants and finish under ten minutes. Timings are local observations with other validation activity, not a benchmark.

The one Stryker Timeout is a parser mutation changing option-value index advancement into a decrement; it reaches the instrumentation hit limit (301/300) while revisiting the same option. It is distinct from five mutants reported as Killed when the existing workflow composite-supervision test reaches its five-second Vitest deadline. Those five remove or neutralize the steady-state completion getter. Their raw statuses stay visible, but they are not direct assertion kills. A controlled steady-state completion fixture should observe failure before releasing a fallback shutdown gate, then release every gate before awaiting cleanup. The new controlled startup fixtures already reduce deadline-dependent kills from seven to five.

Of the ten survivors, four change diagnostic text, two preserve invalid-selection rejection while changing Unknown/Unavailable diagnostic distinction, one removes nested CLI help text, one changes handling of a trailing missing option value, one removes optional signal access under the current always-supplied callback contract, and one replaces absent completion with an additional never-settling promise. Exact reasons distinguish public lifecycle behavior from extra work and unpinned metadata. No exclusions or blocking threshold were added.

The complete component assessment is saved, with review still pending for the five deadline kills, the helper's malformed trailing-option contract and nested help quality. No mutation result establishes exhaustive shared-supervisor coverage outside this component.
