# Final framework component mutation review

[Component inventory](./mutation_testing_inventory.md) · [Framework assessment](./mutation_testing_framework.md) · [Running mutation tests](../contributing/mutation-testing.md)

The sixth wave covers `cli`, `client`, `email`, `log`, `observability`, `utils`, `testing` and `controllers`. The November 12, 2026 reference uses revision `b911e58` and the same named scope definitions as the follow-up. The profiles run related Vitest suites, retain static and hybrid mutants, and apply a ten-minute execution limit that includes the initial instrumented tests. The review target is 95% per component.

Stryker scores are calculated over killed, timed-out, surviving and uncovered mutants. Runtime and compilation errors and ignored outcomes stay visible separately. A profile with zero eligible mutants has no numerical score. Component scores use total outcomes across disjoint profiles.

## Results

Outcome columns report Killed / Survived / NoCoverage / Timeout / RuntimeError / CompileError / Ignored.

All 23 pairs completed across 88 candidate files. The longest execution took 241 seconds. Final results include 32 kills reported by Vitest test deadlines (4 CLI, 8 client, 17 log and 3 observability), plus six Stryker iteration-limit timeouts (2 client and 4 log). The scores below preserve these detections.

| Component | Verified profiles | Before outcomes | After outcomes | Score before → after |
| --- | ---: | --- | --- | ---: |
| `cli` | 3 | 379 / 107 / 21 / 2 / 4 / 0 / 0 | 469 / 11 / 4 / 0 / 0 / 0 / 0 | 74.85% → 96.90% |
| `client` | 3 | 285 / 66 / 1 / 3 / 0 / 0 / 0 | 332 / 3 / 0 / 2 / 0 / 0 / 0 | 81.13% → 99.11% |
| `email` | 6 | 805 / 239 / 20 / 0 / 33 / 0 / 0 | 1046 / 40 / 0 / 0 / 33 / 0 / 0 | 75.66% → 96.32% |
| `log` | 4 | 412 / 94 / 9 / 5 / 12 / 0 / 0 | 489 / 21 / 0 / 4 / 11 / 0 / 0 | 80.19% → 95.91% |
| `observability` | 3 | 436 / 92 / 12 / 4 / 15 / 0 / 0 | 530 / 21 / 0 / 0 / 15 / 0 / 0 | 80.88% → 96.19% |
| `utils` | 2 | 193 / 40 / 6 / 0 / 0 / 0 / 0 | 240 / 9 / 0 / 0 / 0 / 0 / 0 | 80.75% → 96.39% |
| `testing` | 1 | 0 / 0 / 0 / 0 / 1 / 0 / 0 | 1 / 0 / 0 / 0 / 0 / 0 / 0 | N/A → 100.00% |
| `controllers` | 1 | 0 / 0 / 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 / 0 / 0 | N/A → N/A |

### Per-profile executions

| Profile | Before → after mutants | Before / after seconds | Score before → after |
| --- | ---: | ---: | ---: |
| `cli-entrypoint` | 74 → 65 | 190 / 131 | 48.65% → 92.31% |
| `cli-dispatch` | 255 → 238 | 120 / 82 | 83.53% → 97.90% |
| `cli-input` | 184 → 181 | 187 / 85 | 73.33% → 97.24% |
| `client-provider` | 121 → 95 | 47 / 37 | 80.99% → 98.95% |
| `client-vite-build` | 97 → 98 | 131 / 130 | 83.51% → 98.98% |
| `client-vite-development` | 137 → 144 | 50 / 44 | 79.56% → 99.31% |
| `email-delivery` | 157 → 156 | 44 / 49 | 79.62% → 99.36% |
| `email-composition` | 252 → 267 | 86 / 105 | 85.71% → 98.50% |
| `email-provider` | 93 → 93 | 28 / 34 | 76.34% → 91.40% |
| `email-transport-adapters` | 210 → 208 | 59 / 28 | 66.19% → 99.52% |
| `email-capture-adapters` | 145 → 145 | 44 / 40 | 72.41% → 96.55% |
| `email-postgres-capture` | 240 → 250 | 81 / 72 | 71.98% → 90.32% |
| `log-runtime` | 163 → 156 | 68 / 67 | 82.21% → 96.15% |
| `log-postgres-transport` | 180 → 185 | 52 / 46 | 89.44% → 98.38% |
| `log-storage` | 84 → 84 | 71 / 56 | 67.12% → 83.56% |
| `log-contracts` | 105 → 100 | 101 / 57 | 70.19% → 100.00% |
| `observability-recording` | 226 → 232 | 74 / 75 | 89.38% → 97.84% |
| `observability-postgres` | 195 → 197 | 241 / 186 | 81.67% → 91.21% |
| `observability-runtime` | 138 → 137 | 182 / 64 | 65.94% → 100.00% |
| `utils-codecs` | 113 → 123 | 124 / 104 | 70.80% → 93.50% |
| `utils-catalog` | 126 → 126 | 129 / 107 | 89.68% → 99.21% |
| `testing-http-access` | 1 → 1 | 6 / 7 | N/A → 100.00% |
| `controllers-contracts` | 0 → 0 | 11 / 17 | N/A → N/A |

## Confirmed defects and remaining mutants

### CLI

- A rejected controller registration could leave partial command and catalog state, so registering a corrected definition failed on retry. The manager validates the command before publishing it.
- Commander could merge distinct schema bindings under the same parsed option key, including value-taking `--no-*` options. Inherited option names could also leak into omitted input fields. The manager validates resolved option keys and reads only supplied values.
- The entrypoint retains child-process smoke coverage and now has direct checks for embedded invocation, error reporting and executable shutdown. Residuals include child-only entrypoint activation, defensive fallback branches and a combination of independent CLI and action descriptions. Four dispatch outcomes in each run were detected by a Vitest test deadline when a mutant prevented disposal. The reference also recorded two iteration-limit detections in global-option parsing.

