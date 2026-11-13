# Database and workflow mutation residual review

[Mutation inventory](./mutation_testing_inventory.md) · [Previous component assessment](./mutation_testing_95_followup.md) · [Contributor commands](../contributing/mutation-testing.md)

The starting reference is revision `316591c` and the complete static-inclusive reports from the previous assessment. The database runtime had 114 surviving and two uncovered mutants. Workflows had 278 surviving and 20 uncovered mutants. The review also checks runtime errors, Stryker timeouts and detections recorded as test failures when Vitest hit its deadline.

Named profile invocations retain static and hybrid mutants and stop at ten minutes. Each final result records its execution and cache provenance under `artifacts/mutation/residual-review/`. Incremental rechecks can reuse unchanged assertion kills. Where a fixture changed, the recheck excludes residuals and deadline detections from its seed so those outcomes are measured again. The first PostgreSQL activation invocation reached the limit and the next invocation resumed from its checkpoint.

## Confirmed defects

### Database runtime

- A reference counter rebuild could skip rows if a numeric primary key was named `cursor`. PostgreSQL could sort by the projected text cursor alias and then resume using the numeric key. The query now sorts by the qualified native key. The regression rebuilds keys 2 and 10 in separate batches.

### Workflows

- A runtime that failed validation could leave a drain registered on the application. The drain is registered after validation succeeds.
- A failure disposing a task scope could mask the original setup or execution failure. A failing completion observation could mask an execution failure as well. The runtime reports independent causes together and still disposes the scope once.
- Memory cancellation or resume could update execution state before a failed wake-up allocation. Cancellation of a lineage and parent activation can now prepare the descendant wake-ups before publishing their transitions.
- Memory could apply the first completion in an activity batch and then reject the batch after a later wake-up allocation failed. It now stages the affected journal entries and wake-ups before publishing.
- An invalid duration later in a Memory lease-extension batch could reject the request after extending an earlier lease. The adapter validates and stages the new deadlines before applying the batch.
- Distinct Memory signal identities or keyed concurrency groups containing a delimiter could share an internal lookup key. Separate key coordinates prevent cross-execution deduplication, keep capacity groups independent, and make history rotation remove only its own signal keys.
- A Memory fixture settlement could leave its terminal workflow lease active. Releasing that lease could reopen the execution. Fixture settlement now follows the same terminal lifecycle as activation.
- Memory force termination used detached recursive calls to traverse descendants. In a cyclic low-level lineage, terminating one execution could also append a spurious child completion to another execution in the same termination set. The traversal shares one visited set, suppresses completion notifications within that set, and marks descendants terminal before releasing their permits.
- PostgreSQL signals could create a workflow task before a pending execution had acquired its retained concurrency permit. Signals remain durable and the task is created at admission.
- A prior blocked diagnostic could remain on an execution after successful compensation. The terminal transition clears the obsolete failure metadata.

## Results and remaining cases

Outcome columns report Killed / Survived / NoCoverage / Timeout / RuntimeError / CompileError / Ignored. Deadline kills are included in Killed.

| Component | Verified profiles | Before outcomes | After outcomes | Score before → after | Deadline kills before → after |
| --- | ---: | --- | --- | ---: | ---: |
| `db` | 13/13 | 2386 / 114 / 2 / 10 / 118 / 0 / 0 | 2548 / 59 / 0 / 10 / 1 / 0 / 0 | 95.38% → 97.75% | 40 → 0 |
| `workflows` | 26/26 | 6672 / 278 / 20 / 19 / 106 / 0 / 0 | 6861 / 162 / 5 / 19 / 5 / 0 / 0 | 95.74% → 97.63% | 2 → 0 |

The raw score counts Stryker timeouts as detections and excludes runtime errors. The production fixes change the generated mutant sets. The table compares the complete profile partitions before and after those fixes. The final reports record zero Vitest-deadline kills.

### Per-profile executions

