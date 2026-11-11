# Scheduled-task mutation campaign

The 2026-11-10 campaign splits the complete scheduled-task component into three ten-minute profiles: `scheduled-runtime` covers `scheduler.ts` and `runtime.ts`; `scheduled-adapters` covers both backend implementations, recipes and actual PostgreSQL schema; `scheduled-contracts` covers the provider, configuration, registry, calendar, task declarations, dependency descriptors and adapter contract. Barrel exports are included in the source selections even when they produce no runtime mutations. These focused modes retain static mutants. Scores remain informational, with no exclusions or blocking threshold.

## Demonstrated defects and corrections

Mutation-guided tests and the associated source review exposed several distinct ownership and scheduling problems. The regressions use public scheduler/runtime APIs, controlled adapters and explicit promise gates; the initial lifecycle regressions failed through ordinary assertions rather than relying on a test deadline.

- Two concurrent scheduler starts during reconciliation created independent polling loops and lost ownership of the first loop's cancellation controller. Startup now claims ownership before awaiting reconciliation. The public runtime also publishes its startup promise before a synchronous adapter callback can reenter it.
- A synchronous reconciliation callback could reenter one-shot admission before initialization ownership was published, reconciling twice. Initialization now publishes its promise before invoking the adapter.
- Stop could finish while reconciliation, state loading, lock acquisition or reservation still owned borrowed resources, then allow a late handler to start. Stop now drains initialization and admission. Late locks and reservations are released, and stopped admission does not hand work to a handler.
- A refused reservation renewal did not cancel its handler. A rejected renewal could also let ownership cleanup finish while a sibling lock renewal remained pending. Each invocation now owns its cooperative cancellation, waits for every in-flight renewal and retains its first failure without cancelling healthy sibling tasks.
- The memory adapter restored a released or expired manual occurrence using the later pending timestamp. This disagreed with earliest-request coalescing and PostgreSQL's `LEAST` restoration. It now preserves the earliest still-unhandled manual occurrence; a public regression first observed the newer timestamp, and an independent PostgreSQL case confirmed the intended parity.
- Cron schedules without an explicit timezone used the host process timezone, although both application and implementation guides promise UTC. Parsing now explicitly selects UTC for occurrence calculation and eager validation. The regression controls the ambient timezone and restores it in `finally`, keeping the suite compatible with `--no-isolate`.
- A handler throwing `undefined` was persisted as successful because error absence and the thrown value shared one sentinel. Renewal rejection with `undefined` also lost its raw cause through `AbortController` normalization. Failure presence is now explicit, ownership failure is captured before cooperative cancellation and later sibling or cleanup errors cannot replace the first raw cause. Handler and renewal regressions cover both undefined and null; the signal keeps native normalization while persistence, observation and reporting retain the original value.

## Added coverage

The component received 174 new test cases. Runtime and scheduler cases cover startup/reentry, stop races, admission coalescing, global slot accounting, capacity release, overlap policies, reservation and completion failures, heartbeat ownership, polling lifetime, supervised failure/shutdown, error forwarding, execution disposal, observations and duration, manual/loop/interval cadence, configured defaults and override rejection. The final small pass supplies unrelated infrastructure in override-rejection fixtures so another TypeError cannot hide removal of the intended guard.

Adapter cases cover exact task/token ownership, stale references, manual and scheduled release, inclusive lease expiry, explicit and implicit recovery, bounded pruning order, pause/resume, date snapshot ownership, completion/deferral policies and injected adapter settings. PostgreSQL tests use its clock for lease acquisition and the runtime clock for start diagnostics. Actual exported schema tests separately check singular names, SQL column mappings, framework migration provenance, ownership keys, defaults, timezone-aware date columns and index access paths. They do not equate temporary integration tables with the generated production DDL.

