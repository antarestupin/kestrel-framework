# Asynchronous runtime mutation assessment

[Framework findings](./mutation_testing_framework.md) · [Coverage inventory](./mutation_testing_inventory.md) · [Contributor commands](../contributing/mutation-testing.md) · [Session evidence](./mutation_testing_async_runtime_session.json)

The November 10, 2026 assessment addresses scheduled tasks, workers, workflow adapter ownership/operator control, and outbound HTTP resilience, followed by the adjacent background host. The authorized session began at 13:28:42 UTC, with a two-hour maximum and the final fifteen minutes reserved for consolidation. Each named before/after execution retains static mutants, starts fresh, and uses the existing ten-minute budget including its instrumented baseline. Up to two campaigns ran concurrently against separately owned databases; durations are local observations rather than a controlled performance benchmark. No score gate or mutation exclusion was added.

The session adds 496 test cases: 174 for scheduled tasks, 162 for workers, 75 for workflows, 69 for outbound resilience and 16 for the background host. Existing tests were also strengthened.

## Before and after

| Profile | Before Killed / Survived / NoCoverage | After Killed / Survived / NoCoverage | Final Timeout / RuntimeError | Seconds before → after |
| --- | --- | --- | --- | ---: |
| `scheduled-runtime` | 142 / 137 / 181 | 419 / 71 / 5 | 18 / 0 | 66 → 312 |
| `scheduled-adapters` | 263 / 209 / 173 | 586 / 51 / 8 | 0 / 25 | 140 → 180 |
| `scheduled-contracts` | 164 / 95 / 36 | 275 / 16 / 0 | 1 / 0 | 88 → 87 |
| `workers-publication` | 128 / 23 / 12 | 159 / 20 / 0 | 0 / 0 | 45 → 56 |
| `workers-delivery` | 168 / 54 / 38 | 271 / 35 / 2 | 5 / 0 | 107 → 79 |
| `workers-adapters` | 313 / 189 / 51 | 498 / 55 / 0 | 0 / 41 | 175 → 170 |
| `workers-contracts` | 186 / 103 / 55 | 317 / 27 / 0 | 0 / 0 | 102 → 97 |
| `workflow-task-ownership` | 30 / 16 / 29 | 71 / 4 / 0 | 0 / 0 | 16 → 19 |
| `workflow-execution-retry` | 28 / 28 / 41 | 121 / 13 / 2 | 0 / 0 | 18 → 37 |
| `workflow-terminal-control` | 99 / 91 / 81 | 282 / 31 / 1 | 6 / 0 | 54 → 75 |
| `outbound-resilience` | 188 / 96 / 50 | 313 / 33 / 1 | 1 / 0 | 146 → 154 |
| `component-background` | 78 / 26 / 39 | 134 / 10 / 0 | 1 / 0 | 49 → 54 |

Production fixes change mutation expressions and sometimes totals. Equal totals do not prove identical corpora, and different totals cannot be interpreted as a pure test-only improvement. The dedicated classification records identify expression matches where possible. The session evidence stores report hashes, source hashes, executed test-source hashes, resolved scopes, timeout observations and the current configuration/lockfile hashes. Original reports are archived under `artifacts/mutation/<profile>-before-two-hour-tests/`; raw HTML/JSON and intermediate event records remain ignored local artifacts. The durable evidence does not depend on those artifacts being distributed with the repository.

The three scheduled-task profiles partition all nineteen current candidate files exactly once, including type-only/re-export candidates that may produce no mutations. This establishes execution extent, not complete behavioral review. The worker profiles leave scheduler admission, pressure/allocation and lease-maintenance ranges outside their mutation selections. Workflow profiles select adapter ownership, retry and terminal operations; workflow runtime, scheduler, serialization and other adapter operations remain outside them. Outbound resilience selects three entire implementation files out of seventeen candidate files. Parent states in the inventory preserve these limits.

The background follow-up added related tests after the primary reports were frozen. Each report remains a reference for its recorded source/test inputs, rather than a claim that every profile ran the final checkout's complete test suite. The final ordinary validation includes all additions.

## Demonstrated defects

### Scheduled tasks

Startup and reconciliation could be reentered before their ownership promises were published; concurrent scheduler starts could create duplicate polling work. Stopping during initialization or admission could return while adapter work was pending or admit a newly reserved invocation afterward. Startup now claims ownership before callbacks run, and stopping drains owned initialization/admission work and releases late reservations.

Heartbeat renewal ignored a false ownership result and could abandon a pending sibling lock renewal after another promise rejected. Each invocation now receives cancellation when ownership fails, while cleanup waits for all started renewal writes. Failure presence is tracked independently from its value, preserving JavaScript rejections with undefined/null both in handler completion and renewal cleanup rather than recording success or replacing their raw cause with AbortController's default reason.

Memory restoration could replace an older consumed manual trigger with a newer pending one, unlike PostgreSQL's earliest-date behavior. The memory backend now restores the earliest occurrence. Cron schedules documented as UTC inherited the host timezone when no timezone was supplied; parsing and occurrence calculations now explicitly use UTC while retaining optional metadata omission.

[Scheduled-task tests and residual review](./mutation_testing_scheduled_tasks.md).

### Workers