| Profile | Before outcomes | After outcomes | After seconds |
| --- | --- | --- | ---: |
| `db-provider` | 333 / 25 / 0 / 1 / 1 / 0 / 0 | 347 / 12 / 0 / 1 / 0 / 0 / 0 | 66 |
| `db-instrumentation` | 293 / 26 / 0 / 4 / 1 / 0 / 0 | 300 / 19 / 0 / 4 / 1 / 0 / 0 | 25 |
| `db-repository` | 319 / 10 / 0 / 0 / 0 / 0 / 0 | 320 / 4 / 0 / 0 / 0 / 0 / 0 | 36 |
| `db-history-declarations` | 48 / 4 / 0 / 0 / 10 / 0 / 0 | 58 / 4 / 0 / 0 / 0 / 0 / 0 | 61 |
| `db-history-column-types` | 88 / 0 / 0 / 0 / 30 / 0 / 0 | 118 / 0 / 0 / 0 / 0 / 0 / 0 | 69 |
| `db-history-identities` | 68 / 3 / 0 / 0 / 21 / 0 / 0 | 91 / 1 / 0 / 0 / 0 / 0 / 0 | 21 |
| `db-history-events` | 197 / 2 / 1 / 0 / 46 / 0 / 0 | 243 / 1 / 0 / 0 / 0 / 0 / 0 | 38 |
| `db-reference-counter-declarations` | 175 / 5 / 0 / 0 / 1 / 0 / 0 | 181 / 0 / 0 / 0 / 0 / 0 / 0 | 5 |
| `db-reference-counter-discovery` | 47 / 0 / 1 / 0 / 0 / 0 / 0 | 46 / 0 / 0 / 0 / 0 / 0 / 0 | 82 |
| `db-reference-counter-runtime` | 123 / 6 / 0 / 1 / 6 / 0 / 0 | 132 / 0 / 0 / 1 / 0 / 0 / 0 | 90 |
| `db-schema-table-metadata` | 141 / 4 / 0 / 0 / 2 / 0 / 0 | 144 / 3 / 0 / 0 / 0 / 0 / 0 | 36 |
| `db-schema-migrations` | 463 / 26 / 0 / 2 / 0 / 0 / 0 | 474 / 15 / 0 / 2 / 0 / 0 / 0 | 44 |
| `db-schema-descriptions` | 91 / 3 / 0 / 2 / 0 / 0 / 0 | 94 / 0 / 0 / 2 / 0 / 0 / 0 | 46 |
| `workflow-activation-memory` | 98 / 2 / 0 / 0 / 0 / 0 / 0 | 103 / 3 / 0 / 0 / 0 / 0 / 0 | 27 |
| `workflow-activation-postgres` | 407 / 25 / 0 / 0 / 0 / 0 / 0 | 419 / 9 / 0 / 0 / 0 / 0 / 0 | 32 |
| `workflow-memory-admission` | 420 / 23 / 1 / 0 / 0 / 0 / 0 | 414 / 3 / 0 / 0 / 0 / 0 / 0 | 13 |
| `workflow-memory-operations` | 389 / 16 / 2 / 0 / 0 / 0 / 0 | 375 / 7 / 0 / 0 / 0 / 0 / 0 | 10 |
| `workflow-memory-internals` | 160 / 11 / 5 / 0 / 0 / 0 / 0 | 150 / 1 / 0 / 0 / 0 / 0 / 0 | 10 |
| `workflow-memory-commands` | 242 / 5 / 1 / 0 / 0 / 0 / 0 | 241 / 3 / 0 / 0 / 0 / 0 / 0 | 20 |
| `workflow-memory-projections` | 143 / 2 / 2 / 0 / 0 / 0 / 0 | 142 / 0 / 0 / 0 / 0 / 0 / 0 | 10 |
| `workflow-memory-validation` | 210 / 4 / 0 / 0 / 0 / 0 / 0 | 210 / 4 / 0 / 0 / 0 / 0 / 0 | 12 |
| `workflow-postgres-start` | 55 / 1 / 2 / 0 / 0 / 0 / 0 | 55 / 1 / 2 / 0 / 0 / 0 / 0 | 96 |
| `workflow-postgres-reservation` | 220 / 10 / 0 / 1 / 0 / 0 / 0 | 221 / 0 / 0 / 3 / 0 / 0 / 0 | 93 |
| `workflow-postgres-activities` | 93 / 6 / 0 / 0 / 0 / 0 / 0 | 93 / 6 / 0 / 0 / 0 / 0 / 0 | 84 |
| `workflow-postgres-history` | 90 / 3 / 1 / 0 / 0 / 0 / 0 | 92 / 1 / 1 / 0 / 0 / 0 / 0 | 173 |
| `workflow-postgres-admission-internals` | 123 / 9 / 0 / 0 / 0 / 0 / 0 | 130 / 1 / 0 / 0 / 0 / 0 / 0 | 131 |
| `workflow-postgres-row-mapping` | 160 / 3 / 0 / 0 / 0 / 0 / 0 | 153 / 1 / 0 / 0 / 0 / 0 / 0 | 449 |
| `workflow-postgres-history-decoding` | 219 / 6 / 0 / 0 / 0 / 0 / 0 | 220 / 5 / 0 / 0 / 0 / 0 / 0 | 427 |
| `workflow-runtime` | 291 / 13 / 2 / 1 / 0 / 0 / 0 | 308 / 13 / 2 / 1 / 0 / 0 / 0 | 69 |
| `workflow-scheduler` | 488 / 15 / 0 / 1 / 0 / 0 / 0 | 490 / 14 / 0 / 0 / 0 / 0 / 0 | 61 |
| `workflow-transports` | 444 / 14 / 0 / 0 / 0 / 0 / 0 | 448 / 10 / 0 / 0 / 0 / 0 / 0 | 126 |
| `workflow-replay` | 738 / 21 / 0 / 8 / 0 / 0 / 0 | 753 / 12 / 0 / 2 / 0 / 0 / 0 | 15 |
| `workflow-operations` | 499 / 17 / 0 / 0 / 0 / 0 / 0 | 504 / 12 / 0 / 0 / 0 / 0 / 0 | 122 |
| `workflow-contracts` | 482 / 5 / 0 / 1 / 5 / 0 / 0 | 485 / 2 / 0 / 1 / 5 / 0 / 0 | 67 |
| `workflow-adapter-contracts` | 198 / 40 / 0 / 1 / 101 / 0 / 0 | 299 / 40 / 0 / 1 / 0 / 0 / 0 | 23 |
| `workflow-terminal-control` | 288 / 21 / 0 / 6 / 0 / 0 / 0 | 330 / 10 / 0 / 11 / 0 / 0 / 0 | 16 |
| `workflow-task-ownership` | 75 / 0 / 0 / 0 / 0 / 0 / 0 | 82 / 0 / 0 / 0 / 0 / 0 / 0 | 36 |
| `workflow-execution-retry` | 133 / 6 / 4 / 0 / 0 / 0 / 0 | 137 / 4 / 0 / 0 / 0 / 0 / 0 | 36 |
| `postgres-ownership` | 7 / 0 / 0 / 0 / 0 / 0 / 0 | 7 / 0 / 0 / 0 / 0 / 0 / 0 | 11 |