Composition cases cover numeric configuration coercion and guards, default policies, typed task metadata, invalid ids/groups, isolated deferrals, bounded error serialization, registry order and path collisions, duration/calendar boundaries, lazy external backend ownership, minimal/standard boot, CLI selection forwarding and configured maintenance work.

## Evidence and limits

Final raw statuses use `K/S/NC/T/RE` for `Killed/Survived/NoCoverage/Timeout/RuntimeError`. Each listed run completed below its ten-minute cap. The runtime and contract mutation corpora changed with their production fixes, so totals are not an unchanged-corpus comparison.

| Profile | Before K/S/NC/T/RE | After K/S/NC/T/RE | Mutants before → after | Before → after wall time |
| --- | --- | --- | --- | --- |
| Runtime | 142/137/181/0/0 | 419/71/5/18/0 | 460 → 513 | 66s → 312s |
| Adapters | 263/209/173/0/25 | 586/51/8/0/25 | 670 → 670 | 140s → 180s |
| Contracts | 164/95/36/1/0 | 275/16/0/1/0 | 296 → 292 | 88s → 87s |

Common-fingerprint detection was retained across all three profiles. Eight runtime variants previously marked `Killed` are now `Timeout`, so that is detection preservation with weaker assertion-level evidence rather than unchanged assertion kills.

Raw `Killed` is not always a completed assertion: 53 runtime mutants and seven adapter mutants report a five-second Vitest deadline in their kill reason, compared with two and three respectively before strengthening. Their exact fingerprints are retained in `vitestDeadlineKills`. The runtime also has six explicit execution hit-limit `Timeout` results and twelve `Timeout` results without a detailed cause in the JSON; the contract profile has one explicit execution hit limit. These mechanisms remain separate. Gated tests that wait indefinitely when a mutation removes a callback are a concrete fixture-hardening follow-up, and explain much of the runtime campaign's 312-second cost. No deadline-based detection is relabeled as a behavioral assertion.

Exact report fingerprints, source-change-aware transitions and per-mutant explanations are stored in the [runtime classification](./mutation_testing_scheduled_runtime_classification.json), [adapter classification](./mutation_testing_scheduled_adapters_classification.json) and [contract classification](./mutation_testing_scheduled_contracts_classification.json). Numeric mutant ids and line numbers are navigation aids; changed production code changes the mutation corpus. Common-fingerprint transitions are the comparable evidence, while unmatched variants remain explicit.

The first runtime review identified material gaps in second-start/restart behavior, isolated application-budget cancellation, wait-policy replay, combined lock-release failures, heartbeat pacing and repeated successful renewal, ordinary-completion timer/listener cleanup, structured execution-log labels and competing eligible manual/regular timestamps. Some earlier stop checks prevent extra I/O or expose different failures even when later guards still block the handler.

The first adapter review identified material gaps in paused manual skips, completion dates that must not move an already later cadence backwards, restoration with no pending manual timestamp or with reverse timestamp ordering, nullable/Unix-epoch state mapping, recovery reduction order and presence of column-description metadata. Empty descriptions rejected during import retain their `RuntimeError` status, separately from assertion kills. Actual schema assertions inspect the exported schema metadata. The PostgreSQL adapter integration tests run SQL against temporary tables.

Diagnostic wording, optional own-property shapes, equal-instant Date identity, redundant guards, extra work and possible failure-observation differences are classified separately in the historical JSON records.

## November 11 review

The follow-up covers all 19 candidate source files through the same three profiles. It corrected the following behaviors and added direct regression assertions:

