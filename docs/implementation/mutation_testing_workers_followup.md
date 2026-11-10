# Workers mutation campaign

The 2026-11-10 bounded campaign separates publication, delivery, storage adapters and public composition contracts. Each invocation has a ten-minute wall-clock budget. These focused profiles retain static mutants; they do not inherit the framework-wide fast mode's `ignoreStatic` policy. Raw Stryker statuses remain visible and no blocking threshold or exclusions are introduced.

## Bounded results

`K` means Killed, `S` Survived, `NC` NoCoverage, `T` Stryker Timeout and `RE` RuntimeError. Timeouts and module-import errors are separate evidence categories, not direct assertion kills.

| Lot | Before K / S / NC / T / RE | Final K / S / NC / T / RE | Final duration |
| --- | --- | --- | --- |
| Publication | 128 / 23 / 12 / 0 / 0 | 159 / 20 / 0 / 0 / 0 | 56 seconds |
| Delivery | 168 / 54 / 38 / 3 / 0 | 271 / 35 / 2 / 5 / 0 | 79 seconds |
| Adapters | 313 / 189 / 51 / 0 / 41 | 498 / 55 / 0 / 0 / 41 | 170 seconds |
| Contracts | 186 / 103 / 55 / 0 / 0 | 317 / 27 / 0 / 0 / 0 | 97 seconds |

The production fixes change the publication corpus from 163 to 179 variants and delivery from 263 to 313 variants. Their respective comparisons match 162 and 258 unchanged sites. Adapters retain 594 variants, with 592 identical sites and two changed mapper-body variants. Contracts retain the same 344 variants. No previously killed matched variant regresses in these comparisons. The exact site transitions are recorded in each classification rather than inferred from a percentage alone.

There are 162 new worker test cases: 12 publication, 23 delivery, 46 adapters and 81 contracts. The final reports cover 1,430 disjoint mutation variants: 1,245 Killed, 137 Survived, two NoCoverage, five protective Stryker timeouts and 41 RuntimeErrors. Two contract kills still rely on Vitest timeouts; they remain distinguishable from direct assertions in the exact classification.

## Production defects demonstrated

Queue-scoped acknowledgement groups previously used `Promise.all()`. When one queue rejected while another queue's acknowledgement was still pending, `flush()` rejected before that sibling storage operation settled. Two regressions failed against the original implementation: one observed the early flush completion, and another observed that only the first error was retained. The buffer now waits for every group with `Promise.allSettled()`, preserves one original error directly and retains multiple causes in `AggregateError`.

The delivery cycle had the same early-drain problem at three ownership boundaries. A failed correlated-completion sink could end the cycle while another sink was still persisting. A failed acknowledgement or dead-letter transition could end the cycle while a retry write was still pending. Finally, an execution-scope creation failure could end the cycle while a sibling handler still ran, preventing that sibling's successful outcome from being persisted. Gated public-cycle regressions failed on the original source, demonstrating early cycle settlement and premature loss of heartbeat protection. The scheduler now settles every already-started invocation or storage operation, persists fulfilled peer outcomes and reports all causes after the drain. A failed invocation remains leased for normal replay; this change does not manufacture a handler outcome for an execution that never opened.

PostgreSQL reservations also violated their public timestamp contract. Raw Drizzle execution returned timestamp strings while `ReservedJob.availableAt`, `reservedAt` and `createdAt` promise `Date` values. An integration regression failed against the original implementation. The adapter now normalizes these three fields at its raw-query mapping boundary. This keeps date arithmetic usable and aligns PostgreSQL with the memory adapter.

## Coverage added

Publication tests cover complete metadata forwarding and detachment, single-job and bulk identity rules, UTF-8 budget boundaries, early all-or-nothing rejection, caller serialization causes, pending-count accounting and failure aggregation across buffer chunks and queues.

Delivery tests cover shared in-flight cycles, bounded reservation and queue rotation, exponential retry caps and terminal overrides, individual and batch result rules, progressive batch outcomes, correlated result ownership, batch overflow, lease cleanup, polling failure/cancellation, invocation failure and sibling persistence. Existing gated scheduler tests now assert that their handoff starts after a bounded asynchronous turn, rather than hanging until Vitest's timeout when a mutation removes that handoff.