Only the workflow `retryTask` range of `postgres-ownership` enters the workflow totals. The seven scheduled-task mutations in that execution are outside this review.

### Workflow runtime, replay and public contracts

| Profile and code | Disposition |
| --- | --- |
| `workflow-runtime`, `provider.ts` option forwarding | The client, operator, runtime and activity transport already default optional `undefined` codec or instrumentation values. Supplying an explicit `undefined` has the same behavior as omitting the property. |
| `workflow-runtime`, `provider.ts` observer bridge | Optional-sink access failures are caught per destination. Where both sinks are absent, creating the bridge adds only an internal no-op. The tests exercise the remaining destination when either one throws. |
| `workflow-runtime`, `runtime.ts` initial polling list, failure aggregation and Action scope guard | An extra resolved primitive in the pre-start `allSettled` list creates no work or error. A single failure is thrown before the aggregate threshold. The private transport callback is only invoked by a task inside `AsyncLocalStorage.run`. The diagnostic guard remains a defense against future internal misuse. |
| `workflow-runtime`, dispatcher useful-cycle predicate | The mutation that reports empty dispatches as useful removes the idle wait. Stryker's iteration limit detects the busy loop. The callback test checks useful and idle cycles without relying on process termination. |
| `workflow-scheduler`, failure aggregation and replay status | The single failure is thrown before the aggregate check, and the waiting outcome is handled before completed cancellation. Only failed or blocked results reach terminal error handling. Blocked errors from the replay contract are suspension or nondeterminism errors, so they cannot satisfy the cancellation or continuation error checks. |
| `workflow-scheduler`, activity and timer guards | An omitted optional timeout cannot satisfy the deadline comparison, and `Number.isFinite` never coerces a non-number. Durable timer payloads are JSON values and carry finite numeric durations. Arrays and primitives have no duration property. A null payload still falls through the optional property reads. The timer observations and process ownership are checked directly. |
| `workflow-scheduler`, missing observation destination or execution | Both guards are inside best-effort telemetry. Removing either can throw at the same absent property, but the exception is caught and the task outcome remains committed. Tests cover missing rows and optional instrumentation. |
| `workflow-transports`, legacy input and retry envelope | Primitive JSON values have no `input`/valid options. Numeric strings, booleans and null fail the non-coercing safe-integer checks. An omitted schedule-to-close timeout cannot satisfy the comparison. The default JSON codec is selected with either omitted or explicitly undefined options. |
| `workflow-transports`, Worker completion and generation metadata | The Action transport returns an encoded payload, and a codec that produces an absent result is outside its declared contract. Worker serialization drops undefined members. Generation one keeps its existing job identity and correlation shape. Guards for ordinary primitive JSON input are redundant once mandatory fields are read and checked. The remaining result-error guard checks object type before mandatory name and message strings. The first failure is thrown before the aggregate threshold. |
| `workflow-replay`, history projections | A completion follows its schedule and contributes its sequence to the completed set. All existing commands must be consumed before the pending check, making the consumed slice identical to the full sequence. One journal position cannot both schedule a command and mark cancellation. The synthetic completion key is a string and cannot match a numeric sequence. |
| `workflow-replay`, settled outcome and optional result | A fulfilled handler leaves the running loop even when its internal marker is changed, and the settled result dispatches by the failed branch or success fallback. Failed-only checks use an error property absent from a completed outcome. Adding an undefined result to the private completion queue resolves the same value. The capture wrapper's TypeScript parameter property installs its own cause. |
| `workflow-replay`, replay loops | Removing a replay loop body prevents progress. Inverting or forcing the pending-preparation predicate can keep draining after the queue is empty. These variants reach Stryker's iteration limit. Bounded preparation and completion tests check ordinary convergence directly. |
| `workflow-operations`, wait and child projections | A journal index identifies one event. A cancellation index cannot also be a command index. Comparing a number with an absent index is false, and an absent child sequence cannot identify a numeric command. Finite deadline predicates are non-coercing, and primitive JSON values cannot supply the deadline fields. The UTC ISO timestamp contains one final `Z`. |
| `workflow-operations`, client and operator instrumentation | When instrumentation is absent, calling its record method would throw and be caught before changing the returned start or retry result. Configured sinks are exercised through the composed provider. |
| `workflow-contracts`, fixture schema and error metadata | Invalid discriminant declarations fail Zod initialization when the suite first imports the schema. They are reported as runtime errors. Fixture parsing tests validate all durable event tags and reject unknown tags. The compatibility error's parameter property assigns its cause independently of the native constructor option. A cancellation event has no result or error to sanitize, so entering the completion sanitizer still produces the same serialized event. |
| `workflow-contracts`, cycle detection | Removing cycle detection recurses through a self-reference until the instrumented limit. The test requires a bounded serialization error at the exact payload path. |

### PostgreSQL workflow adapter