- Both adapters counted an expired reservation as active if the lease elapsed after a state read. Overlap `skip` could silently consume a separate pending occurrence. The decision now requires an unexpired reservation of the same task. The regressions expire an existing lease between state read and skip, then verify that both the recovered scheduled occurrence and pending manual request remain available.
- The memory adapter exposed aliases to the caller's clock, returned reservation dates, completion error, and state snapshots. Mutating those values could retroactively change a task's recorded start time, pending manual request, or last failure. Stored values and returned diagnostics now have independent ownership.
- Starting polling replaced the handler abort controller. A one-shot execution admitted before polling started could miss a later stop request, leaving the drain waiting on its handler. Both entry points now share one cancellation owner.
- A handler could begin after ownership renewal failed during asynchronous execution setup. Admission may already have succeeded, but the scheduler now checks the combined cancellation signal before invoking user code.
- The independent application drain signal cancelled active work but left a pending admission able to accept a reservation after the drain budget. The scheduler now restores that reservation and releases the lock, exits polling, and declines subsequent admission.
- An exception while a custom loop calculated its next occurrence bypassed lock release. The scheduler now reports the error and releases the overlap lock while the unfinished occurrence remains recoverable at ordinary lease expiry.
- Admission could lose the original storage error when releasing the overlap lock also failed. Both causes are retained in the reported aggregate. A throwing diagnostic reporter could be called again with its own exception and leave a rejected cleanup promise unobserved. Invocation reporting now has one boundary, and the active slot is cleaned up even when that boundary rejects.

Runtime assertions also cover supervised shutdown awaiting a held handler, second start and restart after polling termination, cancellation-induced custom-delay rejection, `wait` replay under both coordination modes, lock release exactly once, repeated half-lease renewal, timer liveness and cleanup, log metadata, competing occurrence timestamps, and the absence of a completion deferral. Adapter assertions cover paused manual skip, cross-task ownership, both recovery orderings, default clock, monotonic and absent cadence, nullable diagnostics, Unix epoch, and PostgreSQL column descriptions. Contract assertions cover populated CLI help and maintenance descriptions, absent task metadata, and actionable identifiers in validation diagnostics.

### Final measurements

The three profiles ran with static mutants enabled, a ten-minute budget, and no score threshold. The runtime reference uses the November 11 fixture-hardening run. The adapter and contract references use the archived November 10 reports with matching baseline source. All final executions completed and report zero Vitest deadline kills.

| Profile | Reference K/S/NC/T/RE | Final K/S/NC/T/RE | Mutants before → after | Wall time before → after |
| --- | --- | --- | --- | --- |
| `scheduled-runtime` | 431/71/5/6/0 | 465/25/3/5/0 | 513 → 498 | 119s → 173s |
| `scheduled-adapters` | 586/51/8/0/25 | 619/29/6/0/25 | 670 → 679 | 180s → 224s |
| `scheduled-contracts` | 275/16/0/1/0 | 288/3/0/1/0 | 292 → 292 | 87s → 109s |

Comparisons match unchanged contiguous source lines, locations, mutators and replacements within each file. There are 427 matching runtime, 633 matching adapter, and 292 matching contract variants. No matching previous kill regressed. The archived JSON, HTML, source and test hashes, and comparisons are under `artifacts/mutation/nov11-complete-review/`, in `scheduled-runtime-after-2`, `scheduled-adapters-after-2`, and `scheduled-contracts-after`. Run any profile again with `npm run test:mutation:focus -- <profile>`.

### Runtime residuals

Thirty matching historical survivors, two previously uncovered variants, and one prior execution hit limit now fail direct assertions. The first follow-up had one Stryker timeout with no reason after removal of the admission stop predicate. The final polling controller remains aborted through late startup, so the corresponding block removal now fails the assertion that startup must leave polling completion unset. The final report has five explicit execution hit limits and no unexplained or Vitest test deadlines.

