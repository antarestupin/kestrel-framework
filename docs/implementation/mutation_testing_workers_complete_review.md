# Workers mutation review

The five profiles cover every current production mutation candidate in `workers`. The scheduler and delivery profiles partition `scheduler.ts`, and the other profiles cover adapters, publication, and the definition and runtime contracts. The publication report was reused after verifying that every selected source file matched the archived report byte for byte. All new Stryker executions completed within the ten-minute budget.

| Profile | Baseline Killed / Survived / NoCoverage | Final Killed / Survived / NoCoverage | Final Timeout / RuntimeError | Final seconds |
| --- | ---: | ---: | ---: | ---: |
| `workers-scheduler` | 487 / 175 / 67 | 565 / 108 / 14 | 0 / 0 | 278 |
| `workers-delivery` | 288 / 40 / 2 | 331 / 22 / 2 | 1 / 0 | 98 |
| `workers-adapters` | 498 / 55 / 0 | 503 / 50 / 0 | 0 / 41 | 217 |
| `workers-contracts` | 317 / 27 / 0 | 317 / 27 / 0 | 0 / 0 | 113 |
| `workers-publication` | 159 / 20 / 0 | 159 / 20 / 0 | 0 / 0 | 56 |

The final counts contain 1,875 direct detections, 227 survivors, 16 uncovered variants, one Stryker timeout and 41 runtime errors. The ten earlier Vitest deadline detections are gone. The delivery timeout is an infinite polling loop after deleting the loop body. The 41 schema runtime errors arise before a behavior assertion can run. The [exact report paths, hashes, matching-site comparisons and residuals](./mutation_testing_workers_complete_review.json) retain those statuses separately. Scheduler and delivery changes alter the set of instrumented expressions, so the raw differences are separate from matching-site results.

## Production defects and direct checks

- A worker execution could retain its scope if observer resolution, start recording or completion recording threw. The scheduler now disposes the scope in each case while preserving the normal observation context. Tests check the completion outcome and the original error.
- An earlier admission listener could stop abort propagation and strand a waiting handler forever. The scheduler now uses Node's protected abort subscription and detaches it before handing off the slot. A bounded test reproduced the stalled cycle and verifies cancellation at both the slot handoff and stopped propagation boundaries.
- A batch handler could reuse a mutable failure object after yielding it. The previous scheduler read it again at the end of the invocation, where a new invalid attempt limit could reject the whole batch and discard an already accepted correlated peer result. The scheduler now snapshots the validated retry metadata and cause reference at the yield boundary.
- PostgreSQL could count a job twice in its selection limits when a direct adapter request repeated a queue. The adapter returned only two of three ready jobs in the first-pass reproduction and four of five in the overflow reproduction. Both built-in adapters now pass the same repeated-queue test contract. The schema tests also compile both UUID defaults and both partial-index predicates using the actual Drizzle exports.

The follow-up tests exercise lost ownership during a correlated result write, asynchronous input and dependency validation, late admission grants, requeue without spending a handler attempt, held retry deadline precedence, successful peers after a stale batch yield, and exact failure and acknowledgement behavior. Additional tests cover invalid stored input and verify that settling one held job preserves the budget still occupied by its peer. The worker directory passed 382 tests across 20 files, including live PostgreSQL cases.

## Remaining evidence and limits

The scheduler retains defensive invalid-state and ownership guards, default and optional metadata variants, diagnostic wording and bounded internal accounting differences. One hold-budget variant uses handler slots as the default bound for a batch worker and can defer work sooner when slots are fewer than the batch size. The tested public paths use valid scheduler configuration, real reservations and token-checked adapters. The delivery unknown-queue guard has two uncovered variants because conforming reservations reference configured queues. Its controlled failure remains available for inconsistent custom adapter or handler metadata. The publication and contract residuals are predominantly diagnostics, optional undefined properties and synthesized fallback error shapes. Exact optional object shape, CPU work and diagnostics are documented where they can differ.

The adapter review separates Drizzle name and timestamp fallbacks, optional descriptions, additional local work and import errors. Drizzle expression assertions and live adapter reservation tests cover different layers of the PostgreSQL contract. The TypeScript corpus samples the expressions that build SQL, and production migration application is outside this evidence. The review uses the existing mutation selection and informational score policy.
