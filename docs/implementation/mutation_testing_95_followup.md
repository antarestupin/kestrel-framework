# Mutation follow-up for the remaining components

[Component inventory](./mutation_testing_inventory.md) · [Running mutation tests](../contributing/mutation-testing.md)

This follow-up compares `actions`, `database`, `db`, `workers` and `workflows` against revision `c2a1fdb`. The named profiles retain static and hybrid mutants and use a ten-minute limit per execution. The target is 95% across the eligible mutants in each component. Stryker counts execution timeouts as detections and records initialization errors separately.

## Results

Outcome columns report Killed / Survived / NoCoverage / Timeout / RuntimeError / CompileError / Ignored. Scores for incomplete comparisons describe their verified profiles.

| Component | Verified profiles | Before outcomes | After outcomes | Score before → after |
| --- | ---: | --- | --- | ---: |
| `actions` | 1/1 | 226 / 12 / 0 / 0 / 0 / 0 / 0 | 233 / 5 / 0 / 0 / 0 / 0 / 0 | 94.96% → 97.90% |
| `database` | 1/1 | 172 / 16 / 0 / 0 / 0 / 0 / 0 | 169 / 6 / 0 / 0 / 0 / 0 / 0 | 91.49% → 96.57% |
| `db` | 13/13 | 2304 / 186 / 9 / 10 / 126 / 0 / 0 | 2386 / 114 / 2 / 10 / 118 / 0 / 0 | 92.23% → 95.38% |
| `workers` | 7/7 | 1915 / 230 / 13 / 3 / 41 / 0 / 0 | 2094 / 78 / 7 / 4 / 0 / 0 / 0 | 88.76% → 96.11% |
| `workflows` | 26/26 | 5928 / 907 / 56 / 44 / 106 / 0 / 0 | 6672 / 278 / 20 / 19 / 106 / 0 / 0 | 86.11% → 95.74% |

### Per-profile executions

| Profile | Before → after mutants | Before / after seconds | Score before → after |
| --- | ---: | ---: | ---: |
| `component-actions` | 238 → 238 | 350 / 452 | 94.96% → 97.90% |
| `component-database` | 188 → 175 | 144 / 163 | 91.49% → 96.57% |
| `db-provider` | 359 → 360 | 560 / 463 | 92.46% → 93.04% |
| `db-instrumentation` | 357 → 324 | 353 / 332 | 80.90% → 91.95% |
| `db-repository` | 329 → 329 | 242 / 340 | 96.35% → 96.96% |
| `db-history-declarations` | 62 → 62 | 72 / 79 | 80.77% → 92.31% |
| `db-history-column-types` | 118 → 118 | 111 / 84 | 100.00% → 100.00% |
| `db-history-identities` | 92 → 92 | 89 / 63 | 95.77% → 95.77% |
| `db-history-events` | 246 → 246 | 243 / 203 | 91.28% → 98.50% |
| `db-reference-counter-declarations` | 181 → 181 | 129 / 130 | 89.83% → 97.22% |
| `db-reference-counter-discovery` | 48 → 48 | 148 / 141 | 97.92% → 97.92% |
| `db-reference-counter-runtime` | 135 → 136 | 296 / 272 | 94.57% → 95.38% |
| `db-schema-table-metadata` | 116 → 147 | 96 / 142 | 97.37% → 97.24% |
| `db-schema-migrations` | 496 → 491 | 349 / 341 | 94.76% → 94.70% |
| `db-schema-descriptions` | 96 → 96 | 120 / 146 | 96.88% → 96.88% |
| `workers-contracts` | 344 → 344 | 359 / 321 | 92.15% → 99.42% |
| `workers-adapter-memory` | 255 → 256 | 280 / 315 | 92.55% → 98.44% |
| `workers-adapter-postgres` | 228 → 228 | 228 / 255 | 97.37% → 98.25% |
| `workers-adapter-schema` | 111 → 111 | 269 / 290 | 64.29% → 80.18% |
| `workers-delivery` | 368 → 369 | 381 / 319 | 92.93% → 96.75% |
| `workers-scheduler` | 717 → 690 | 460 / 69 | 83.26% → 95.07% |
| `workers-publication` | 179 → 185 | 207 / 294 | 88.83% → 96.22% |
| `workflow-activation-memory` | 107 → 100 | 182 / 53 | 100.00% → 98.00% |
| `workflow-activation-postgres` | 471 → 432 | 63 / 33 | 85.35% → 94.21% |
| `workflow-memory-admission` | 431 → 444 | 513 / 197 | 90.02% → 94.59% |
| `workflow-memory-operations` | 386 → 407 | 364 / 24 | 84.72% → 95.58% |
| `workflow-memory-internals` | 147 → 176 | 93 / 95 | 75.51% → 90.91% |
| `workflow-memory-commands` | 248 → 248 | 335 / 93 | 83.47% → 97.58% |
| `workflow-memory-projections` | 158 → 147 | 188 / 75 | 67.72% → 97.28% |
| `workflow-memory-validation` | 235 → 214 | 293 / 93 | 81.70% → 98.13% |
| `workflow-postgres-start` | 58 → 58 | 118 / 18 | 87.93% → 94.83% |
| `workflow-postgres-reservation` | 182 → 231 | 202 / 57 | 92.86% → 95.67% |
| `workflow-postgres-activities` | 99 → 99 | 96 / 118 | 90.91% → 93.94% |
| `workflow-postgres-history` | 94 → 94 | 106 / 114 | 91.49% → 95.74% |
| `workflow-postgres-admission-internals` | 113 → 132 | 147 / 23 | 80.53% → 93.18% |
| `workflow-postgres-row-mapping` | 214 → 163 | 393 / 317 | 71.50% → 98.16% |
| `workflow-postgres-history-decoding` | 246 → 225 | 299 / 295 | 73.58% → 97.33% |
| `workflow-runtime` | 305 → 307 | 257 / 256 | 95.41% → 95.11% |
| `workflow-scheduler` | 476 → 504 | 297 / 25 | 77.52% → 97.02% |
| `workflow-transports` | 454 → 458 | 418 / 166 | 81.72% → 96.94% |
| `workflow-replay` | 746 → 767 | 360 / 26 | 85.66% → 97.26% |
| `workflow-operations` | 502 → 516 | 507 / 40 | 90.84% → 96.71% |
| `workflow-contracts` | 493 → 493 | 473 / 436 | 98.98% → 98.98% |
| `workflow-adapter-contracts` | 340 → 340 | 204 / 78 | 85.77% → 83.26% |
| `workflow-terminal-control` | 311 → 315 | 247 / 101 | 92.93% → 93.33% |
| `workflow-task-ownership` | 75 → 75 | 95 / 12 | 94.67% → 100.00% |
| `workflow-execution-retry` | 143 → 143 | 162 / 71 | 90.21% → 93.01% |
| `postgres-ownership` | 7 → 7 | 31 / 47 | 100.00% → 100.00% |

