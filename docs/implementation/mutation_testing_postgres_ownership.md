# PostgreSQL retry and lease ownership assessment

[Framework assessment](./mutation_testing_framework.md) · [Coverage inventory](./mutation_testing_inventory.md) · [Contributor commands](../contributing/mutation-testing.md)

On November 10, 2026, the bounded `postgres-ownership` profile assessed two complete adapter methods: `PostgresWorkflowAdapter.retryTask()` in `workflows/adapters/postgres/adapter.ts`, and `PostgresScheduledTaskAdapter.extendLease()` in `scheduled_tasks/adapters/postgres/adapter.ts`. Both fresh runs retained static/hybrid activation and used the same ten-minute limit, including baseline tests. Other adapter methods and the scheduler/runtime implementations are outside this selected scope.

| Result | Before | After |
| --- | --- | --- |
| Mutants | 14 | 14 |
| Killed | 0 | 14 |
| Survived | 14 | 0 |
| NoCoverage / timeout / errors | 0 / 0 / 0 | 0 / 0 / 0 |
| Baseline tests | 400 | 405 |
| Stryker elapsed | 13 seconds | 7 seconds |

Five integration cases were added to the existing adapter suites, using their connection-local PostgreSQL tables and releasing the owned client/pool through the existing teardown. Three workflow cases verify successful activity retry, exact `retryAt`, cleared reservation fields, preserved attempt and unrelated reservations, refusal of a real token belonging to another task, refusal after ownership is relinquished, missing task IDs, and rejection of timer/workflow reservations. Two scheduled-task cases verify that extending a lease uses PostgreSQL time and updates only the requested task/token pair, leaving another run of the same task and a different task untouched; wrong-task and stale-token requests return false without changing any row. Server timestamps bracket the expected expiration without sleeps or dependence on the host clock.

No production bug was demonstrated and no production behavior changed. The baseline survivors exposed absent tests for the two methods. All selected mutations are now killed, with no residual survivor or uncovered mutation to classify. These local timings are execution observations, not evidence of a speed improvement.

Stryker mutates TypeScript syntax, including Drizzle arguments and SQL template literals; it does not systematically mutate the meaning of embedded SQL or Lua. A killed empty SQL literal can reflect a syntax error rather than evidence that an ownership predicate is correct. The direct cross-task/stale-token/isolation assertions therefore remain necessary even with a 100% selected-scope score. This result does not establish correctness of arbitrary SQL predicate changes, concurrent transactions, or the surrounding workflow and scheduling components. Their parent lots remain partial until their other scopes have been assessed.

Before reports are archived under `artifacts/mutation/postgres-ownership-before-tests/`; the final report is under `artifacts/mutation/postgres-ownership/`. The targeted adapter suites pass 37 tests across two files. Global validation and report fingerprints are recorded in the consolidated framework assessment and inventory.