| Final mutant IDs | Observed outcome and rationale |
| --- | --- |
| 20, 26, 66, 91, 292, 417, 449, 465, 477, 488, 514 | Eleven survivors change diagnostic text or a drain label. Rejections, aggregate causes, and ownership cancellation are asserted separately. |
| 136 | The active admission owner cannot be replaced before its promise settles. Other callers join the published cycle. |
| 268 | Changing the lock-ownership flag after handoff affects the local release closure only. The admission catch has no awaited operation after the invocation takes ownership. |
| 278–281, 284, 285 | Six survivors change private active-count bookkeeping. A fixed local `wait` or `skip` task has at most one active invocation. Distributed and parallel tasks do not use this count for admission. |
| 400–402, 429, 430 | Two survivors and three uncovered defensive branches concern an already-aborted heartbeat. The fresh composite signal owns its listener before any handler sees it, and abort synchronously clears the interval. Admission checks the source signals before transferring the reservation, with no asynchronous gap before heartbeat setup. |
| 441 | The changed default internal state tag still selects the same persistent adapter. No composed execution reads the returned private tag as policy. |
| 492, 494, 501 | Three survivors preserve the selected timestamp value for absent dates or equal instants. The adapter resolves the equal-instant trigger from the occurrence value. |
| 120, 124, 125, 128, 129 | Five explicit Stryker execution hit limits result from empty polling work or suppressing the fatal delay exit. Their status remains `Timeout`. |

### Adapter residuals

Twenty matching historical survivors now fail assertions. All seven historical deadline kills complete with behavioral failures in the final run. The intermediate run lost an incidental crash from replacing the default clock with an undefined-returning function. The final regression checks the actual timestamps produced by the default clock and detects that mutant directly. A separate test detects removal of the task-id comparison when a different task has a live lease.

| Final mutant IDs | Observed outcome and rationale |
| --- | --- |
| 60, 62, 63, 100, 194, 196 | Three survived and three have no coverage in memory missing-state defenses. The adapter creates a reservation only for a registered task, retains all registered states, and checks the task id before accepting a live run for skip. |
| 345, 347, 349, 447, 450 | Two survived and three have no coverage in PostgreSQL defenses. A successful single-row insert under the built-in schema yields its `RETURNING` row. Public recovery callers pass one or more task ids or select a global batch. |
| 402, 437, 503, 557, 559 | Five survivors retain built-in behavior. A scalar `COUNT(*)` without grouping returns a row, Drizzle ignores undefined update values, and the optional-date results agree for the supported Date inputs. |
| 263, 272, 566, 576 | Four survivors change which Date object is selected when the instant is equal. State and database contracts expose timestamps by value. |
| 284, 295, 595, 606 | Four survivors change the text of invalid lease or prune-limit errors. Type and rejection are covered. |
| 616, 620, 624, 628, 632, 638, 663, 667, 671, 673, 674 | Eleven schema survivors retain the effective column names or Date mapping under the pinned Drizzle version. Omitting explicit metadata still changes the declarations. |
| 612, 645, 646, 648–656, 680, 681, 683–689 | Twenty-one runtime errors arise when import-time migration metadata validation rejects missing or empty descriptions. |
| 614, 640, 658, 675 | Four runtime errors arise when Drizzle cannot build or inspect a mutated table or index declaration. |

The exported-schema tests inspect Drizzle metadata and generated comment contributions. The adapter SQL tests use connection-local temporary tables. Generated production DDL, custom database triggers, and exhaustive transaction interleavings are outside this evidence.

### Contract residuals

Thirteen matching historical survivors now fail assertions. Mutants 266 and 268 remove the empty-id check, after which the identifier pattern still rejects the empty id with a `TypeError` and a different diagnostic. Mutant 286 adds one non-empty label to the validation loop's default input while the definition still exposes an empty group list. Mutant 119 makes registry traversal mistake a task definition for a nested catalog and reaches Stryker's explicit execution hit limit.

All three profiles have been reviewed. The remaining outcomes have documented rationales under the supported contracts, storage implementation and test boundaries above. The current and historical assessments are tracked in the [framework inventory](./mutation_testing_inventory.md). The mutation score remains informational.

Application behavior belongs in [Scheduled tasks usage](../usage/scheduled_tasks.md) and [Scheduled tasks implementation](./scheduled_tasks.md). Contributor commands and campaign procedures belong in [the mutation-testing contribution guide](../contributing/mutation-testing.md).