## Defects and residuals

### Actions

The pagination tests now check the public validation issue for a null structured cursor, a valid token carrying the wrong data type and an invalid next cursor. Numbered pagination checks identify the invalid configuration field and distinguish inconsistent bounds from a non-positive size.

The five remaining mutations change optional description property presence or validation text outside the assertions. No production defect was reproduced in this component.

### Database maintenance

When two seed steps used projections of the same physical table, preflight validated the identity of the first step and skipped the second. A later missing identity could therefore leave an earlier insert in a caller-owned transaction that handled the exception and continued. The seeder now validates each step before writing, while still checking table emptiness once per physical table. The regression uses a live PostgreSQL transaction and verifies the absence of a partial write.

The remaining variants change the preflight projection, omit a fast path for an empty identity set, widen an internal comparison after the primitive check, or represent missing Drizzle Seed options as explicitly undefined. The seeder reuses the shared object guard when comparing decoded structured identities.

### PostgreSQL database runtime

- Instrumentation could invoke an accessor while inspecting query arguments and prevent PostgreSQL dispatch. Failure and parameter encoding could also discard the observation, and bare async stack frames could resolve to Node internals. The query still reaches the driver, and diagnostic reads tolerate unreadable inputs.
- Reusing the same pool error object after a successful recovery could suppress a later failure. Recovery resets the failure tracking window.
- Two distinct history contributions could choose the same trigger function name, including collisions between long identifiers. The physical destination schema and table identify the writer. Long identifiers include a digest of the full name. Regenerate affected migration contributions to update installed trigger functions. A legacy installation whose triggers already share a function needs the migration ordering described in the [history table guide](../usage/database.md#track-row-history).
- Invalid embedded or sidecar migration lifecycle SQL and duplicate contribution IDs could be discovered after Drizzle changed the migration files. The generator validates those inputs before invoking Drizzle.
- A reference-counter progress callback could mutate the rebuild cursor and skip later targets. Callbacks now receive detached progress data.

Remaining mutants concentrate in query diagnostics, pool recovery and migration validation. Several affect fallback text, defensive guards or driver diagnostics outside the current assertions. Import-time schema errors are reported separately from surviving mutants.

### Workers

- The memory adapter retained caller-owned retry, deferral and dead-letter dates or error metadata. A failed dead-letter ID allocation could also delete the live reservation before recording its failure.
- A sparse publication batch could write part of the batch before rejecting in both built-in adapters. Input slots are checked before publication.
- A handler that mutated the delivered job could change the acknowledgement identity or break batch correlation. The scheduler keeps its own reservation identity.
- Starting polling could replace the cancellation controller of a running one-shot handler. Failed worker runtime construction could also leave a drain callback registered against an incomplete runtime.
- Mutating a worker's throttling report could change the scheduler's cost or deadline for reconciliation. The scheduler retains its own accounting data. It also rejects a combined batch cost that overflows when individually finite costs are added.

The PostgreSQL worker schema still has equivalent mutations for explicit SQL names that match their inferred names and for the default timestamp mode. The remaining scheduler mutants cover fallback diagnostics, internal queue invariants and timing behavior. Four delivery variants hit the Stryker limit after changing the polling loop.

### Workflows

- A matching explicit ID could refer to a terminal child from a previous generation. The new parent generation then waited for a completion that could never arrive. Both built-in adapters reject terminal child reuse and preserve the preceding history. PostgreSQL uses the stored admission decision when a compatible active child already owns the requested ID.
- The memory adapter could record a signal, an activity completion or a synchronous capture before allocating the task that wakes the workflow. A failed allocation left the journal advanced and blocked a clean retry. The adapter prepares the wake-up before applying those writes.
- In memory, a failed allocation could leave `continueAsNew()` on a new generation without a task, or leave version recovery queued with its original error erased. The original generation or blocked execution remains retryable until its wake-up can be prepared.
- A memory child could reach a terminal state before its waiting parent's wake-up was allocated. Successful activation, forced termination and cancellation of a pending child now prepare that wake-up before publishing the terminal result.
- Releasing a retained concurrency permit could strand pending executions. In memory, a task allocation failure now leaves the pending group eligible for a later workflow poll. PostgreSQL now periodically rechecks groups whose waiting rows were locked when capacity opened. Recovery uses the same keyed advisory lock and admits only after recounting capacity. Other reservations remain usable when a recovery attempt fails.
- A failed second reservation-token allocation could leave the first memory workflow task or outbox dispatch leased without returning it to the caller. Token allocation now finishes before applying any reservation from the batch.
- Dates supplied by a custom clock and dates returned through memory inspection could share references with stored workflow state. The adapter copies the clock value and the returned signal and outbox timestamps. It also returns `false` for an external activity result for an unknown execution, consistent with PostgreSQL.
- A task-scope error could be replaced by a release failure, and failed lease renewal could release the same token twice. Failed publication could also lose the original queue error when rescheduling failed. The scheduler and transport preserve independent causes and settle ownership once.
- A handler could catch a capture codec error and leave a placeholder in the journal. Concurrent continuation calls could also both encode their inputs, and a later caught continuation interruption could hide a separate handler failure. Replay keeps one continuation and fails a capture whose durable value cannot be encoded.
- An empty explicit child ID could reach adapter commit, and an archived child could be associated with an unrelated command after the parent reused a command sequence. Child IDs are checked before scheduling, and the operator graph validates the current generation's child identity.
- A throwing telemetry destination could suppress the independent observer and a later lifecycle record. Failures in the two destinations are isolated.

The workflow PostgreSQL schema retains equivalent same-name and default-date mutations. The retry and activation profiles also retain variants of defensive guards and omitted values that resolve to the same stored state under the current schema. The individual profile counts keep these outcomes visible in the aggregate.

## Evidence

The local archive is `artifacts/mutation/close95/`. It keeps the before and after reports, execution metadata, selection audit and preserved partial checkpoints. The full-component score includes only disjoint scopes and uses raw Stryker outcomes.

Some static-heavy database profiles use explicit Vitest includes in `vitest.mutation.config.ts`. They leave Stryker's test-files filter empty. The latter causes runtime activation after module collection, which can hide import-time mutations. The diagnostic reports using that filter are archived separately. A custom-type declaration that changes the SQL type or driver conversions verifies the corrected static activation.

Each time in the profile table is the duration of the archived execution, including an incremental continuation when a previous invocation hit the limit. Execution metadata links to the saved checkpoint or prior report. Candidate scopes were instrumented both as components and as profile partitions, and the sets matched without gaps or overlaps. The aggregate uses the complete outcome for each profile, weighted by its number of eligible mutants. Startup errors remain visible in the outcome counts.

As a timing sensitivity check, removing Stryker timeout detections and Vitest deadline kills from the numerator gives 93.39% for `db`, 95.92% for `workers` and 95.44% for `workflows`. The `db` deadline kills are concentrated in pool acquisition and shutdown, reference-counter cancellation and subprocess completion. Those cases exercise failure to settle or interrupt pending work. The other two components have no detections of either kind.

Validation covered 5,200 unit and integration tests, the mutation infrastructure suite, framework type checking, the framework and playground build, the documentation build, the framework boundary check and the inventory checker.