### Browser client

- Browser client paths with route metacharacters or dot segments could be registered with a different meaning in Fastify and the browser. Client, asset and exclusion paths now require literal paths.
- A failed shared Vite startup could block all later mounts even after the setup was corrected. A rejected startup now releases the shared startup state so a later mount can retry.
- Changing the caller's receipt list could leak the original Vite dependency file watchers. The watcher now retains the exact subscribed paths. Development entry validation rejects drive-relative Windows paths and HTML or module paths that resolve to the root directory. External module URLs preserve literal backslashes on POSIX.
- The remaining browser client variants affect a redundant regular-expression alternative, an explicitly undefined factory field, and a default label whose spelling cannot affect the directory path. Two watcher variants reach Stryker's iteration limit by keeping the restart loop active.

### Email

- Concurrent or later `EmailClient.close()` calls could resolve before transport shutdown finished or lose its failure. Calls now share the shutdown result.
- Sparse recipient and attachment arrays could bypass validation. Unsupported attachment dispositions could also reach the transport. Composition now validates each slot and the runtime disposition.
- PostgreSQL capture clearing used separate statements for attachment and message deletion. A concurrent insert could land between the two statements, causing its message to be removed while its attachments remained. Both deletes now use one PostgreSQL statement snapshot.
- PostgreSQL capture lookup could read a message immediately before a clear and then read its attachments after the clear. A read-only repeatable-read transaction keeps the message and attachment reads on one snapshot.
- Remaining email variants include Drizzle defaults and aliases, omitted versus explicitly undefined fields, defensive pagination and observation branches, and optional delivery status shape. Both executions of the PostgreSQL profile report 33 import errors from malformed schema and description declarations.

### Log

- A substring filter could discard logs for unrelated requests whose paths or query strings happened to contain the Studio log viewer route. The transport now compares the route path separately from the query.
- A second development logger close could resolve before the Pino worker drained. Concurrent callers now wait for the same shutdown.
- After changing log destinations, a transient failure creating a child logger could leave later calls writing to the previous destination. The cached destination and child are now published together after successful creation.
- A custom logger close failure was reported twice during application disposal because two owners awaited the same rejected adapter promise. The adapter registration now owns backend cleanup, while the logger resource resets its facade and closes its fallback.
- Storage residuals come from implicit Drizzle names and timestamp modes, optional pagination guards and SQL filters that Drizzle simplifies to the same query. Log transport iteration-limit detections represent mutations that keep the batching loop active.

### Observability

- Legacy JSONB execution metadata could contain JSON null. That row could crash the execution page instead of using the existing operation and transport fallbacks.
- A rejected retry delay could leave a batch pending indefinitely, using recorder capacity and preventing later observations from being admitted. The recorder now settles the failed batch under its configured policy and retains both failure causes.
- One fail-fast observation write error could appear three times in the application shutdown error. The recorder now has one cleanup owner, and the container fallback reports the adapter result only when the application shutdown boundary has yet to observe it. An application shutdown regression also verifies that independent disposal errors are preserved.
- PostgreSQL residuals include explicit names that Drizzle already infers from matching property names, default timestamp modes, empty-page cursor guards, and the existing direct transport fallback. Mutants that prevent schema initialization remain reported as runtime errors.

### Utilities

- Pagination cursor encoding could serialize different data from what it validated. A non-enumerable `toJSON` hook could replace an array or nested record, and a stateful getter could make a validated field disappear on the second read. The encoder now snapshots validated values and rejects custom serialization hooks. Tests also cover canonical base64url, UTF-8, exact token size and timestamp boundaries, catalog ownership, and missing definition discriminants.
- The codec's residuals change intermediate error text that is replaced by a public validation issue, use Buffer's default UTF-8 encoding, or remove a type guard before an operation that rejects the same non-object values. They retain their raw Stryker outcomes.

### Testing

- This component's one static mutant replaces the HTTP fixture policy name with an empty string. The reference classified it as a runtime error because consumers imported the fixture during test collection. The dedicated test loads the same fixture inside the test and turns the initialization failure into a recorded kill. Production code, the related-suite policy and mutation scope stayed the same. PostgreSQL and Redis connection fixtures remain excluded from the framework mutation scope.

### Controllers

- The shared empty input schema and type-only exports produce zero mutations with the configured operators. Both profile executions record this outcome. HTTP and CLI tests exercise the shared default through their respective public controller definitions.

## Evidence

Reports, execution records, source-scope audits and machine-readable counts are archived under `artifacts/mutation/wave-six/`. The source audit compares full-component and per-profile mutation fingerprints, accounting for multiline mutations at range boundaries. The report comparison also verifies the selected source and the frozen reference test snapshot. It records related test snapshots that changed between profile runs.

The additional `app-contracts` profile measures the shared adapter shutdown fix. It stayed at 100% in 82 seconds before and 79 seconds after, with 69 and 75 eligible mutants respectively. All eight final mutants in `app/adapter.ts` were killed by assertions. Both runs recorded two iteration-limit detections for cyclic error causes and 18 errors from malformed static event declarations.

The final checkout passed 4,959 tests across 363 files and all 222 mutation infrastructure checks. The framework and Playground builds, framework typecheck, ownership boundary check, and inventory audit also passed.