Adapter tests cover each of the six token-guarded transitions with valid, stale-generation, cross-job and unknown-job references in the same batch; they verify exact changed-reference reporting and untouched peers. Further cases cover metadata propagation, identity conflict dimensions, ordering, clock boundaries, input guards, empty no-SQL paths, ready-queue selection and exact publication chunk boundaries. Dedicated factory tests check lazy explicit infrastructure resolution and injected memory settings. Actual exported PostgreSQL schema tests check migration provenance, raw SQL field mappings, ownership identities, durable defaults, date types and index access paths, separately from the temporary integration tables.

Composition tests cover configuration defaults/coercion/invalid values, declaration metadata and validation modes, batch/throttling tuning, result helper and retry error boundaries, dependency identifiers, namespace routing, bounded error serialization, minimal/standard provider boot, CLI workload registration, runtime idempotence, optional runtime admission/completion services and supervised failure cleanup. A configured provider is driven through a real job: pressure first blocks reservation, an injected clock allows healthy admission, and the configured owner persists the result before ACK. A standalone correlated job also checks that an absent optional completion owner does not install a broken callback.

## Evidence and remaining limits

The exact per-mutant fingerprints, raw statuses, classifications, source/test hashes and same-site before/after transitions are kept in the [publication](./mutation_testing_workers_publication_classification.json), [delivery](./mutation_testing_workers_delivery_classification.json), [adapters](./mutation_testing_workers_adapters_classification.json) and [contracts](./mutation_testing_workers_contracts_classification.json) classification JSON files. Numeric mutant IDs and line numbers are navigation aids only. A changed production body creates different variants; an increase in total mutants after a fix must not be reported as a same-corpus comparison.

The publication residuals include optional explicit-`undefined` properties and different internally synthesized serialization causes. Those differences preserve the currently specified publication behavior, but they are not unconditional JavaScript object-shape or error-cause equivalences. Caller-originated serialization errors retain exact cause identity in separate tests. Diagnostic text is also kept distinct from proven control-flow equivalence.

Invalid schema or description mutations can fail while the module is being imported. Stryker reports these as `RuntimeError`; they are recorded separately from assertion kills. Schema metadata assertions strengthen the actual exports but do not apply the generated production DDL to a live application schema, and ordinary TypeScript mutation does not exhaustively mutate SQL predicates.

The final adapter report leaves four generated-DDL expression gaps, three optional description-map surfaces and one duplicate-queue allocation input case. Other residuals include installed Drizzle column-name/date-mode fallbacks, optional explicit-`undefined` memory properties, pure extra traversal work and conditional internal invariants. In particular, the PostgreSQL SQL-NULL metadata leaks and memory multi-identity lookup variant were exposed as missing tests and are now killed; they were not reclassified as harmless property-shape differences.

Delivery retains material follow-ups: a repeated correlated yield can overwrite the first stored result when duplicate-result bookkeeping is removed; failed reservations need explicit local-lifetime checks; uncorrelated individual jobs need a configured-sink filtering case; application execution observations need failure-tag/cause assertions. Busy-poll delay, empty-reservation backend avoidance, duplicate ACK work and manual or mutated batch failure objects remain separately identified. The two uncovered variants belong to an unknown-queue integrity guard. The five Stryker timeouts hit protective loop limits. Eleven first-pass Vitest-timeout kills were converted to direct assertions by bounding existing handoff-start waits; the final delivery report has zero Vitest-timeout kills.

The contract residuals no longer contain provider forwarding or absent-owner behavior gaps. They contain 19 diagnostic literals, one help literal, three optional property representations, two absent optional internal settings and two missing-owner error-shape differences. Two detected variants still rely on a Vitest timeout: deleting the application drain callback prevents the older borrowed-storage fixture from reaching its release gate, and changing a short hold duration to 30 seconds exceeds its test budget. Future fixture hardening can make those detections direct without changing the raw results now.

The delivery profile intentionally covers selected execution and outcome ranges of `scheduler.ts`. Admission/throttling internals, reservation allocation, option normalization, lease-maintenance internals and scheduler start/stop are exercised as dependencies but remain a separate mutation lot. The current profiles therefore do not justify marking all Workers scheduler behavior complete. Deferred fault injection and metadata representation differences stay visible in the classification rather than being hidden through exclusions or a score adjustment.

The implementation and application-facing behavior are documented in [Workers implementation](./workers.md) and [Workers usage](../usage/workers.md). Mutation commands and contributor workflows belong to [the mutation-testing contribution guide](../contributing/mutation-testing.md).