| Profile and code | Disposition |
| --- | --- |
| `workflow-adapter-contracts`, schema names and modes | Twenty-five empty SQL identifiers are inferred from an identical property name by Drizzle. Fifteen empty date-mode strings keep the default Date builder. Schema tests now reset modules and load the declaration inside the test with its metadata registries, so declaration failures can be attributed to assertions. The polling classifier's timeout variant recurses on a real cyclic cause. |
| `workflow-postgres-start`, start batch cardinality | The final statement returns one result per normalized request through left joins on unique execution identities. A trigger can suppress the insert and leave the execution missing inside a row, which has a separate regression test. |
| `workflow-activation-postgres`, fast and generic projections | The named conflict target is the table's sole unique identity. A null parent ID cannot match any row. Output and error properties belong to distinct typed outcomes. A one-element command batch has one populated slot. The fast path's scalar SELECT EXISTS returns exactly one row or rejects. |
| `workflow-postgres-reservation`, terminal polling | The remaining iteration-limit detections ignore a terminal state or stop advancing the snapshot. A deterministic polling test checks both delivery and call count. |
| `workflow-postgres-activities`, legacy completion and projections | The explicit older-generation branch is guarded by a prior inequality. An absent legacy dispatch identifier follows the same acknowledgment when its UUID check fails. The remaining SQL projection fields are used only to establish existence, and omitting the explicit false payload flag uses the schema's false default. |
| `workflow-postgres-history`, absent execution owning a task | The adapter writes the execution and its task together, and the adapter exposes no execution deletion. The remaining guards defend against an externally orphaned task. Ownership tests use valid rows from distinct executions. |
| `workflow-postgres-admission-internals`, optional result row | The scalar advisory-lock SELECT returns one row or rejects. The row's Boolean value and contention behavior are checked. |
| `workflow-postgres-row-mapping`, optional completion fields | The failed form of a completion carries an error and has no result field. The result projection's fallback therefore preserves the SQL parameters. |
| `workflow-postgres-history-decoding`, optional values and child policy | Integer validators reject wrong types without coercion. A private optional limit without a value produces the same result, and a child's persisted conflict policy is always enqueue regardless of the decoded value. |
| `workflow-execution-retry`, conflict projections | Competing retries of one target serialize on its advisory lock. An ordinary start can still win and is detected in a fresh read. Targeted and untargeted ON CONFLICT are equivalent for the only unique execution key. The projection used for conflict existence has no effect on its result. |
| `workflow-terminal-control`, descendant traversal and parent lookup | No supported operation deletes executions between enumeration and locking. A null parent ID matches no row. A changed descendant implies a changed root for the return flag. The loop hit-limit cases remove progress or keep iterating after the queue is empty. |

### Database runtime

| Profile and code | Disposition |
| --- | --- |
| `db-provider`, pool lifecycle and error metadata | Tests assert callback settlement, forced close, observer isolation and failure-version fencing. A native synchronous checkout throw precedes callback registration. Optional observation failure and unreadable error metadata stay isolated by the existing catches. Awaiting a resolved promise for an absent observer adds no observable result. `EPIPE` already matches the five-character code filter. The iteration-limit mutant reports rejected checkout as success and reenters checkout through the observer. |
| `db-instrumentation`, query and stack diagnostics | Empty catch removals keep implicit absence. Invalid inputs either return before inspection or follow the same guarded exception path. The pinned Drizzle and pg contracts return object builders and native promises. Undefined option members disappear when observations are projected. BigInts normalize to the same decimal text through the JSON fallback. An extra callback search starts with out-of-range array reads. Error headers masquerading as call frames are outside native stack formatting. The iteration-limit cases remove proxy reuse or reverse loop progress. |
| `db-schema-migrations`, subprocess and SQL output | Tests directly assert subprocess event registration and settlement, missing arguments, invalid snapshots and changed contributions. Remaining encoding, whitespace and marker variants resolve to the same UTF-8 text or supported SQL behavior. A primitive JSON value has neither a numeric index nor a valid tag. Standard Node filesystem failures are Error objects. The iteration-limit cases remove suffix progress or revisit an argument already consumed. |
| `db-instrumentation`, transaction middleware declaration | Replacing the middleware name with an empty string fails name validation at module initialization. The public name also has an explicit import assertion. The full profile reports this mutation as a runtime error during related-suite collection. |
| `db-history-declarations` and `db-history-identities`, Drizzle metadata | Empty column-name and timestamp-mode variants use the same inferred name and default Date mode. A public-schema table and the implicit public schema point to the same relation. Inferred identity columns originate from the source table. Explicit foreign identity columns are rejected by a regression test. |
| `db-history-events`, SQL type pattern | Native JSON and JSON arrays are the supported unquoted types matching the pattern. Other scalar types are validated against the history type allowlist, and Drizzle quotes enum names. Trigger tests check actor and reason for insert, update and delete. |
| `db-repository`, collection SQL | An empty default configuration returns undefined. Search has at least one predicate when compiled, and the remaining comparison/normalization variants leave valid values and their bound SQL unchanged. |
| `db-schema-table-metadata`, declaration markers | The variants repeat an identical property descriptor or relax a guard for values that cannot carry the privately registered metadata in a normal schema export. |
| `db-reference-counter-runtime` and `db-schema-descriptions`, loop progress | The rebuild loop and SQL dollar-quote delimiter loop rely on a progressing body. Removing that progress reaches Stryker's iteration limit. Ordinary cancellation, batched cursor progression and delimiter collisions have assertions. |

### Memory workflow adapter

