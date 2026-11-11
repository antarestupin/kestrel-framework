# Scheduler ownership and PostgreSQL workflow concurrency

[Coverage inventory](./mutation_testing_inventory.md) · [Contributor commands](../contributing/mutation-testing.md) · [Report evidence](./mutation_testing_scheduler_followup.json)

The November 11, 2026 session covered worker scheduler ownership, scheduled-task test waits, and PostgreSQL workflow retry races. The three requested comparisons use fresh runs with static mutations and a ten-minute budget per run. The supplementary delivery refresh uses the November 10 final report as its reference. At most two Stryker campaigns ran together, using separate test databases. The recorded durations describe these local executions.

## Before and after

| Profile | Mutants | Killed / Survived / NoCoverage / Timeout | Vitest deadline kills | Seconds |
| --- | --- | --- | --- | --- |
| `workers-scheduler` | 609 → 731 | 348 / 181 / 77 / 3 → 487 / 175 / 67 / 2 | 32 → 8 | 223 → 186 |
| `scheduled-runtime` | 513 → 513 | 421 / 71 / 5 / 16 → 431 / 71 / 5 / 6 | 51 → 0 | 298 → 119 |
| `workflow-execution-retry` | 136 → 143 | 121 / 13 / 2 / 0 → 129 / 10 / 4 / 0 | 0 → 0 | 38 → 38 |
| `workers-delivery` | 313 → 336 | 271 / 35 / 2 / 5 → 288 / 40 / 2 / 6 | 0 → 0 | 79 → 97 |

The scheduler comparison pairs 550 mutations on unchanged source spans. The final tests kill 30 former survivors and five formerly uncovered variants among these pairs. The previously killed variant that removes handler-slot release now reports `Timeout`. Of the two final scheduler timeouts, one reached Stryker's execution guard and the other has no reported reason. The five tests added after resuming detect 11 additional variants on the same 731-mutant corpus. An assertion detects each of those 11 variants.

The scheduled-runtime after snapshot includes the final scheduled test changes and a passing intermediate worker snapshot. The ordinary test suite validates the final checkout with all three changes together.

## Scheduled-task test waits

The fresh reference recorded 51 `Killed` outcomes caused by the Vitest deadline. The November 10 report recorded 53. The fresh pair assessed the same 513 mutations with identical production sources and retained all 421 reference kills.

Tests that previously awaited a handler or storage callback now inspect the expected call or settlement after the controlled in-memory turn. The fixture releases its gates and disposes any scope it created after the assertions, including when a mutation removes scheduler cleanup. The 51 previous deadline detections became 41 matcher failures and ten immediate exceptions. Ten former Stryker `Timeout` outcomes became matcher failures for admission, observation or disposal. Six poll-loop mutations still reach Stryker's execution guard. The final run recorded zero Vitest deadline kills and took 119 seconds, compared with 298 seconds for the reference. The scheduled runtime and scheduler production sources stayed unchanged during this work.

## PostgreSQL workflow retry races

Four tests coordinate two transactions through shared schema-qualified tables and inspect actual server lock waits from an observer connection. They cover an ordinary start and a retry competing for the last place, the same target claimed by concurrent starts and retries, competing retries of distinct sources, and independent identities that should progress without contending.

A normal start could claim a retry's target while the retry waited for the business-key lock. The original retry then exposed PostgreSQL unique violation `23505`. The insert now handles conflicts on the execution ID and reads the winning row to classify the result through the existing workflow error contract. The regression verifies `WorkflowExecutionConflictError` and preservation of the ordinary execution.

All four earlier advisory-lock survivors were detected by direct assertions. The new conflict handling changed the corpus from 136 to 143 mutations. A shortcut that now falls through to the same result with extra database work and the defensive empty-result branches remain visible in the review. The ordinary start participates in the race through its public entry point. The mutated scope is still `workflow-execution-retry`. [Workflow analysis and classification](./mutation_testing_workflow_retry.md#november-11-postgresql-concurrency-follow-up)

## Worker scheduler

The `workers-scheduler` profile selects the lifecycle, pressure, readiness, allocation, admission, lease maintenance, observation and handler-slot ranges left outside `workers-delivery`. The profile test verifies that the two selections partition the entire scheduler file. The change adds 27 scheduler tests covering pressure states, readiness caching, reservation weights, handler and hold saturation, shutdown policies and renewal races. The final five cover cancellation of an active handler, combined stop failures and requeue of a batch peer after reservation loss while waiting for a handler slot.

A reservation returning during shutdown could launch a handler or remain leased after release shutdown had already collected its references. The scheduler now publishes cycle ownership before reentrant callbacks, closes admission around asynchronous storage calls, and disposes of late reservations according to the selected shutdown policy. Shutdown drains both outcome buffers before releasing remaining reservations and reporting their failures.

The scheduler uses renewed reservation tokens to detect confirmed ownership loss. It cancels the affected invocation and skips known stale outcomes before handing them off. When reservation loss cancels a batch, it retains explicit outcomes for its still-owned members and returns unreported peers without charging an attempt. A successful progressive acknowledgement can also commit before its response arrives. That completed member stops controlling batch cancellation while the acknowledgement drains.

The worker fixture changes also check in-memory settlement directly and release fixture-owned scopes and containers after failed assertions. This helps distinguish lost progress in the scheduler from a Vitest deadline. The delivery refresh covers supporting changes to invocation execution and outcome persistence. It uses the preserved November 10 final report as its reference and the passing worker test snapshot from before the last five scheduler tests. [Scheduler residual classification](./mutation_testing_workers_scheduler_classification.json)

In the delivery refresh, the ownership check filters the placeholder introduced by the completion-array mutant. That earlier kill now survives as extra internal work. The six final delivery `Timeout` statuses report Stryker execution limits, and no delivery kill relies on a Vitest deadline. The detailed comparison records changes in surrounding source and leaves the material delivery survivors in review.

The local archives under `artifacts/mutation/nov11-scheduler-baselines/` preserve each measured pair and the earlier November 10 references. The session evidence records exact report and embedded source hashes. The worker and workflow fixes introduce or rewrite mutation sites. The unchanged-line comparisons pair only matching spans and keep the rest separate.

## Validation

The final checkout passes 2,480 non-isolated tests across 287 files. The framework typecheck, framework and playground build, documentation build, 58 mutation infrastructure tests, ownership boundary check and 35-lot inventory check pass.
