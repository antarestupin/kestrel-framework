# Workflow retry identity and input preservation

[Framework assessment](./mutation_testing_framework.md) · [Coverage inventory](./mutation_testing_inventory.md) · [Workflow operations](./workflows.md#operational-api)

The November 10, 2026 bounded workflow assessment selected complete `retryExecution` implementations in the memory and PostgreSQL adapters. The memory scope includes the new private creation helper between `retryExecution` and `releaseTasks`. Other terminal operations, `startMany`, concurrency admission helpers and the general SQL transaction implementation are dependencies rather than mutated sources in this lot. The November 10 before report is archived under `artifacts/mutation/workflow-execution-retry-before-two-hour-tests/`. The final report from that date is preserved under `artifacts/mutation/nov11-scheduler-baselines/historical-workflow-execution-retry/`.

## Demonstrated production defects

### Memory retries could attach to an unrelated active execution

A failed execution can retain a keyed `return-existing` or `reject` policy used by ordinary starts. When another execution then owns the key, the old memory `retryExecution` delegated to an ordinary start with that policy. `return-existing` returned the unrelated active execution, rewrote its `retryOfExecutionId`, and never created the requested retry identity. `reject` refused an operator retry that the PostgreSQL implementation correctly creates as pending under execution-scoped capacity.

Six policy/scope cases cover `enqueue`, `reject` and `return-existing` under execution and active-work scopes. Four failed against the original implementation: both reject cases threw and both return-existing cases returned the wrong identity. The fix uses a temporary enqueue admission policy for retry creation, then restores the original persisted concurrency metadata. The retry owns its requested identity and obeys capacity without changing the failed source or unrelated active run.

### PostgreSQL retries lost a present null original input

The previous original-input expression used `source.initialInput?.value ?? source.input ?? null`. A present snapshot containing `{ value: null }` was therefore treated as missing. After `continueAsNew` changed the current generation input, a failed run retried with that later input rather than its original null value.

The new regression starts with null, continues with an object, fails that generation and retries at a newer version. It failed against the original code: the retry contained the continued-generation object. The fix distinguishes a missing legacy snapshot from a present snapshot whose value is null. Separate legacy null/object cases retain the existing fallback behavior. Input snapshot assertions and a memory continued-generation case protect the same public contract across both adapters.

### Concurrent memory retries saw an unlinked target

The old memory implementation awaited `start` before assigning the retry link. The target had already become visible to another caller, which rejected the same source/target pair as a conflicting unrelated execution. A concurrent regression failed with one fulfilled and two rejected operations instead of one creation and two idempotent reads.

The memory adapter now publishes an in-flight job before invoking creation or task-ID generation. Same-source callers share completion and return independent snapshots with `created: false`; a different source still conflicts. Identity/version fields are captured before work so cleanup retains ownership of the original map entry. Both success and failure remove that exact entry. Tests verify reentrant ID generation, failure recovery and later idempotent reads observing a target's updated completed state instead of a retained stale snapshot. The existing first-creation-wins version policy is preserved.

## Test and mutation interpretation

The final memory tests include a controlled completion fixture that observes successful and rejected jobs after one event-loop drain. Its storage, clock and ID generation are synchronous, with only finite promise continuations left to drain. A removed resolve/reject therefore produces an immediate missing-outcome assertion instead of waiting for a generic five-second test deadline. This is a fixture-specific completion check, not a new application latency guarantee.

The ownership companion assessment independently covers release/extension generation tokens, changed-reference order, state preservation, lease bounds and PostgreSQL server-clock dates. Its [classification](./mutation_testing_workflow_task_ownership_classification.json) explicitly separates unconstrained diagnostics from extra empty-transaction work and failure observations. Source files also changed outside those ownership ranges because of the retry fixes, so that comparison uses selected normalized expressions rather than identical whole-file hashes.

No public API wrapper or backend-specific provider subclass was introduced. The [usage guide](../usage/workflows.md) and [implementation contract](./workflows.md#operational-api) explain operator retry identity, original input and concurrency behavior. Mutation results must retain their source-change-aware comparison; the before and after retry corpora need not have equal totals after the new job-publication logic is introduced. Static/runtime outcomes and native SQL errors are not interchangeable with behavior assertions, and SQL AST mutation does not systematically challenge every transaction predicate or interleaving.

## November 10 before and after

| Result | Before | Final result |
| --- | ---: | ---: |
| Mutants | 97 | 136 |
| Killed | 28 | 121 |
| Survived | 28 | 13 |
| NoCoverage | 41 | 2 |
| Timeout / runtime errors | 0 / 0 | 0 / 0 |
| Baseline tests | 139 | 214 |
| Elapsed | 18 seconds | 37 seconds |

The [durable classification](./mutation_testing_workflow_retry_classification.json) matches 89 logical-operation/expression/operator/replacement/occurrence sites. The previous memory creation body maps to its extracted private helper; new job-publication sites remain separate. All 23 matched original kills remain killed, 22 former survivors and 32 formerly uncovered sites are now killed. Eight old body/site variants disappeared and 47 new variants were introduced, so the two totals are not one identical corpus. Every executed mutant completed at least one test, and no kill depended on a Vitest test timeout. The final run retained static mutants and stayed under ten minutes without reused outcomes.

The thirteen survivors include four advisory-lock changes with concurrency/contention implications. The two uncovered mutants belong to the defensive missing-RETURNING-row branch. Exact residual reasons and report/embedded source/test hashes are retained in the classification. These are local observations with other validation activity, not a performance benchmark; no threshold or exclusions were added.

## November 11 PostgreSQL concurrency follow-up

Four tests use two real PostgreSQL transactions sharing schema-qualified fixture tables. The first adapter runs inside an outer transaction so its completed start or retry remains uncommitted. The second adapter contends on a separate connection. An observer samples `pg_locks` and `pg_blocking_pids()` for that exact pair, or observes the second operation settle while the owner remains uncommitted. The fixture then releases the owner, drains the contender and cleans up both tables. A statement deadline bounds unexpected database stalls.

An ordinary start claims the last permit under a limit of one. The retry waits for the start to commit, then creates a pending execution with no activation and no permit. Two retries from different failed sources targeting the same identity serialize and produce one committed retry and one `WorkflowExecutionConflictError`. Independent retry identities can progress while the first retry remains uncommitted.

The fourth test exposed a production defect when an ordinary start claimed the same identity requested by the retry. The retry's first lookup could run before the start committed. Its subsequent insert then raised a Drizzle query error carrying PostgreSQL `23505`, even after the shared business-key lock correctly serialized admission. The insert now handles conflicts on the execution ID and looks up the winning row in a fresh statement. The existing identity check reports `WorkflowExecutionConflictError`, and the winning ordinary start retains its identity and single activation. The full PostgreSQL adapter suite passes 68 tests.

| Result | Before | After |
| --- | ---: | ---: |
| Mutants | 136 | 143 |
| Killed | 121 | 129 |
| Survived | 13 | 10 |
| NoCoverage | 2 | 4 |
| Timeout / runtime errors | 0 / 0 | 0 / 0 |
| Baseline tests | 214 | 218 |
| Elapsed | 38 seconds | 38 seconds |

Each fresh run retained static mutants and completed within its ten-minute budget. The selected range covers both retry implementations. The normal start path runs as a real dependency. None of the detected mutants depended on a Vitest test deadline.

All four advisory-lock survivors from November 10 are now detected by direct assertions. Omitting or changing the business-key lock fails the last-permit result assertion. Changing the identity lock to a constant key blocks the independent retry. Omitting the identity lock makes the contender wait on the uncommitted target insert after accessing rows. The test observes this change in the lock boundary, while the new insert fallback preserves the final typed conflict.

Expression matching pairs 132 sites, with 117 prior kills preserved and five former survivors now killed. One matched initial-result guard moved from killed to survived because the conflict fallback now recovers the same compatible retry after an extra attempted insert and possible business-key wait. Three new uncovered variants occur after the fresh lookup, which throws the expected typed conflict before those lines in the tested race. The other uncovered variant changes the defensive missing-result diagnostic. The [race classification](./mutation_testing_workflow_retry_races_classification.json) records exact transitions, remaining mutants and report hashes.