Acknowledgement groups, correlated result handoffs and terminal queue transitions used fail-fast aggregation. A rejection could return control while sibling storage writes were pending, allowing lease maintenance or scope disposal to end too soon. A separate invocation-creation failure could also abandon running sibling handlers and their successful outcomes. The affected paths now wait for every started operation, persist fulfilled sibling outcomes and preserve single or aggregate causes.

PostgreSQL reservation rows returned timestamp strings from raw Drizzle execution despite the public `ReservedJob` Date contract. Mapping now normalizes all three reservation timestamps. Tests assert usable Date values rather than assuming the driver always performs the conversion.

[Worker tests and residual review](./mutation_testing_workers_followup.md).

### Workflows

Memory operator retries inherited ordinary keyed-start conflict policies, which could reject the requested retry or attach it to an unrelated active execution. Creation now uses enqueue admission for the new retry identity and restores the original persisted policy afterward. Concurrent/reentrant retries publish a shared in-flight operation before ID-generation callbacks or partially linked targets become visible. PostgreSQL retries distinguish a present null original-input snapshot from a missing legacy snapshot, preserving original input across continued generations.

Memory force termination now traverses closed intermediate executions to reach open descendants. Terminal waiters receive snapshots after concurrency permits and parent/child cleanup are finalized. The waiter-order changes in `applyActivationOutcome` are supporting source changes outside the frozen terminal mutation ranges, protected by ordinary public regression tests. PostgreSQL cancellation of a capacity-pending child now records its parent command completion and wakes the waiting parent, while preserving terminal parent states.

[Retry review](./mutation_testing_workflow_retry.md) · [Terminal control review](./mutation_testing_workflow_terminal.md) · [Task ownership classification](./mutation_testing_workflow_task_ownership_classification.json).

### Outbound HTTP

Jittered backoff after transport errors could exceed `maxDelayMs`, although the response-status path applied that cap. The shared jitter helper now applies the cap to both paths. A configured backoff exceeding Node's single-timer range was silently clamped to approximately one millisecond by the runtime, causing retries almost immediately. Backoff now maintains one monotonic deadline with bounded timer intervals, preserving cancellation and timer cleanup. Tests demonstrate both defects through fake transports and controlled timers, without HTTP listeners.

The additional contracts cover default retry methods/statuses, attempt boundaries, replayed request bodies, Retry-After dates and negative values, middleware priority, caller cancellation, deadline pre/post checks, streaming error propagation, lazy reads, shared truncation state, and exact response budgets. [Outbound residual classification](./mutation_testing_outbound_resilience_classification.json).

### Background host

A synchronous stop callback was evaluated before `Promise.allSettled` received its input. Its throw interrupted array mapping and skipped later peer stops entirely. Scheduling each callback through a promise now preserves reverse dispatch order, attempts every owned peer and waits for the complete drain before reporting failures. Sixteen new cases cover synchronous/asynchronous failure aggregation, partial startup, selection, startup completion/cancellation boundaries and provider/CLI composition. The four current candidate files received a complete assessment; residual steady-state completion evidence still needs stronger controlled assertions. [Background assessment](./mutation_testing_background.md) · [Classification](./mutation_testing_background_classification.json).

## Interpreting residuals and remaining work

Survivors, NoCoverage, runtime-invalid declarations, Stryker timeouts and assertion kills caused by Vitest timeouts remain separate in the durable records. A hit-limit termination is useful evidence of unbounded execution but is not an ordinary behavior assertion. Invalid import-time schema mutations are not infrastructure failures or test kills. Schema metadata and actual DDL constraint semantics also require different interpretations; manually constructed integration tables do not automatically prove the exported schema's migration behavior.

Some survivors represent observable work, contention, optional-property shape or synthetic cause differences even when ordinary successful outputs agree. They remain visible with a deferred contract decision rather than being relabeled as strictly equivalent. SQL AST mutation does not systematically alter embedded SQL predicates, and connection-local temporary-table fixtures cannot establish multi-connection advisory-lock races. Those concurrency and schema gaps require dedicated follow-up fixtures.

The final raw Killed totals include 53 scheduled-runtime, seven scheduled-adapter, two worker-contract, thirty outbound and five background outcomes whose reported detection reason is a five-second Vitest deadline. They remain separate from Stryker Timeout statuses and direct assertion failures. Several remove a callback that a gated fixture awaits; replacing those waits with controlled outcome assertions is a useful reliability and runtime improvement. Eight matched scheduled-runtime outcomes also moved from Killed to Timeout after lifecycle changes, so the classification preserves the weaker detection evidence instead of claiming unchanged assertion kills.

Prioritize material residuals and the unassessed worker scheduler ranges before broadening workflow runtime/serialization and remaining outbound middleware/client operations. Reassess changed contracts with fresh references. Informational results remain appropriate while component coverage and residual policies are incomplete; no global blocking threshold follows from these selected lots.

## Validation

Final validation passes 2,449 tests in 286 files with `--no-isolate`, the framework/playground build, framework type checking, documentation build, all 56 mutation-infrastructure checks, ownership boundaries and inventory alignment. The session evidence records these checks and the final report audit. Ordinary tests retain `--no-isolate`, restore globals and dispose owned resources. Framework/playground builds, type checking, contribution documentation, mutation infrastructure and inventory alignment are validated separately from mutation scores.
