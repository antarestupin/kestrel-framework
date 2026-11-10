# Workflow terminal controls

[Framework assessment](./mutation_testing_framework.md) · [Coverage inventory](./mutation_testing_inventory.md) · [Workflow operations](./workflows.md#operational-api)

## Selected behavior

The November 10, 2026 bounded lot selects `requestCancellation`, `setPaused` and `forceTerminate` in the memory and PostgreSQL workflow adapters, plus memory child-cancellation/termination helpers and PostgreSQL execution-tree helpers. The frozen profile uses anchored complete methods. The before report is archived under `artifacts/mutation/workflow-terminal-control-before-two-hour-tests/`; the current report is under `artifacts/mutation/workflow-terminal-control/`. Each execution has a ten-minute budget and retains static mutants.

The baseline contains 275 mutants: 99 killed, 91 surviving, 81 uncovered and four timed out. Its 184-test baseline and mutation phase completed in 54 seconds. The four timeouts change tree traversal into nonterminating loops and are kept separate from assertion kills.

Thirty new cases exercise real adapter start/reserve/commit transitions: nineteen memory cases and eleven PostgreSQL cases. They cover pending cancellation, pause/resume idempotence, capacity-pending resume, cancellation history and child propagation, local command/outbox cleanup, keyed-peer admission, terminal-state preservation, missing roots, child-to-parent notification, completion ordering, closed-root escalation and preservation of unrelated command/outbox work. Database assertions inspect physical rows and bracket server timestamps; memory assertions inspect public snapshots and tasks. Existing connection-local PostgreSQL fixtures are reused and disposed.

## Demonstrated production defects

### A terminal memory root hid open descendants

A workflow can fail after recording a child command. Its child receives cooperative cancellation and remains open while compensation awaits execution. The old memory `forceTerminate` returned immediately for the failed parent, leaving that child queued. PostgreSQL already traversed descendants before preserving an already terminal root.

A public regression failed against the original memory adapter and passed against PostgreSQL: force termination of the failed parent returned `false`, as expected for an unchanged root, but memory left its child open. The memory guard now traverses descendants before returning. Its helper also follows closed intermediate children, so an already closed child cannot hide an open grandchild. Closed records preserve their original status and error; open descendants lose pending work and become terminated. The boolean still describes the selected root only.

### Terminal waiters received a pre-release concurrency snapshot

The memory adapter cloned an execution for terminal waiters before releasing its retained keyed permit. A waiter therefore received `concurrencyAdmitted: true`, although the persisted terminal record already had `false` and the next peer had been admitted. The new force-termination regression failed on that mismatch before the fix.

Terminal waiter notification now follows parent/child cleanup and permit release. The same ordering defect existed for completed, failed and cancelled activation outcomes. An isolated probe loaded the archived before-report source and reproduced all three public commit transitions: the notified record retained `true` while the stored record had `false`. Three ordinary regression cases now assert equality with the final stored snapshot after one event-loop drain in a controlled synchronous memory fixture.

`applyActivationOutcome`, which contains those three normal outcome branches, is supporting production code outside the frozen mutation ranges. Those regressions validate its behavior with ordinary tests; this lot does not claim mutation coverage of that helper. Adding it to a future independently baselined lifecycle lot remains appropriate.

### Cancelling a pending PostgreSQL child left its parent waiting

An execution-scoped concurrency limit can leave a child pending before its first activation. Cancelling that child is immediately terminal, so no later child activation can report completion to the waiting parent. PostgreSQL changed the child's status but omitted the parent's command-completed event and activation wake-up. The new public regression failed: the parent stayed waiting at revision 1 instead of becoming queued at revision 2. The equivalent memory path already completed its parent command. Review of the surviving memory parent-notification mutation prompted that backend parity case: a mutant identified a missing scenario, and the scenario exposed a defect in code that did not yet contain the missing parent-notification branch.

The pending cancellation branch now locks a nonterminal parent, appends its child completion idempotently, advances the parent revision and queues one workflow activation in the same transaction. A stronger case completes a preceding child first, then verifies completion order 1, the cancellation error identity and repeated cancellation without duplicate history. A separate regression verifies that a failed parent remains terminal when its pending child is cancelled during parent cleanup. All new cancellation logic remains inside the original selected tree-helper anchors; the changed mutation corpus remains explicit.

## Before and after

| Result | Before | Final result |
| --- | ---: | ---: |
| Mutants | 275 | 320 |
| Killed | 99 | 282 |
| Survived | 91 | 31 |
| NoCoverage | 81 | 1 |
| Timeout | 4 | 6 |
| Runtime / compilation errors | 0 / 0 | 0 / 0 |
| Baseline tests | 184 | 214 |
| Elapsed | 54 seconds | 75 seconds |

The [durable classification](./mutation_testing_workflow_terminal_classification.json) matches 260 method/expression/operator/replacement/occurrence sites. All 96 matched original kills remain killed. Seventy-six former survivors and 62 formerly uncovered sites are now killed; the remaining matched transitions include 14 uncovered-to-surviving sites. Fifteen old body/site variants disappeared and 60 new variants were introduced. The six Stryker timeouts are nonterminating traversal mutants, reported separately from the 282 kills. Every killed/surviving mutant completed tests, and no kill relied on a Vitest test timeout. Both fresh runs retained static mutants and stayed under their ten-minute limits.

The remaining uncovered default belongs to `terminateExecutionTree`'s unused optional `requireRoot=false` value: its only call site always passes `true` explicitly. No additional supported scenario invokes that default today. The 31 survivors are not blanket-classified equivalent. One local `rootChanged` invariant is redundant; other rows cover diagnostic wording, additional query work, pending-admission reconciliation and real deferred tests for terminal parents, partial/orphan parent metadata, cycles and concurrent disappearance. Exact reasons, site pairs and executed source/test hashes are recorded in the classification.

## Interpretation and deferred work

Production changes alter the mutation corpus: equal totals are not assumed and changed method bodies must not be presented as identical before/after sites. Comparison uses file, normalized original expression, mutator, replacement and repeated-occurrence index; unmatched old/new bodies remain explicit. Whole-report and embedded source/test hashes identify the executed revisions.

TypeScript AST mutation does not systematically mutate SQL predicates, transaction isolation or adversarial interleavings. The row-level assertions strengthen the chosen contracts without establishing exhaustive database concurrency coverage. Complete workflow coverage still requires separate lots for activation journal writes, signal/completion idempotency, child admission, activity dispatch, replay and scheduler/runtime behavior. No mutation score gate or exclusions are introduced.

The next useful terminal cases directly terminate an open child of an already terminal parent, then exercise repeated cancellation after compensation creates a new child. Lower-level robustness cases should clarify accepted partial/orphan/cyclic parent metadata before pinning that behavior. Preserve defensive guards while those scenarios are investigated. The current lot is reviewed with these gaps visible; it is not complete mutation coverage of workflow lifecycle code.