| Profile and code | Disposition |
| --- | --- |
| `workflow-activation-memory`, optional wake and terminal state | The activation owns the single existing workflow task and replaces it when there is synchronous work. The terminal outcome and its prepared child cancellation are selected by the same status predicate. Under the typed outcome, only the completed case has an output. |
| `workflow-memory-admission`, duplicate starts and signal keys | An empty alternative list for an unkeyed start does not participate in keyed admission. Unkeyed signals cannot alias a string key in the typed API. Duplicate starts now exercise both the persisted start and the result previously staged by the same batch. |
| `workflow-memory-operations`, journal and generation guards | A journal index cannot be both a cancellation event and the later scheduled command. Explicit current and old generation completions and the legacy dispatch proof are exercised. A valid version-blocked row has a diagnostic, and the owned task or prepared recovery wake preserves readiness. An absent result has the same meaning as an explicitly undefined result at the typed completion boundary. |
| `workflow-memory-internals`, retained admission | A pending execution has no activation until admission. Allocation failure and both deferred-map cleanup paths are exercised by subsequent workflow polls. |
| `workflow-memory-commands`, history filtering and parent linkage | Only scheduled events contain a command kind and target. A child with incomplete or closed parent linkage cannot update a parent. The parent completion check at application time still deduplicates even if the earlier preflight guard is removed. |
| `workflow-memory-validation`, command field narrowing | Safe-integer predicates reject nonnumeric input without coercion. The optional definition limit and keyed concurrency checks operate on validated metadata. |
| `workflow-execution-retry`, transient metadata | Retry uses the retained admission scope and limit to decide whether to queue. The adapter restores the durable original conflict policy, and an explicit undefined concurrency option is equivalent to omission. |
| `workflow-terminal-control`, lineage and progress | Tests cover cyclic ancestry, cancellation of pending descendants, and avoiding duplicate parent wake-ups. Variants that remove traversal progress or the visited guard can loop on a real cycle and are detected by the iteration limit. |

### Reading the remaining outcomes

The report retains equivalent and defensive mutations in their original Stryker status. No mutation exclusions were added. The 29 timeout detections all reached Stryker's instrumented hit limit. The six import errors record invalid declarations that fail before Vitest can attribute an assertion to a test. The five uncovered mutations guard conditions outside the supported workflow paths described above. The index below identifies the reported outcome and source line for each residual.

### Residual report index

Paths are relative to `src/packages/kestrel/src`. IDs identify mutants within each named profile's final local report. The section tables above give the corresponding invariants and detection limits.

