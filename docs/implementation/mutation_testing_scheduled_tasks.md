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

The runtime review retains material gaps in second-start/restart behavior, isolated application-budget cancellation, wait-policy replay, combined lock-release failures, heartbeat pacing and repeated successful renewal, ordinary-completion timer/listener cleanup, structured execution-log labels and competing eligible manual/regular timestamps. Some earlier stop checks prevent extra I/O or expose different failures even when later guards still block the handler; those work/failure differences are not strict equivalences.

The adapter review retains material gaps in paused manual skips, completion dates that must not move an already later cadence backwards, restoration with no pending manual timestamp or with reverse timestamp ordering, nullable/Unix-epoch state mapping, recovery reduction order and presence of column-description metadata. Empty descriptions rejected during import retain their `RuntimeError` status, separately from assertion kills. Actual schema assertions do not apply generated production DDL or exhaustively mutate SQL predicates and transaction interleavings.

Diagnostic wording, optional own-property shapes, equal-instant Date identity, redundant guards, extra work and possible failure-observation differences are classified separately. A raw surviving count must not be treated as either an equal number of missing tests or proof that every survivor is harmless. Material follow-up remains visible in the [framework inventory](./mutation_testing_inventory.md); these results do not introduce a blocking score.

Application behavior belongs in [Scheduled tasks usage](../usage/scheduled_tasks.md) and [Scheduled tasks implementation](./scheduled_tasks.md). Contributor commands and campaign procedures belong in [the mutation-testing contribution guide](../contributing/mutation-testing.md).
