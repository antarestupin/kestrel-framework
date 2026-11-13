# Throttling, worker and scheduled-task mutation residual review

[Coverage inventory](./mutation_testing_inventory.md) · [Throttling reference](./mutation_testing_studio_atlas.md#throttling-profiles) · [Worker reference](./mutation_testing_95_followup.md#workers) · [Scheduled-task reference](./mutation_testing_scheduled_tasks.md#november-11-review) · [Contributor commands](../contributing/mutation-testing.md)

This follow-up starts from revision `5d2dcc7` and compares the last complete static-inclusive assessments of the three components. Its local reports and execution records are under `artifacts/mutation/scheduling-residual-review/`. Every named execution includes static and hybrid mutants with a ten-minute budget. Incremental seeds preserve assertion kills and omit survivors, uncovered outcomes, runtime errors, timeout detections, and failures reported by Vitest's deadline. Stryker matches reusable results to the instrumented source and current test identities.

The scheduled adapter assessment now separates PostgreSQL declarations from adapter behavior. Throttling uses separate configuration, PostgreSQL declaration and Redis reply declaration profiles. The earlier reports are divided by their original file or range, preserving the baseline totals. The supplemental `postgres-ownership` scheduled-task range is already part of `scheduled-adapters-runtime`.

## Defects reproduced and corrected

### Throttling

- A queued request could miss cancellation when another abort listener stopped propagation. The manager now owns an abort subscription that still runs in that case.
- A successor could inherit the departed queue head's retry deadline even when it had a smaller cost and could be admitted. The queue now recalculates the blocker when the head changes.
- Successful reconciliation could leave a leased authoritative denial cached. An older outstanding reply could also restore that denial after reconciliation. The leased adapter invalidates the cache and fences old replies.
- An absolute floating-point tolerance could admit a very small request despite insufficient capacity, or allocate a zero-unit lease when the outstanding budget was exhausted. Comparisons now scale their tolerance with the balance, a new lease must cover the current request, and positive lease residues remain available for subsequent work or return.
- Two pressure signal names that trimmed to the same identifier could overwrite each other's hysteresis. Definitions reject these collisions. Direct monitor callers also get independent hysteresis for each constraint and signal pair, including identifiers with a separator.
- Directly evaluating an empty signal list returned an invalid refresh date. It now returns the healthy interval. Evaluating a closed monitor stays unavailable and leaves its hysteresis cleared.

### Workers

- A failure allocating a later reservation token could leave an earlier job leased with its attempt incremented, even though the reservation request rejected. The memory adapter prepares tokens before applying any lease. It also rejects colliding custom job identifiers before overwriting a retained job.
- Observer setup or completion errors could be replaced by scope disposal failures. A failed permit completion or lease heartbeat could also replace an independent task or queue transition failure. The scheduler preserves independently failing causes, including a cleanup failure concurrent with cancellation. Failed execution observations retain a diagnostic when the handler throws `undefined`.
- A handler could throw a value that could not be converted to a string. Formatting then failed before a retry or dead-letter diagnostic could be persisted. Workers now use the safe thrown-value formatter.
- A reporting callback that threw while handling a recoverable storage failure could stop worker polling. The reporting boundary now leaves polling available for recovery.

### Scheduled tasks

- A duplicate custom reservation token could consume another occurrence and replace the first owner. The memory adapter validates the token before consuming the occurrence.
- An unprintable thrown value could prevent failure persistence and leave the reservation live. The scheduler uses the same safe thrown-value formatting contract as workers.
- Loading state or reconciling adapters could fail before sibling calls settled. Shutdown could then finish while a sibling was still using borrowed resources. A one-shot cycle had the same problem when a reporter failed while another handler was still active. The scheduler waits for sibling settlement and propagates the original failure.
- A stopped scheduler could begin reconciliation when `start()` or `runOnce()` was called after a pre-start stop. Both entry points now decline work after the stop.

## Results

Outcome columns report Killed / Survived / NoCoverage / Timeout / RuntimeError / CompileError / Ignored. Stryker counts timeouts as detections and excludes runtime errors from its score. The fixes changed some generated mutant sets, so the component scores compare complete partitions.

| Component | Profiles | Before outcomes | After outcomes | Score before → after | Vitest deadline kills before → after |
| --- | ---: | --- | --- | ---: | ---: |
| `throttling` | 16/16 | 4309 / 207 / 11 / 28 / 35 / 0 / 0 | 4355 / 169 / 5 / 25 / 0 / 0 / 0 | 95.21% → 96.18% | 22 → 0 |
| `workers` | 7/7 | 2094 / 78 / 7 / 4 / 0 / 0 / 0 | 2128 / 73 / 4 / 3 / 0 / 0 / 0 | 96.11% → 96.51% | 0 → 0 |
| `scheduled_tasks` | 4/4 | 1372 / 57 / 9 / 6 / 25 / 0 / 0 | 1423 / 40 / 7 / 6 / 0 / 0 / 0 | 95.43% → 96.82% | 0 → 0 |

The 27 final profiles partition the full mutation set across 78 candidate source files. The longest took 503 seconds. Among matched mutations on unchanged spans, 51 former survivors, three formerly uncovered variants and all 60 runtime errors are now killed by assertions. Every matched former kill retained its detection. Of the 34 final Stryker timeouts, 33 reached the execution-hit limit and one closed-queue spin reached the runner deadline.

### Per-profile executions

| Profile | Before outcomes | After outcomes | Final seconds |
| --- | --- | --- | ---: |
| `throttling-admission` | 551 / 26 / 3 / 0 / 0 / 0 / 0 | 555 / 22 / 3 / 0 / 0 / 0 / 0 | 43 |
| `throttling-queues` | 121 / 23 / 1 / 23 / 0 / 0 / 0 | 120 / 18 / 1 / 24 / 0 / 0 / 0 | 22 |
| `throttling-circuits` | 269 / 23 / 2 / 0 / 0 / 0 / 0 | 267 / 22 / 0 / 0 / 0 / 0 / 0 | 180 |
| `throttling-completion` | 509 / 18 / 0 / 1 / 0 / 0 / 0 | 511 / 16 / 0 / 1 / 0 / 0 / 0 | 8 |
| `throttling-postgres-admission` | 322 / 8 / 0 / 0 / 0 / 0 / 0 | 315 / 6 / 0 / 0 / 0 / 0 / 0 | 31 |
| `throttling-postgres-leases` | 291 / 12 / 0 / 0 / 0 / 0 / 0 | 292 / 10 / 0 / 0 / 0 / 0 / 0 | 36 |
| `throttling-leased` | 490 / 32 / 2 / 2 / 0 / 0 / 0 | 499 / 18 / 1 / 0 / 0 / 0 / 0 | 16 |
| `throttling-adapter-wrappers` | 447 / 27 / 0 / 0 / 0 / 0 / 0 | 450 / 24 / 0 / 0 / 0 / 0 / 0 | 6 |
| `throttling-storage` | 446 / 7 / 0 / 0 / 0 / 0 / 0 | 448 / 7 / 0 / 0 / 0 / 0 / 0 | 32 |
| `throttling-redis-result-schema` | 19 / 0 / 0 / 0 / 3 / 0 / 0 | 22 / 0 / 0 / 0 / 0 / 0 / 0 | 45 |
| `throttling-provider` | 435 / 19 / 3 / 0 / 0 / 0 / 0 | 428 / 14 / 0 / 0 / 0 / 0 / 0 | 8 |
| `throttling-definitions-factories` | 117 / 1 / 0 / 0 / 0 / 0 / 0 | 122 / 1 / 0 / 0 / 0 / 0 / 0 | 37 |
| `throttling-definitions-validation` | 179 / 0 / 0 / 2 / 0 / 0 / 0 | 181 / 0 / 0 / 0 / 0 / 0 / 0 | 119 |
| `throttling-schema` | 37 / 11 / 0 / 0 / 29 / 0 / 0 | 66 / 11 / 0 / 0 / 0 / 0 / 0 | 17 |
| `throttling-public-contracts` | 64 / 0 / 0 / 0 / 0 / 0 / 0 | 64 / 0 / 0 / 0 / 0 / 0 / 0 | 53 |
| `throttling-configuration` | 12 / 0 / 0 / 0 / 3 / 0 / 0 | 15 / 0 / 0 / 0 / 0 / 0 / 0 | 4 |
| `workers-delivery` | 353 / 10 / 2 / 4 / 0 / 0 / 0 | 356 / 9 / 2 / 3 / 0 / 0 / 0 | 22 |
| `workers-scheduler` | 656 / 29 / 5 / 0 / 0 / 0 / 0 | 682 / 25 / 2 / 0 / 0 / 0 / 0 | 18 |
| `workers-contracts` | 342 / 2 / 0 / 0 / 0 / 0 / 0 | 342 / 2 / 0 / 0 / 0 / 0 / 0 | 54 |
| `workers-publication` | 178 / 7 / 0 / 0 / 0 / 0 / 0 | 178 / 7 / 0 / 0 / 0 / 0 / 0 | 53 |
| `workers-adapter-memory` | 252 / 4 / 0 / 0 / 0 / 0 / 0 | 257 / 4 / 0 / 0 / 0 / 0 / 0 | 503 |
| `workers-adapter-postgres` | 224 / 4 / 0 / 0 / 0 / 0 / 0 | 224 / 4 / 0 / 0 / 0 / 0 / 0 | 28 |
| `workers-adapter-schema` | 89 / 22 / 0 / 0 / 0 / 0 / 0 | 89 / 22 / 0 / 0 / 0 / 0 / 0 | 105 |
| `scheduled-runtime` | 465 / 25 / 3 / 5 / 0 / 0 / 0 | 485 / 15 / 3 / 5 / 0 / 0 / 0 | 20 |
| `scheduled-adapters-runtime` | 578 / 18 / 6 / 0 / 0 / 0 / 0 | 589 / 13 / 4 / 0 / 0 / 0 / 0 | 41 |
| `scheduled-adapters-schema` | 41 / 11 / 0 / 0 / 25 / 0 / 0 | 66 / 11 / 0 / 0 / 0 / 0 / 0 | 14 |
| `scheduled-contracts` | 288 / 3 / 0 / 1 / 0 / 0 / 0 | 283 / 1 / 0 / 1 / 0 / 0 / 0 | 26 |

## Residual classifications

The inventory retains all residual outcomes in the raw score. Equivalent variants, defensive invariants and private diagnostics have a disposition below. Non-progressing mutants have separate entries for Stryker's hit limit or runner deadline. No mutation exclusions were introduced.

### Throttling declarations and pressure

The PostgreSQL declaration variants that remove a SQL identifier retain the inferred name when it equals the property name. Empty timestamp mode strings retain the pinned Drizzle Date builder. The schema test imports declarations and their metadata registries inside its body, giving malformed table, index and description declarations an assertion boundary. Direct configuration and Redis reply tests similarly detect invalid static discriminants.

- The simple rate definition's absent `burst` option and an explicit `undefined` select the same default in `createRateLimitConstraint`. The direct definition tests exercise an explicit burst and reject unsupported cost-accounting modes. Both previous reconciliation validation timeouts now fail direct assertions.
- The `throttling` facade factory returns the singleton resource's existing facade, so changing the alias registration's lifetime still resolves the same instance. An absent observer context or active observer can throw at a later property read under the mutant, but the manager already contains instrumentation failure. Tests separately assert the registered observer's behavior, the absence of an observer, and the maintenance handler's missing-capability error.
- The monitor tests assert that close releases both internal maps and that later evaluations cannot repopulate either map.
- A single reader close failure is thrown before the aggregate threshold. The aggregate label is diagnostic text, with exact failure identity and multiple cause order asserted. The sample reader's catch runs before it has assigned a value, so an empty catch leaves that value absent. If no source is present, the same catch contains the invalid access. Undefined samples remain undefined when they pass non-coercing finite-number validation and an explicit undefined field has the same internal value as omission. A healthy state implies a finite sample exists.
- The Node heap guard defends against an impossible nonpositive V8 heap limit on supported runtimes. Removing the explicitly configured histogram resolution uses the same 20 ms Node default. The tests verify lazy start, unit conversion, clearing the sample, and disabling the native sampler exactly once.

### Throttling admission and storage

The adapter-wrapper tests now assert lock release at the next event-loop turn and inspect the settled lock map so removed cleanup cannot leak one entry per key. The two former Vitest deadline detections now fail bounded assertions.

| Adapter-wrapper residuals | Disposition |
| --- | --- |
| Backend failure 77–80, 104, 177 | Reconciliation already selects only `emergency-local` requests for the fallback projection. The memory adapter does not use the projected source. The emergency branches run after rejecting the immutable `reject` policy. |
| Denial cache 243, 244, 288, 289 | An authoritative admission for a key or batch follows a cache miss which already removed that denial. The serialization lock prevents another same-key reservation from creating one before the admission returns. |
| Denial cache 302, 306 | Decrementing the private generation still invalidates older replies, which compare by equality. Assigning results by index produces the same dense array from an initially empty array. |
| Denial cache 387, 398, 424, 428, 453 | Expired or incompatible entries still fail the lookup predicates. Removing eager eviction or pruning changes when a bounded scan removes them. The capacity tests check retention of live denials and both eviction paths. The fallback eviction starts with a nonempty cache, so one of the two oldest keys exists. |
| Denial cache 478, 479, 481–484, signature 495 | Alternative comparator variants select the same canonical order or its reverse for supported distinct keys. Built-in adapters reject duplicate dimensions. Changing the private exact-coordination token to a different string still separates exact and leased signatures. |

#### Manager and circuits

| Profile and IDs | Disposition |
| --- | --- |
| Admission 6 | The default clock callback reads `performance.now()`. If it returns an invalid sample the same method is called directly by the fallback. |
| Admission 107, 111, 323, 350, 354, 360, 364, 395, 402 | Explicit undefined and absence for optional internal completion, retry, source and capacity fields are read identically downstream. |
| Admission 223, 225, 227, 228 | The queue drain contains its rejection by settling the waiters, and the owned accounting callback contains backend rejection. The defensive all-settled error collection protects teardown if either implementation later allows its promise to reject. |
| Admission 242 | The single-failure branch throws before the aggregate threshold. |
| Admission 273, 300 | A pressure blocker carries the matching signal identifiers. The missing-list fallback is a defensive empty list. |
| Queues 44 | A pressure blocker carries the matching signal identifiers. The missing-list fallback is a defensive empty list. |
| Admission 326, 348, 451 | Specialized circuit and pressure errors do not expose the local source label. Rate blockers use the generic denied-result branch. |
| Admission 335 | The concurrency discriminant selects the same generic denied-result branch; its concurrency key independently controls queue notification. |
| Admission 372 | The absent deadline compares as NaN and cannot reject the acquired permit. |
| Admission 495, 521 | Inspection filters the individual reasons after detecting pressure. Healthy signals produce no rejection reason. |
| Admission 518 | Under the reject policy, an unknown signal returns before the degraded reasons are exposed. |
| Queues 7, 8 | The acquisition path checks closure, cancellation and deadline before entering the synchronous enqueue boundary. An existing FIFO queue enters the same checks before adding a waiter. The timer and admission checks cover subsequent asynchronous changes. |
| Queues 13, 149, 153 | Optional fields set to undefined are observed the same way as omitted fields. |
| Queues 30, 32, 38 | Only the corresponding blocker provides its keyed fields. Assignment of undefined and deletion have the same notification and deadline behavior. |
| Queues 59, 68 | The alternate loop condition is stopped by the empty check. Removing the empty check can access an absent head after expiration. The drain contains that failure after all affected waiters have settled and then finalizes. |
| Queues 84 | When an admitted head is removed, its retry deadline has already elapsed. The next waiter attempts admission immediately or receives a new blocker from its own denial. |
| Queues 121–124, 129, 156, 160 | A single active drain owns the sleeper. Aborting an already-settled or absent sleeper has no effect. An empty release list never matches a queue key. The drain itself is active when settling its waiters. |
| Queues 50, 53, 57, 58, 60, 61, 65, 67, 69, 71, 74, 76, 77, 90, 91, 103, 104, 110, 112, 115, 116, 117, 120 | The mutated drain does not reach its next valid progress boundary. The instrumented hit limit detects the spin, which stems from missed retry timing, discarded work, or unresolved waiters. |
| Queues 141 | Removing terminal rejection leaves a nonempty closed queue. Its drain restarts in a self-sustaining microtask chain, so Stryker terminates the runner before the next event-loop turn. |
| Circuits 15, 98 | Only half-open circuits can reach a positive active probe count. The configured concurrent probe limit is positive. |
| Circuits 42, 48, 52, 166, 171, 173, 174, 233 | The manager registers state before creating a reservation and retains it. A matching generation pins the reservation to its original closed or half-open state. Removing a probe test can subtract from the closed state's zero count without changing it. |
| Circuits 73, 74, 77, 259, 261, 262 | Transition time is used only while open. The half-open state can retain a private timestamp under the mutant without changing output, and subsequent transitions clear or replace it. |
| Circuits 132, 133 | The permit and failed composed admission each release the local concurrency reservation through one owner. |
| Circuits 187, 190, 196 | Throttled feedback requires the validated throttled payload. An absent reported deadline falls back to the configured cooldown. |
| Circuits 252 | Generation is compared by identity. Decreasing it instead of increasing it still separates older and current completions. |
| Completion 91, 92, 96 | The optional task name is internal diagnostics, and the owned task group only throws synchronously for closed registration. Accounting still runs and reports the same outcome. |
| Completion 115, 209 | The optional source is read identically when absent or explicitly undefined. Failure to call an absent instrumentation observer is contained at the instrumentation boundary. |
| Completion 136, 142, 148, 150 | Shared definitions use stable typed fields and identifiers. The private fingerprint is compared within one constraint ID and kind. Its remaining delimiters distinguish number fields and tagged variants. |
| Completion 394, 396, 397, 400, 406, 407, 410 | Opening always publishes the deadline, and closing or entering half-open clears it. The unchanged state predicate or deadline predicate already implies the other one on that path. |
| Completion 547 | Removing the default delay leaves the waiter in a spin detected by the instrumented hit limit. |

#### Authoritative storage

| Profile and IDs | Disposition |
| --- | --- |
| PostgreSQL admission 96, 98 | An empty return batch performs no SQL. |
| PostgreSQL admission 116 | Ensuring and locking all requested rows precedes reading their capacity within the same transaction. A missing capacity row would violate the private storage protocol. |
| PostgreSQL admission 269 | The private rejection signal is caught by its class and converted into the documented denied result. Its message is internal. |
| PostgreSQL admission 299, 300 | An active storage deadline retains its waiter. An aborted timer rejects instead of invoking the fulfillment callback. |
| PostgreSQL leases 21, 23, 95, 97, 101, 103, 121, 123 | The SQL acquires locks and returns rows in key order independently of the JSON payload's order. Inspection has its own caller-order index. |
| PostgreSQL leases 60 | A scalar aggregate without grouping produces a row, including when its count is zero. |
| PostgreSQL leases 84 | SQL only branches on the `lease` marker. Every other private marker becomes the exact reply discriminant on decoding. |
| Storage 155, 472 | An undefined instrumentation option and absence select the same constructor default. |
| Storage 159 | The definition always creates the leased decorator, which exposes close. |
| Storage 424, 425, 427 | Public inputs are positive finite rates and bursts, with reconciliation amounts nonnegative. Negative duration cannot be constructed. Positive infinity is also caught by the valid-Date ceiling. |
| Storage 428 | A positive duration can round down to zero for a microscopic valid balance. Redis enforces at least one millisecond of storage expiry and retry delay. |
| Redis reply schema | All 22 declaration mutants are killed by reply decoding assertions. Loading the module inside the test makes declaration failures attributable to that test. |

#### Leased adapter

| IDs | Disposition |
| --- | --- |
| 101 | The generation only fences older replies by equality. Either arithmetic direction invalidates them. |
| 105 | Every requested index is populated before returning the array. |
| 170 | The single-error branch throws before the aggregate threshold. |
| 264 | A successful reservation followed a cache miss, which already removed an expired denial. The owning key locks serialize potentially conflicting updates. |
| 274 | An explicit undefined optional source and omission return the same scalar reservation shape. |
| 304, 333 | A sentinel has no expiry, so expiry filtering discards it. Where the sentinel replaces the no-bucket fallback, reduction yields NaN, which fails the capacity check just as zero does for any positive cost. Replenishment, warm spending and returned grant cleanup exercise the observable behavior. |
| 318, 319 | Local consumption follows an exact fallback check or a sufficient positive capacity calculation. The local bucket must exist when a lease is spent. |
| 325 | After the request has spent its cost, the remaining loop iterations subtract zero. |
| 428 | An expired denial is already a cache miss. Capacity limits bound old entries if eager deletion is omitted. |
| 438 | A full positive-capacity cache must contain an oldest key. |
| 508 | An absent instrumentation callback fails inside the existing containment boundary. |
| 543, 544, 546–549 | Accepted request batches contain distinct keys. Comparator alternatives produce the same canonical order or another stable order for supported distinct keys; no input ordering is publicly observable. |

### Workers

The PostgreSQL schema is loaded within its contract test together with the metadata registries. Scheduler tests exercise cancellation during slot admission, rejection of a stale correlated result, and cleanup failure during cooperative shutdown. The polling tests check recovery after a diagnostic callback or a custom adapter snapshot fails.

| Profile | Remaining IDs | Disposition |
| --- | --- | --- |
| `workers-adapter-memory` | 57, 59, 70, 71 | At the capacity boundary, the extra scans select an empty slice and make no durable changes. |
| `workers-adapter-postgres` | 3, 5 | Empty input runs no staging inserts or publication SQL. |
| `workers-adapter-postgres` | 26, 43 | An absent identity cannot hit the in-flight identity map. A local entry with an undefined key has no reader and does not affect the committed row. |
| `workers-adapter-schema` | 4, 5, 9, 21, 23–26, 29, 32, 36, 39, 44, 74, 77–80, 83, 84, 87, 91 | Inferred SQL names and timestamp mode defaults preserve the physical schema. |
| `workers-contracts` | 119, 123 | An undefined option has the same scheduler default whether it is omitted or present. |
| `workers-publication` | 13, 16, 45, 119 | The preceding equality guard covers exactly one error, and a one-element errors array has its first entry. |
| `workers-publication` | 141, 171, 196 | The invalid-budget diagnostic changes its wording only. Comparing a number to an absent budget remains false. The empty Buffer encoding selects its default UTF-8. |
| `workers-scheduler` | 27, 101, 132, 133, 203, 509 | The alternate acknowledgement label still selects global grouping. Aggregate threshold changes are preceded by the single-error branch. Empty late release does no storage work. An explicit undefined execution identifier preserves scope construction. |
| `workers-scheduler` | 150, 165, 173, 180, 182–184, 233 | Shutdown synchronously closes heartbeat admission. A returned renewal can race with acknowledgement; the ownership map is private and an absent entry cannot receive an abort. An exclusive cycle cannot install another token for a tracked ID. Synchronous registration precedes watcher activation, so the watcher's missing-reservation branch is defensive. Later cancellation checkpoints cover application shutdown. |
| `workers-scheduler` | 344, 345, 374, 375, 382, 387 | Lease loss and shutdown cancel admission before handler scope creation; storage still fences stale deferrals, and empty requests are ignored. A balanced held-job counter has the same lookup result at zero or after deleting its key. |
| `workers-scheduler` | 431, 452 | The shutdown policy owns unreported jobs. A shutdown caller sees an already aborted execution signal, so invoking the lease-loss release helper has no effect. |
| `workers-scheduler` | 588, 597 | Removing the outer object checks can change the TypeError source for malformed user values, but they still fail before acquisition. The malformed callback cases assert worker failure and zero spending. |
| `workers-scheduler` | 651 | An aborted invocation without a valid cancellation-shaped admission error also reaches the handler gate with the aborted signal. The gate skips work under the same shutdown policy. |
| `workers-scheduler` | 674, 684 | The final pre-execution slot check rejects already-aborted work. A queued waiter cannot abort itself after handoff because the subscription is disposed. |
| `workers-delivery` | 7, 102, 299, 330 | The private cycle remains exclusive until its finalizer. Each aggregate threshold follows a dedicated single-error check. |
| `workers-delivery` | 137, 378, 382 | An omitted retry override and an explicit undefined property have the same delay and attempt defaults. |
| `workers-delivery` | 230 | The extra placeholder has no job identifier, so the ownership check prevents a handoff. |
| `workers-delivery` | 256, 258, 260 | Invocations are created only for configured worker queues and the original reservation supplies the outcome's queue. A missing worker is a defensive invariant guard. |
| `workers-delivery` | 14, 20, 25 | Removing polling work or the idle delay prevents ordinary progress. Stryker interrupted these mutants at its execution-hit limit. |

### Scheduled tasks

| Profile and final IDs | Disposition |
| --- | --- |
| `scheduled-adapters-runtime` 65, 67, 68, 199, 201 | The memory adapter never creates a run without its registered state, and registered states are retained. The missing-state checks defend against a broken internal invariant. |
| `scheduled-adapters-runtime` 105 | A live run for the requested task implies that the state exists. Wrong-task and expired runs are rejected by direct regressions. |
| `scheduled-adapters-runtime` 268, 277, 571, 581 | A strict comparison and its inclusive counterpart differ only in which Date object is selected when the instant is equal. Neither adapter exposes internal Date identity. |
| `scheduled-adapters-runtime` 407 | The PostgreSQL scalar `COUNT(*)` without `GROUP BY` always returns one row or rejects. A result row with zero live reservations is exercised. |
| `scheduled-adapters-runtime` 442, 508 | An omitted optional update property and a Drizzle property set to `undefined` generate the same SQL. The paused call and absent start timestamp have explicit assertions. |
| `scheduled-adapters-runtime` 452, 455 | Internal expired-run recovery receives a nonempty task list from the two filtered callers and receives `undefined` for a global prune. `listStates([])` returns before storage. |
| `scheduled-adapters-runtime` 562, 564 | When the left date is absent, the subsequent comparison or right-side check selects the same right date, including `undefined` when both are absent. |
| `scheduled-adapters-schema` 5, 62, 63 | Drizzle infers `paused`, `trigger`, and `attempt` from identical property names when the explicit SQL name is empty. |
| `scheduled-adapters-schema` 9, 13, 17, 21, 27, 52, 56, 60 | Drizzle's timestamp builder selects the Date representation unless the mode is exactly `string`. Empty mode keeps the same representation. |
| `scheduled-contracts` 279 | An unused placeholder group passes the same nonempty validation loop without changing the returned definition, which still exposes an empty group array. |
| `scheduled-contracts` 119 | Traversal no longer recognizes a task as a leaf under this mutant and hits the instrumented execution limit. The normal registry regression asserts the nested registration and catalog output. |
| `scheduled-runtime` 140 | Admission ownership is published once and callers share its promise until the cycle settles. The cleanup callback therefore always sees its own cycle. |
| `scheduled-runtime` 275 | After handing off lock release to the invocation, no awaited work occurs in the local admission `try` body and there is no normal route into its error-only release closure. |
| `scheduled-runtime` 285, 286, 287, 288, 291, 292 | Local non-parallel tasks have at most one active handler. The observed count goes from one to zero or a missing entry, which has the same admission result. Distributed and parallel tasks do not consult this local counter to admit work. |
| `scheduled-runtime` 407, 408, 409, 436, 437 | Admission checks shutdown before handing over the reservation. There is no asynchronous gap before the invocation creates its combined signal and registers its heartbeat listener. Normal abort synchronously clears the interval before a later tick. |
| `scheduled-runtime` 451 | The fallback task state selects the same persistent adapter. The returned internal state tag is unused after adapter selection. |
| `scheduled-runtime` 502, 504, 511 | A missing left date falls through to the same right-date result. Equal instants share the same visible selection; storage resolves the trigger using the timestamp. |
| `scheduled-runtime` 66 | The mutated drain label appears only in shutdown timeout diagnostics. The shared shutdown deadline and scheduler ownership remain unchanged. |
| `scheduled-runtime` 124, 128, 129, 132, 133 | Removing polling work, the delay, or the fatal delay exit leaves the loop unable to reach its ordinary abort checkpoint. Stryker detects the non-progress variants via its instrumented hit limit. |

## Residual report index

Paths are relative to `src/packages/kestrel/src`. Mutant IDs are local to each final profile report.

### `throttling`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `throttling-admission` | `throttling/manager.ts:219` | Survived | 6 |
| `throttling-admission` | `throttling/manager.ts:362` | Survived | 107 |
| `throttling-admission` | `throttling/manager.ts:363` | Survived | 111 |
| `throttling-admission` | `throttling/manager.ts:498` | Survived | 223 |
| `throttling-admission` | `throttling/manager.ts:499` | NoCoverage | 228 |
| `throttling-admission` | `throttling/manager.ts:499` | Survived | 225, 227 |
| `throttling-admission` | `throttling/manager.ts:507` | Survived | 242 |
| `throttling-admission` | `throttling/manager.ts:539` | NoCoverage | 273 |
| `throttling-admission` | `throttling/manager.ts:582` | NoCoverage | 300 |
| `throttling-admission` | `throttling/manager.ts:628` | Survived | 323 |
| `throttling-admission` | `throttling/manager.ts:631` | Survived | 326 |
| `throttling-admission` | `throttling/manager.ts:640` | Survived | 335 |
| `throttling-admission` | `throttling/manager.ts:657` | Survived | 348 |
| `throttling-admission` | `throttling/manager.ts:659` | Survived | 350 |
| `throttling-admission` | `throttling/manager.ts:660` | Survived | 354 |
| `throttling-admission` | `throttling/manager.ts:675` | Survived | 360 |
| `throttling-admission` | `throttling/manager.ts:676` | Survived | 364 |
| `throttling-admission` | `throttling/manager.ts:692` | Survived | 372 |
| `throttling-admission` | `throttling/manager.ts:713` | Survived | 395 |
| `throttling-admission` | `throttling/manager.ts:719` | Survived | 402 |
| `throttling-admission` | `throttling/manager.ts:759` | Survived | 451 |
| `throttling-admission` | `throttling/manager.ts:817` | Survived | 495 |
| `throttling-admission` | `throttling/manager.ts:825` | Survived | 518 |
| `throttling-admission` | `throttling/manager.ts:826` | Survived | 521 |
| `throttling-queues` | `throttling/manager.ts:904` | Survived | 7 |
| `throttling-queues` | `throttling/manager.ts:905` | Survived | 8 |
| `throttling-queues` | `throttling/manager.ts:913` | Survived | 13 |
| `throttling-queues` | `throttling/manager.ts:938` | Survived | 30 |
| `throttling-queues` | `throttling/manager.ts:940` | Survived | 32 |
| `throttling-queues` | `throttling/manager.ts:945` | Survived | 38 |
| `throttling-queues` | `throttling/manager.ts:947` | NoCoverage | 44 |
| `throttling-queues` | `throttling/manager.ts:958` | Timeout | 50 |
| `throttling-queues` | `throttling/manager.ts:962` | Timeout | 53 |
| `throttling-queues` | `throttling/manager.ts:967` | Timeout | 57 |
| `throttling-queues` | `throttling/manager.ts:968` | Survived | 59 |
| `throttling-queues` | `throttling/manager.ts:968` | Timeout | 58, 60, 61 |
| `throttling-queues` | `throttling/manager.ts:970` | Timeout | 65 |
| `throttling-queues` | `throttling/manager.ts:976` | Survived | 68 |
| `throttling-queues` | `throttling/manager.ts:976` | Timeout | 67, 69 |
| `throttling-queues` | `throttling/manager.ts:979` | Timeout | 71 |
| `throttling-queues` | `throttling/manager.ts:983` | Timeout | 74, 76, 77 |
| `throttling-queues` | `throttling/manager.ts:994` | Survived | 84 |
| `throttling-queues` | `throttling/manager.ts:1003` | Timeout | 90 |
| `throttling-queues` | `throttling/manager.ts:1004` | Timeout | 91 |
| `throttling-queues` | `throttling/manager.ts:1019` | Timeout | 103, 104 |
| `throttling-queues` | `throttling/manager.ts:1031` | Timeout | 110, 112 |
| `throttling-queues` | `throttling/manager.ts:1043` | Timeout | 115 |
| `throttling-queues` | `throttling/manager.ts:1047` | Timeout | 116 |
| `throttling-queues` | `throttling/manager.ts:1049` | Timeout | 117 |
| `throttling-queues` | `throttling/manager.ts:1050` | Timeout | 120 |
| `throttling-queues` | `throttling/manager.ts:1051` | Survived | 121 |
| `throttling-queues` | `throttling/manager.ts:1052` | Survived | 122, 123, 124 |
| `throttling-queues` | `throttling/manager.ts:1061` | Survived | 129 |
| `throttling-queues` | `throttling/manager.ts:1072` | Timeout | 141 |
| `throttling-queues` | `throttling/manager.ts:1086` | Survived | 149 |
| `throttling-queues` | `throttling/manager.ts:1087` | Survived | 153 |
| `throttling-queues` | `throttling/manager.ts:1089` | Survived | 156 |
| `throttling-queues` | `throttling/manager.ts:1099` | Survived | 160 |
| `throttling-circuits` | `throttling/manager.ts:1129` | Survived | 15 |
| `throttling-circuits` | `throttling/manager.ts:1159` | Survived | 42 |
| `throttling-circuits` | `throttling/manager.ts:1163` | Survived | 48 |
| `throttling-circuits` | `throttling/manager.ts:1165` | Survived | 52 |
| `throttling-circuits` | `throttling/manager.ts:1197` | Survived | 73, 74 |
| `throttling-circuits` | `throttling/manager.ts:1198` | Survived | 77 |
| `throttling-circuits` | `throttling/manager.ts:1222` | Survived | 98 |
| `throttling-circuits` | `throttling/manager.ts:1254` | Survived | 132 |
| `throttling-circuits` | `throttling/manager.ts:1255` | Survived | 133 |
| `throttling-circuits` | `throttling/manager.ts:1313` | Survived | 166 |
| `throttling-circuits` | `throttling/manager.ts:1317` | Survived | 171, 173, 174 |
| `throttling-circuits` | `throttling/manager.ts:1324` | Survived | 187, 190 |
| `throttling-circuits` | `throttling/manager.ts:1327` | Survived | 196 |
| `throttling-circuits` | `throttling/manager.ts:1356` | Survived | 233 |
| `throttling-circuits` | `throttling/manager.ts:1391` | Survived | 252 |
| `throttling-circuits` | `throttling/manager.ts:1398` | Survived | 259, 261, 262 |
| `throttling-completion` | `throttling/manager.ts:1589` | Survived | 91 |
| `throttling-completion` | `throttling/manager.ts:1590` | Survived | 92 |
| `throttling-completion` | `throttling/manager.ts:1593` | Survived | 96 |
| `throttling-completion` | `throttling/manager.ts:1633` | Survived | 115 |
| `throttling-completion` | `throttling/manager.ts:1669` | Survived | 136 |
| `throttling-completion` | `throttling/manager.ts:1671` | Survived | 142 |
| `throttling-completion` | `throttling/manager.ts:1678` | Survived | 148 |
| `throttling-completion` | `throttling/manager.ts:1686` | Survived | 150 |
| `throttling-completion` | `throttling/manager.ts:1745` | Survived | 209 |
| `throttling-completion` | `throttling/manager.ts:1953` | Survived | 394, 396, 397, 400 |
| `throttling-completion` | `throttling/manager.ts:1959` | Survived | 406, 407, 410 |
| `throttling-completion` | `throttling/manager.ts:2056` | Timeout | 547 |
| `throttling-postgres-admission` | `throttling/adapters/postgres/adapter.ts:238` | Survived | 96, 98 |
| `throttling-postgres-admission` | `throttling/adapters/postgres/adapter.ts:260` | Survived | 116 |
| `throttling-postgres-admission` | `throttling/adapters/postgres/adapter.ts:1072` | Survived | 269 |
| `throttling-postgres-admission` | `throttling/adapters/postgres/adapter.ts:1119` | Survived | 299 |
| `throttling-postgres-admission` | `throttling/adapters/postgres/adapter.ts:1122` | Survived | 300 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:528` | Survived | 21 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:529` | Survived | 23 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:727` | Survived | 60 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:1181` | Survived | 84 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:1208` | Survived | 95 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:1209` | Survived | 97 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:1223` | Survived | 101 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:1224` | Survived | 103 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:1272` | Survived | 121 |
| `throttling-postgres-leases` | `throttling/adapters/postgres/adapter.ts:1273` | Survived | 123 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:187` | Survived | 101 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:197` | Survived | 105 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:270` | Survived | 170 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:379` | Survived | 264 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:390` | Survived | 274 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:429` | Survived | 304 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:447` | NoCoverage | 319 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:447` | Survived | 318 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:451` | Survived | 325 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:462` | Survived | 333 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:556` | Survived | 428 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:566` | Survived | 438 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:658` | Survived | 508 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:682` | Survived | 543, 544 |
| `throttling-leased` | `throttling/adapters/leased/adapter.ts:683` | Survived | 546, 547, 548, 549 |
| `throttling-adapter-wrappers` | `throttling/adapters/backend_failure/adapter.ts:118` | Survived | 77, 78, 79 |
| `throttling-adapter-wrappers` | `throttling/adapters/backend_failure/adapter.ts:120` | Survived | 80 |
| `throttling-adapter-wrappers` | `throttling/adapters/backend_failure/adapter.ts:147` | Survived | 104 |
| `throttling-adapter-wrappers` | `throttling/adapters/backend_failure/adapter.ts:250` | Survived | 177 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:93` | Survived | 243 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:94` | Survived | 244 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:144` | Survived | 288 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:145` | Survived | 289 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:164` | Survived | 302 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:173` | Survived | 306 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:292` | Survived | 387 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:303` | Survived | 398 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:336` | Survived | 424, 428 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:365` | Survived | 453 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:404` | Survived | 478, 479 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/adapter.ts:405` | Survived | 481, 482, 483, 484 |
| `throttling-adapter-wrappers` | `throttling/adapters/denial_caching/signature.ts:9` | Survived | 495 |
| `throttling-storage` | `throttling/adapters/postgres/definition.ts:23` | Survived | 155 |
| `throttling-storage` | `throttling/adapters/postgres/definition.ts:26` | Survived | 159 |
| `throttling-storage` | `throttling/adapters/redis/adapter.ts:159` | Survived | 424, 425, 427, 428 |
| `throttling-storage` | `throttling/adapters/redis/definition.ts:20` | Survived | 472 |
| `throttling-provider` | `throttling/provider.ts:73` | Survived | 73, 74 |
| `throttling-provider` | `throttling/provider.ts:95` | Survived | 101 |
| `throttling-provider` | `throttling/provider.ts:96` | Survived | 102 |
| `throttling-provider` | `throttling/resource_pressure/monitor.ts:155` | Survived | 203, 206 |
| `throttling-provider` | `throttling/resource_pressure/monitor.ts:197` | Survived | 240 |
| `throttling-provider` | `throttling/resource_pressure/monitor.ts:198` | Survived | 241 |
| `throttling-provider` | `throttling/resource_pressure/monitor.ts:203` | Survived | 245 |
| `throttling-provider` | `throttling/resource_pressure/monitor.ts:209` | Survived | 257 |
| `throttling-provider` | `throttling/resource_pressure/monitor.ts:220` | Survived | 268 |
| `throttling-provider` | `throttling/resource_pressure/node_source.ts:64` | Survived | 438, 439 |
| `throttling-provider` | `throttling/resource_pressure/node_source.ts:69` | Survived | 447 |
| `throttling-definitions-factories` | `throttling/definitions.ts:184` | Survived | 4 |
| `throttling-schema` | `throttling/postgres_schema.ts:17` | Survived | 2 |
| `throttling-schema` | `throttling/postgres_schema.ts:18` | Survived | 3 |
| `throttling-schema` | `throttling/postgres_schema.ts:20` | Survived | 5 |
| `throttling-schema` | `throttling/postgres_schema.ts:29` | Survived | 12 |
| `throttling-schema` | `throttling/postgres_schema.ts:31` | Survived | 15 |
| `throttling-schema` | `throttling/postgres_schema.ts:36` | Survived | 19 |
| `throttling-schema` | `throttling/postgres_schema.ts:74` | Survived | 45 |
| `throttling-schema` | `throttling/postgres_schema.ts:77` | Survived | 48 |
| `throttling-schema` | `throttling/postgres_schema.ts:79` | Survived | 51 |
| `throttling-schema` | `throttling/postgres_schema.ts:83` | Survived | 55 |
| `throttling-schema` | `throttling/postgres_schema.ts:88` | Survived | 60 |

### `workers`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `workers-delivery` | `workers/scheduler.ts:351` | Survived | 7 |
| `workers-delivery` | `workers/scheduler.ts:362` | Timeout | 14 |
| `workers-delivery` | `workers/scheduler.ts:375` | Timeout | 20, 25 |
| `workers-delivery` | `workers/scheduler.ts:462` | Survived | 102 |
| `workers-delivery` | `workers/scheduler.ts:1028` | Survived | 137 |
| `workers-delivery` | `workers/scheduler.ts:1291` | Survived | 230 |
| `workers-delivery` | `workers/scheduler.ts:1318` | NoCoverage | 258 |
| `workers-delivery` | `workers/scheduler.ts:1318` | Survived | 256 |
| `workers-delivery` | `workers/scheduler.ts:1319` | NoCoverage | 260 |
| `workers-delivery` | `workers/scheduler.ts:1361` | Survived | 299 |
| `workers-delivery` | `workers/scheduler.ts:1384` | Survived | 330 |
| `workers-delivery` | `workers/scheduler.ts:1434` | Survived | 378 |
| `workers-delivery` | `workers/scheduler.ts:1435` | Survived | 382 |
| `workers-scheduler` | `workers/scheduler.ts:241` | Survived | 27 |
| `workers-scheduler` | `workers/scheduler.ts:338` | Survived | 101 |
| `workers-scheduler` | `workers/scheduler.ts:484` | Survived | 132, 133 |
| `workers-scheduler` | `workers/scheduler.ts:515` | Survived | 150 |
| `workers-scheduler` | `workers/scheduler.ts:529` | Survived | 165 |
| `workers-scheduler` | `workers/scheduler.ts:541` | Survived | 173 |
| `workers-scheduler` | `workers/scheduler.ts:551` | NoCoverage | 183 |
| `workers-scheduler` | `workers/scheduler.ts:551` | Survived | 180, 182 |
| `workers-scheduler` | `workers/scheduler.ts:552` | NoCoverage | 184 |
| `workers-scheduler` | `workers/scheduler.ts:575` | Survived | 203 |
| `workers-scheduler` | `workers/scheduler.ts:625` | Survived | 233 |
| `workers-scheduler` | `workers/scheduler.ts:792` | Survived | 344, 345 |
| `workers-scheduler` | `workers/scheduler.ts:827` | Survived | 374, 375 |
| `workers-scheduler` | `workers/scheduler.ts:837` | Survived | 382 |
| `workers-scheduler` | `workers/scheduler.ts:841` | Survived | 387 |
| `workers-scheduler` | `workers/scheduler.ts:940` | Survived | 431 |
| `workers-scheduler` | `workers/scheduler.ts:966` | Survived | 452 |
| `workers-scheduler` | `workers/scheduler.ts:1254` | Survived | 509 |
| `workers-scheduler` | `workers/scheduler.ts:1503` | Survived | 588 |
| `workers-scheduler` | `workers/scheduler.ts:1505` | Survived | 597 |
| `workers-scheduler` | `workers/scheduler.ts:1556` | Survived | 651 |
| `workers-scheduler` | `workers/scheduler.ts:1598` | Survived | 674 |
| `workers-scheduler` | `workers/scheduler.ts:1611` | Survived | 684 |
| `workers-contracts` | `workers/runtime.ts:35` | Survived | 119 |
| `workers-contracts` | `workers/runtime.ts:36` | Survived | 123 |
| `workers-publication` | `workers/acknowledgement_buffer.ts:54` | Survived | 13 |
| `workers-publication` | `workers/acknowledgement_buffer.ts:57` | Survived | 16 |
| `workers-publication` | `workers/acknowledgement_buffer.ts:82` | Survived | 45 |
| `workers-publication` | `workers/deferral_buffer.ts:61` | Survived | 119 |
| `workers-publication` | `workers/publication.ts:18` | Survived | 141 |
| `workers-publication` | `workers/publication.ts:59` | Survived | 171 |
| `workers-publication` | `workers/serialization.ts:10` | Survived | 196 |
| `workers-adapter-memory` | `workers/adapters/memory/adapter.ts:139` | Survived | 57, 59 |
| `workers-adapter-memory` | `workers/adapters/memory/adapter.ts:155` | Survived | 70, 71 |
| `workers-adapter-postgres` | `workers/adapters/postgres/adapter.ts:88` | Survived | 3, 5 |
| `workers-adapter-postgres` | `workers/adapters/postgres/adapter.ts:118` | Survived | 26 |
| `workers-adapter-postgres` | `workers/adapters/postgres/adapter.ts:137` | Survived | 43 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:33` | Survived | 4 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:34` | Survived | 5 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:36` | Survived | 9 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:56` | Survived | 21 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:57` | Survived | 23 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:58` | Survived | 24 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:59` | Survived | 25 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:60` | Survived | 26 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:63` | Survived | 29 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:65` | Survived | 32 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:69` | Survived | 36 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:73` | Survived | 39 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:79` | Survived | 44 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:123` | Survived | 74 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:125` | Survived | 77 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:126` | Survived | 78 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:127` | Survived | 79 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:128` | Survived | 80 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:131` | Survived | 83 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:132` | Survived | 84 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:134` | Survived | 87 |
| `workers-adapter-schema` | `workers/adapters/postgres/schema.ts:138` | Survived | 91 |

### `scheduled_tasks`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `scheduled-runtime` | `scheduled_tasks/runtime.ts:116` | Survived | 66 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:179` | Timeout | 124 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:186` | Timeout | 128 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:188` | Timeout | 129 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:189` | Timeout | 132, 133 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:202` | Survived | 140 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:337` | Survived | 275 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:350` | Survived | 285 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:351` | Survived | 286, 287, 288 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:353` | Survived | 291 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:354` | Survived | 292 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:544` | NoCoverage | 408, 409 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:544` | Survived | 407 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:572` | NoCoverage | 437 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:572` | Survived | 436 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:609` | Survived | 451 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:655` | Survived | 502, 504 |
| `scheduled-runtime` | `scheduled_tasks/scheduler.ts:661` | Survived | 511 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/memory/adapter.ts:134` | NoCoverage | 67 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/memory/adapter.ts:134` | Survived | 65 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/memory/adapter.ts:135` | NoCoverage | 68 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/memory/adapter.ts:172` | Survived | 105 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/memory/adapter.ts:288` | NoCoverage | 201 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/memory/adapter.ts:288` | Survived | 199 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/memory/adapter.ts:374` | Survived | 268 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/memory/adapter.ts:383` | Survived | 277 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/postgres/adapter.ts:240` | Survived | 407 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/postgres/adapter.ts:328` | Survived | 442 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/postgres/adapter.ts:361` | NoCoverage | 455 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/postgres/adapter.ts:361` | Survived | 452 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/postgres/adapter.ts:449` | Survived | 508 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/postgres/adapter.ts:509` | Survived | 562, 564 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/postgres/adapter.ts:515` | Survived | 571 |
| `scheduled-adapters-runtime` | `scheduled_tasks/adapters/postgres/adapter.ts:520` | Survived | 581 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:29` | Survived | 5 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:31` | Survived | 9 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:35` | Survived | 13 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:39` | Survived | 17 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:43` | Survived | 21 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:49` | Survived | 27 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:81` | Survived | 52 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:85` | Survived | 56 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:89` | Survived | 60 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:92` | Survived | 62 |
| `scheduled-adapters-schema` | `scheduled_tasks/adapters/postgres/schema.ts:93` | Survived | 63 |
| `scheduled-contracts` | `scheduled_tasks/registry.ts:72` | Timeout | 119 |
| `scheduled-contracts` | `scheduled_tasks/task.ts:121` | Survived | 279 |
