# Workflow component mutation review

The November 11 assessment covers all 38 workflow candidate files. Twenty bounded profiles partition the component, including the workflow-only `retryTask` range in `postgres-ownership`. The mutation infrastructure suite checks the partition against every selected source line. Export-only and type-only files can belong to the partition without generating mutants.

| Scope | Findings and residual review |
| --- | --- |
| Runtime, scheduler and activity transports | [Execution and transport review](mutation_testing_workflow_runtime_review.md) |
| Replay, client and operator operations | [Replay and operations review](mutation_testing_workflow_operations_replay_review.md) |
| Public definitions, serialization, concurrency and fixtures | [Workflow contract review](mutation_testing_workflow_contracts.md) |
| Memory and PostgreSQL adapters, schemas and ownership | [Workflow adapter review](mutation_testing_workflow_adapters.md) |

The [session ledger](mutation_testing_workflow_review_session.json) records the resolved mutation selections, report hashes, local timings, exact counts and unchanged-source comparisons. It retains earlier ownership and retry reports where the selected source spans remain identical. Static mutants were eligible. Vitest deadline detections, Stryker execution limits and declaration import errors have separate entries. The before and after raw counts can have different denominators where a fix rewrote production expressions.

The adapter tests use controlled time, live PostgreSQL transactions and multiple isolated database sessions to check rollback, stale ownership, continuation, ordering, child admission and parallel activity results. Replay tests distinguish a durable command from a suspended application promise and verify that recorded results and failures remain stable. Transport tests exercise actual Worker delivery and journal completion across generations. Residual classifications record defensive or low-impact differences and the boundaries of the SQL, schema and test runner evidence. No score threshold is applied.