#### `db`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `db-provider` | `db/pool_runtime.ts:197` | Timeout | 191 |
| `db-provider` | `db/pool_runtime.ts:219` | Survived | 228 |
| `db-provider` | `db/pool_runtime.ts:267` | Survived | 295 |
| `db-provider` | `db/pool_runtime.ts:268` | Survived | 297 |
| `db-provider` | `db/pool_runtime.ts:278` | Survived | 303, 304, 305, 306, 307, 310 |
| `db-provider` | `db/pool_runtime.ts:280` | Survived | 331 |
| `db-provider` | `db/pool_runtime.ts:282` | Survived | 332 |
| `db-provider` | `db/provider.ts:102` | Survived | 374 |
| `db-instrumentation` | `db/middleware.ts:7` | RuntimeError | 0 |
| `db-instrumentation` | `db/query_instrumentation.ts:30` | Survived | 13 |
| `db-instrumentation` | `db/query_instrumentation.ts:138` | Timeout | 58, 60 |
| `db-instrumentation` | `db/query_instrumentation.ts:167` | Timeout | 75 |
| `db-instrumentation` | `db/query_instrumentation.ts:224` | Survived | 104, 106 |
| `db-instrumentation` | `db/query_instrumentation.ts:348` | Survived | 126 |
| `db-instrumentation` | `db/query_instrumentation.ts:359` | Survived | 136 |
| `db-instrumentation` | `db/query_instrumentation.ts:361` | Survived | 139 |
| `db-instrumentation` | `db/query_instrumentation.ts:368` | Survived | 141 |
| `db-instrumentation` | `db/query_instrumentation.ts:368` | Timeout | 145 |
| `db-instrumentation` | `db/query_instrumentation.ts:378` | Survived | 160 |
| `db-instrumentation` | `db/query_instrumentation.ts:434` | Survived | 216, 217, 218, 221 |
| `db-instrumentation` | `db/query_instrumentation.ts:437` | Survived | 227 |
| `db-instrumentation` | `db/query_instrumentation.ts:448` | Survived | 235, 237 |
| `db-instrumentation` | `db/query_instrumentation.ts:456` | Survived | 246 |
| `db-instrumentation` | `db/query_instrumentation.ts:491` | Survived | 260 |
| `db-instrumentation` | `db/query_instrumentation.ts:498` | Survived | 267 |
| `db-instrumentation` | `db/query_instrumentation.ts:532` | Survived | 309 |
| `db-repository` | `db/repository.ts:104` | Survived | 120 |
| `db-repository` | `db/repository.ts:279` | Survived | 187 |
| `db-repository` | `db/repository.ts:509` | Survived | 288, 291 |
| `db-history-declarations` | `db/history/definition.ts:129` | Survived | 8, 9 |
| `db-history-declarations` | `db/history/definition.ts:138` | Survived | 14 |
| `db-history-declarations` | `db/history/definition.ts:192` | Survived | 31 |
| `db-history-identities` | `db/history/definition.ts:364` | Survived | 19 |
| `db-history-events` | `db/history/trigger_sql.ts:211` | Survived | 201 |
| `db-reference-counter-runtime` | `db/reference_counter/maintenance.ts:48` | Timeout | 46 |
| `db-schema-table-metadata` | `db/framework_table.ts:7` | Survived | 5 |
| `db-schema-table-metadata` | `db/framework_table.ts:17` | Survived | 19 |
| `db-schema-table-metadata` | `db/schema_contributions/definition.ts:62` | Survived | 62 |
| `db-schema-migrations` | `db/schema_contributions/description_diff.ts:30` | Survived | 42 |
| `db-schema-migrations` | `db/schema_contributions/description_diff.ts:30` | Timeout | 44 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:208` | Survived | 230 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:210` | Survived | 234 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:214` | Survived | 240 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:219` | Survived | 244 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:228` | Survived | 253 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:239` | Survived | 259 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:259` | Survived | 301 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:282` | Survived | 339 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:306` | Survived | 365 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:307` | Survived | 370 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:311` | Survived | 372 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:362` | Survived | 408 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:410` | Timeout | 470 |
| `db-schema-migrations` | `db/schema_contributions/migration_generator.ts:443` | Survived | 496, 497 |
| `db-schema-descriptions` | `db/sql_dollar_quote.ts:4` | Timeout | 103 |
| `db-schema-descriptions` | `db/sql_dollar_quote.ts:5` | Timeout | 104 |

#### `workflows`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `workflow-activation-memory` | `workflows/adapters/memory/adapter.ts:625` | Survived | 75 |
| `workflow-activation-memory` | `workflows/adapters/memory/adapter.ts:1206` | Survived | 92 |
| `workflow-activation-memory` | `workflows/adapters/memory/adapter.ts:1216` | Survived | 105 |
| `workflow-activation-postgres` | `workflows/adapters/postgres/adapter.ts:1123` | Survived | 134 |
| `workflow-activation-postgres` | `workflows/adapters/postgres/adapter.ts:1224` | Survived | 269 |
| `workflow-activation-postgres` | `workflows/adapters/postgres/adapter.ts:1225` | Survived | 277 |
| `workflow-activation-postgres` | `workflows/adapters/postgres/adapter.ts:1258` | Survived | 297 |
| `workflow-activation-postgres` | `workflows/adapters/postgres/adapter.ts:1329` | Survived | 361 |
| `workflow-activation-postgres` | `workflows/adapters/postgres/adapter.ts:1497` | Survived | 409 |
| `workflow-activation-postgres` | `workflows/adapters/postgres/adapter.ts:1505` | Survived | 415 |
| `workflow-activation-postgres` | `workflows/adapters/postgres/adapter.ts:1509` | Survived | 420 |
| `workflow-activation-postgres` | `workflows/adapters/postgres/adapter.ts:1567` | Survived | 428 |
| `workflow-memory-admission` | `workflows/adapters/memory/adapter.ts:225` | Survived | 58 |
| `workflow-memory-admission` | `workflows/adapters/memory/adapter.ts:387` | Survived | 295 |
| `workflow-memory-admission` | `workflows/adapters/memory/adapter.ts:427` | Survived | 330 |
| `workflow-memory-operations` | `workflows/adapters/memory/adapter.ts:701` | Survived | 98 |
| `workflow-memory-operations` | `workflows/adapters/memory/adapter.ts:703` | Survived | 113 |
| `workflow-memory-operations` | `workflows/adapters/memory/adapter.ts:748` | Survived | 141 |
| `workflow-memory-operations` | `workflows/adapters/memory/adapter.ts:749` | Survived | 146 |
| `workflow-memory-operations` | `workflows/adapters/memory/adapter.ts:762` | Survived | 177 |
| `workflow-memory-operations` | `workflows/adapters/memory/adapter.ts:1016` | Survived | 258 |
| `workflow-memory-operations` | `workflows/adapters/memory/adapter.ts:1109` | Survived | 328 |
| `workflow-memory-internals` | `workflows/adapters/memory/adapter.ts:1315` | Survived | 109 |
| `workflow-memory-commands` | `workflows/adapters/memory/adapter.ts:1476` | Survived | 57, 59 |
| `workflow-memory-commands` | `workflows/adapters/memory/adapter.ts:1605` | Survived | 201 |
| `workflow-memory-validation` | `workflows/adapters/memory/adapter.ts:1937` | Survived | 20 |
| `workflow-memory-validation` | `workflows/adapters/memory/adapter.ts:1995` | Survived | 74 |
| `workflow-memory-validation` | `workflows/adapters/memory/adapter.ts:2014` | Survived | 113 |
| `workflow-memory-validation` | `workflows/adapters/memory/adapter.ts:2033` | Survived | 151 |
| `workflow-postgres-start` | `workflows/adapters/postgres/adapter.ts:471` | NoCoverage | 42 |
| `workflow-postgres-start` | `workflows/adapters/postgres/adapter.ts:471` | Survived | 40 |
| `workflow-postgres-start` | `workflows/adapters/postgres/adapter.ts:472` | NoCoverage | 44 |
| `workflow-postgres-reservation` | `workflows/adapters/postgres/adapter.ts:595` | Timeout | 81, 84, 85 |
| `workflow-postgres-activities` | `workflows/adapters/postgres/adapter.ts:1838` | Survived | 44 |
| `workflow-postgres-activities` | `workflows/adapters/postgres/adapter.ts:1839` | Survived | 49 |
| `workflow-postgres-activities` | `workflows/adapters/postgres/adapter.ts:1843` | Survived | 55 |
| `workflow-postgres-activities` | `workflows/adapters/postgres/adapter.ts:1852` | Survived | 60 |
| `workflow-postgres-activities` | `workflows/adapters/postgres/adapter.ts:1862` | Survived | 69 |
| `workflow-postgres-activities` | `workflows/adapters/postgres/adapter.ts:1888` | Survived | 88 |
| `workflow-postgres-history` | `workflows/adapters/postgres/adapter.ts:2183` | NoCoverage | 63 |
| `workflow-postgres-history` | `workflows/adapters/postgres/adapter.ts:2183` | Survived | 61 |
| `workflow-postgres-admission-internals` | `workflows/adapters/postgres/adapter.ts:2548` | Survived | 22 |
| `workflow-postgres-row-mapping` | `workflows/adapters/postgres/adapter.ts:2893` | Survived | 142 |
| `workflow-postgres-history-decoding` | `workflows/adapters/postgres/adapter.ts:3043` | Survived | 128 |
| `workflow-postgres-history-decoding` | `workflows/adapters/postgres/adapter.ts:3093` | Survived | 178 |
| `workflow-postgres-history-decoding` | `workflows/adapters/postgres/adapter.ts:3100` | Survived | 190 |
| `workflow-postgres-history-decoding` | `workflows/adapters/postgres/adapter.ts:3114` | Survived | 215 |
| `workflow-postgres-history-decoding` | `workflows/adapters/postgres/adapter.ts:3119` | Survived | 234 |
| `workflow-runtime` | `workflows/provider.ts:78` | Survived | 52 |
| `workflow-runtime` | `workflows/provider.ts:81` | Survived | 56 |
| `workflow-runtime` | `workflows/provider.ts:92` | Survived | 66 |
| `workflow-runtime` | `workflows/provider.ts:95` | Survived | 70 |
| `workflow-runtime` | `workflows/provider.ts:112` | Survived | 82 |
| `workflow-runtime` | `workflows/provider.ts:175` | Survived | 137 |
| `workflow-runtime` | `workflows/provider.ts:181` | Survived | 146 |
| `workflow-runtime` | `workflows/provider.ts:183` | Survived | 148 |
| `workflow-runtime` | `workflows/provider.ts:184` | Survived | 149 |
| `workflow-runtime` | `workflows/runtime.ts:51` | Survived | 164 |
| `workflow-runtime` | `workflows/runtime.ts:75` | Survived | 175 |
| `workflow-runtime` | `workflows/runtime.ts:79` | NoCoverage | 182 |
| `workflow-runtime` | `workflows/runtime.ts:79` | Survived | 180 |
| `workflow-runtime` | `workflows/runtime.ts:80` | NoCoverage | 184 |
| `workflow-runtime` | `workflows/runtime.ts:272` | Survived | 333 |
| `workflow-runtime` | `workflows/runtime.ts:280` | Timeout | 342 |
| `workflow-scheduler` | `workflows/scheduler.ts:183` | Survived | 73 |
| `workflow-scheduler` | `workflows/scheduler.ts:367` | Survived | 202 |
| `workflow-scheduler` | `workflows/scheduler.ts:410` | Survived | 226 |
| `workflow-scheduler` | `workflows/scheduler.ts:424` | Survived | 249 |
| `workflow-scheduler` | `workflows/scheduler.ts:496` | Survived | 289 |
| `workflow-scheduler` | `workflows/scheduler.ts:561` | Survived | 333 |
| `workflow-scheduler` | `workflows/scheduler.ts:590` | Survived | 376 |
| `workflow-scheduler` | `workflows/scheduler.ts:685` | Survived | 481, 483, 484, 485, 486 |
| `workflow-scheduler` | `workflows/scheduler.ts:686` | Survived | 489 |
| `workflow-scheduler` | `workflows/scheduler.ts:690` | Survived | 498 |
| `workflow-transports` | `workflows/activity_transport.ts:254` | Survived | 103 |
| `workflow-transports` | `workflows/activity_transport.ts:300` | Survived | 151 |
| `workflow-transports` | `workflows/activity_transport.ts:309` | Survived | 163 |
| `workflow-transports` | `workflows/worker_activity_transport.ts:73` | Survived | 177 |
| `workflow-transports` | `workflows/worker_activity_transport.ts:94` | Survived | 193 |
| `workflow-transports` | `workflows/worker_activity_transport.ts:108` | Survived | 208 |
| `workflow-transports` | `workflows/worker_activity_transport.ts:171` | Survived | 250 |
| `workflow-transports` | `workflows/worker_activity_transport.ts:284` | Survived | 323 |
| `workflow-transports` | `workflows/worker_activity_transport.ts:296` | Survived | 363 |
| `workflow-transports` | `workflows/worker_activity_transport.ts:354` | Survived | 461 |
| `workflow-replay` | `workflows/replay/memory_journal.ts:107` | Survived | 221 |
| `workflow-replay` | `workflows/replay/runner.ts:73` | Survived | 271 |
| `workflow-replay` | `workflows/replay/runner.ts:83` | Timeout | 281 |
| `workflow-replay` | `workflows/replay/runner.ts:112` | Survived | 302 |
| `workflow-replay` | `workflows/replay/runner.ts:164` | Survived | 334 |
| `workflow-replay` | `workflows/replay/runner.ts:204` | Survived | 351 |
| `workflow-replay` | `workflows/replayer.ts:77` | Survived | 444 |
| `workflow-replay` | `workflows/replayer.ts:111` | Timeout | 466 |
| `workflow-replay` | `workflows/replayer.ts:152` | Survived | 504 |
| `workflow-replay` | `workflows/replayer.ts:251` | Survived | 543 |
| `workflow-replay` | `workflows/replayer.ts:386` | Survived | 648 |
| `workflow-replay` | `workflows/replayer.ts:463` | Survived | 709 |
| `workflow-replay` | `workflows/replayer.ts:465` | Survived | 712 |
| `workflow-replay` | `workflows/replayer.ts:469` | Survived | 723 |
| `workflow-operations` | `workflows/client.ts:199` | Survived | 49 |
| `workflow-operations` | `workflows/execution_cursor.ts:22` | Survived | 157 |
| `workflow-operations` | `workflows/operations.ts:228` | Survived | 225 |
| `workflow-operations` | `workflows/operations.ts:268` | Survived | 247 |
| `workflow-operations` | `workflows/operations.ts:281` | Survived | 274 |
| `workflow-operations` | `workflows/operations.ts:299` | Survived | 291 |
| `workflow-operations` | `workflows/operations.ts:306` | Survived | 305 |
| `workflow-operations` | `workflows/operations.ts:308` | Survived | 320 |
| `workflow-operations` | `workflows/operations.ts:313` | Survived | 327 |
| `workflow-operations` | `workflows/operations.ts:361` | Survived | 371 |
| `workflow-operations` | `workflows/operations.ts:362` | Survived | 374 |
| `workflow-operations` | `workflows/operations.ts:396` | Survived | 410 |
| `workflow-contracts` | `workflows/serialization.ts:68` | Timeout | 221 |
| `workflow-contracts` | `workflows/testing.ts:82` | Survived | 306 |
| `workflow-contracts` | `workflows/testing.ts:148` | Survived | 352 |
| `workflow-contracts` | `workflows/testing.ts:331` | RuntimeError | 437 |
| `workflow-contracts` | `workflows/testing.ts:332` | RuntimeError | 439 |
| `workflow-contracts` | `workflows/testing.ts:339` | RuntimeError | 443 |
| `workflow-contracts` | `workflows/testing.ts:347` | RuntimeError | 445 |
| `workflow-contracts` | `workflows/testing.ts:353` | RuntimeError | 447 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/polling_error.ts:6` | Timeout | 29 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:32` | Survived | 68 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:37` | Survived | 72 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:42` | Survived | 74 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:54` | Survived | 75 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:56` | Survived | 78 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:60` | Survived | 83 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:78` | Survived | 96 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:80` | Survived | 99 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:84` | Survived | 103 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:88` | Survived | 107 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:145` | Survived | 152 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:146` | Survived | 153 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:148` | Survived | 156 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:176` | Survived | 177 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:185` | Survived | 181 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:188` | Survived | 184 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:190` | Survived | 187 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:193` | Survived | 191 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:233` | Survived | 222 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:235` | Survived | 225 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:237` | Survived | 227 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:238` | Survived | 228 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:239` | Survived | 229 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:241` | Survived | 232 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:245` | Survived | 236 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:250` | Survived | 241 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:285` | Survived | 267 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:287` | Survived | 270 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:289` | Survived | 271 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:292` | Survived | 275 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:296` | Survived | 279 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:330` | Survived | 300 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:333` | Survived | 304 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:334` | Survived | 305 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:335` | Survived | 306 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:337` | Survived | 309 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:341` | Survived | 313 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:345` | Survived | 317 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:349` | Survived | 320 |
| `workflow-adapter-contracts` | `workflows/adapters/postgres/schema.ts:351` | Survived | 323 |
| `workflow-terminal-control` | `workflows/adapters/memory/adapter.ts:842` | Timeout | 39 |
| `workflow-terminal-control` | `workflows/adapters/memory/adapter.ts:845` | Timeout | 41 |
| `workflow-terminal-control` | `workflows/adapters/memory/adapter.ts:846` | Timeout | 42 |
| `workflow-terminal-control` | `workflows/adapters/memory/adapter.ts:1651` | Timeout | 84, 85, 86 |
| `workflow-terminal-control` | `workflows/adapters/memory/adapter.ts:1652` | Timeout | 90 |
| `workflow-terminal-control` | `workflows/adapters/memory/adapter.ts:1664` | Survived | 113 |
| `workflow-terminal-control` | `workflows/adapters/memory/adapter.ts:1665` | Survived | 115 |
| `workflow-terminal-control` | `workflows/adapters/postgres/adapter.ts:2314` | Timeout | 189, 191 |
| `workflow-terminal-control` | `workflows/adapters/postgres/adapter.ts:2324` | Survived | 200 |
| `workflow-terminal-control` | `workflows/adapters/postgres/adapter.ts:2353` | Survived | 227 |
| `workflow-terminal-control` | `workflows/adapters/postgres/adapter.ts:2401` | Survived | 263 |
| `workflow-terminal-control` | `workflows/adapters/postgres/adapter.ts:2407` | Timeout | 268, 270 |
| `workflow-terminal-control` | `workflows/adapters/postgres/adapter.ts:2419` | Survived | 279, 281, 282 |
| `workflow-terminal-control` | `workflows/adapters/postgres/adapter.ts:2468` | Survived | 318 |
| `workflow-terminal-control` | `workflows/adapters/postgres/adapter.ts:2507` | Survived | 351 |
| `workflow-execution-retry` | `workflows/adapters/memory/adapter.ts:928` | Survived | 50 |
| `workflow-execution-retry` | `workflows/adapters/memory/adapter.ts:934` | Survived | 53 |
| `workflow-execution-retry` | `workflows/adapters/postgres/adapter.ts:2033` | Survived | 125 |
| `workflow-execution-retry` | `workflows/adapters/postgres/adapter.ts:2037` | Survived | 130 |
