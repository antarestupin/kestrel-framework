# Studio, Atlas and throttling mutation review

[Lot inventory](./mutation_testing_inventory.md) · [Framework assessment](./mutation_testing_framework.md) · [Running mutation tests](../contributing/mutation-testing.md)

This review uses November 12, 2026 as its reference date. Studio and Atlas use fresh references from the initial revision and independent named profiles. The final evidence includes fresh assessments and recorded incremental continuations. Throttling compares with the preceding [security and resilience review](./mutation_testing_security_resilience.md#throttling). The focused profiles keep static and hybrid mutants, use separate reports, and enforce a 600-second budget per execution. The initial instrumented Vitest run counts toward that budget. The 95% target is informational and applies to the aggregate for each component.

Stryker counts assertion failures and individual mutant timeouts as detections. The reported denominator includes detected mutants, survivors and uncovered mutants. Runtime errors, compile errors and ignored mutants are reported separately. A run stopped by the 600-second budget provides a partial checkpoint. Smaller profiles take over from oversized attempts without including those attempts in the aggregate.

## Results

Counts are Killed / Survived / NoCoverage / Timeout / RuntimeError / CompileError / Ignored. Aggregate scores use only verified before/after pairs. Where assessment is partial, the score applies to the measured profiles.

| Component | Verified profiles | Before outcomes | After outcomes | Stryker score |
| --- | ---: | --- | --- | --- |
| `throttling` | 14/14 | 4162 / 268 / 17 / 26 / 35 / 0 / 0 | 4309 / 207 / 11 / 28 / 35 / 0 / 0 | 93.63% → 95.21% |
| `studio` | 25/25 | 4945 / 1455 / 45 / 4 / 10 / 0 / 4 | 6331 / 258 / 2 / 6 / 11 / 0 / 4 | 76.74% → 96.06% |
| `atlas` | 28/28 | 4149 / 1068 / 112 / 7 / 194 / 0 / 0 | 5310 / 250 / 28 / 6 / 35 / 0 / 0 | 77.89% → 95.03% |

### Throttling profiles

| Profile | Before / after mutants | Paired | Before / after seconds | Before / after score |
| --- | ---: | ---: | ---: | --- |
| `throttling-admission` | 559 / 580 | 536 | 205 / 575 | 92.13% → 95.00% |
| `throttling-queues` | 162 / 168 | 148 | 162 / 239 | 85.19% → 85.71% |
| `throttling-circuits` | 293 / 294 | 282 | 112 / 267 | 90.78% → 91.50% |
| `throttling-completion` | 529 / 528 | 501 | 193 / 206 | 95.84% → 96.59% |
| `throttling-postgres-admission` | 333 / 330 | 321 | 329 / 326 | 95.20% → 97.58% |
| `throttling-postgres-leases` (carried) | 303 / 303 | 303 | 331 / 331 | 96.04% → 96.04% |
| `throttling-leased` | 489 / 526 | 428 | 236 / 344 | 92.43% → 93.54% |
| `throttling-adapter-wrappers` | 466 / 474 | 463 | 188 / 216 | 91.85% → 94.30% |
| `throttling-storage` | 475 / 475 | 475 | 530 / 432 | 94.70% → 98.52% |
| `throttling-provider` | 444 / 457 | 442 | 350 / 372 | 93.69% → 95.19% |
| `throttling-definitions-factories` (carried) | 118 / 118 | 118 | 193 / 193 | 99.15% → 99.15% |
| `throttling-definitions-validation` (carried) | 181 / 181 | 181 | 391 / 391 | 100.00% → 100.00% |
| `throttling-schema` (carried) | 77 / 77 | 77 | 123 / 123 | 77.08% → 77.08% |
| `throttling-public-contracts` (carried) | 79 / 79 | 79 | 51 / 51 | 100.00% → 100.00% |

### Studio profiles

| Profile | Before / after mutants | Paired | Before / after seconds | Before / after score |
| --- | ---: | ---: | ---: | --- |
| `studio-server-core` | 477 / 489 | 470 | 416 / 113 | 83.61% → 96.11% |
| `studio-server-actions` | 438 / 447 | 428 | 244 / 463 | 80.59% → 98.43% |
| `studio-server-database-schema` | 389 / 382 | 363 | 421 / 414 | 60.15% → 96.34% |
| `studio-server-http-database` | 207 / 214 | 203 | 197 / 350 | 83.57% → 97.20% |
| `studio-server-diagnostics` | 191 / 183 | 175 | 185 / 238 | 81.68% → 100.00% |
| `studio-server-workers-email` | 289 / 293 | 282 | 316 / 413 | 81.31% → 96.93% |
| `studio-server-scheduled-tasks` | 214 / 214 | 214 | 208 / 308 | 80.84% → 93.93% |
| `studio-server-workflows` | 291 / 296 | 246 | 340 / 505 | 77.32% → 95.95% |
| `studio-client-runtime` | 91 / 92 | 71 | 28 / 81 | 87.36% → 100.00% |
| `studio-client-views` | 154 / 154 | 154 | 65 / 167 | 78.57% → 95.45% |
| `studio-client-actions` | 277 / 275 | 263 | 215 / 417 | 84.78% → 96.72% |
| `studio-client-controller-view` | 299 / 281 | 268 | 297 / 377 | 73.15% → 96.43% |
| `studio-client-controller-request` | 132 / 134 | 117 | 74 / 78 | 96.97% → 98.51% |
| `studio-client-database` | 280 / 278 | 265 | 255 / 257 | 78.85% → 97.10% |
| `studio-client-email-inbox` | 106 / 113 | 71 | 194 / 213 | 75.24% → 90.27% |
| `studio-client-email-capture` | 159 / 195 | 143 | 261 / 263 | 64.78% → 94.87% |
| `studio-client-email-pagination` | 137 / 165 | 128 | 207 / 272 | 81.02% → 92.73% |
| `studio-client-logs` | 211 / 224 | 150 | 247 / 193 | 71.90% → 95.96% |
| `studio-client-observability-page` | 391 / 316 | 117 | 436 / 405 | 75.38% → 95.22% |
| `studio-client-observability-details` | 396 / 395 | 305 | 467 / 486 | 73.99% → 93.16% |
| `studio-client-observability-model` | 290 / 290 | 289 | 138 / 199 | 74.48% → 95.86% |
| `studio-client-scheduled-tasks` | 253 / 279 | 234 | 255 / 209 | 74.60% → 96.76% |
| `studio-client-workers` | 311 / 352 | 274 | 327 / 335 | 76.45% → 95.73% |
| `studio-client-workflow-catalog` | 166 / 193 | 143 | 243 / 328 | 76.97% → 96.35% |
| `studio-client-workflow-execution` | 314 / 358 | 297 | 474 / 516 | 65.61% → 95.25% |

### Atlas profiles

| Profile | Before / after mutants | Paired | Before / after seconds | Before / after score |
| --- | ---: | ---: | ---: | --- |
| `atlas-collection-query` | 162 / 162 | 162 | 111 / 75 | 96.30% → 96.30% |
| `atlas-server-catalog` | 162 / 162 | 162 | 289 / 71 | 77.78% → 93.21% |
| `atlas-server-catalog-relations` | 175 / 167 | 161 | 356 / 233 | 88.57% → 98.80% |
| `atlas-server-provider` | 271 / 260 | 249 | 368 / 352 | 81.92% → 95.00% |
| `atlas-resource-core` | 325 / 325 | 323 | 531 / 423 | 81.13% → 97.23% |
| `atlas-resource-validation` | 66 / 66 | 66 | 262 / 105 | 75.00% → 100.00% |
| `atlas-resource-relations` | 181 / 190 | 168 | 472 / 97 | 87.04% → 97.37% |
| `atlas-resource-fields` | 257 / 257 | 257 | 414 / 129 | 75.44% → 95.61% |
| `atlas-resource-schemas` | 195 / 178 | 165 | 384 / 90 | 75.00% → 95.51% |
| `atlas-server-source` | 130 / 134 | 117 | 248 / 212 | 82.31% → 96.27% |
| `atlas-server-collections` | 196 / 196 | 196 | 352 / 336 | 72.45% → 100.00% |
| `atlas-server-display` | 179 / 191 | 172 | 249 / 277 | 83.24% → 98.43% |
| `atlas-shared-contracts` | 66 / 58 | 41 | 225 / 41 | 50.79% → 96.36% |
| `atlas-shared-appearance` | 146 / 159 | 146 | 284 / 109 | 86.99% → 97.48% |
| `atlas-client-routing` | 200 / 207 | 189 | 428 / 160 | 74.50% → 98.07% |
| `atlas-client-session` | 313 / 313 | 313 | 391 / 236 | 78.27% → 96.17% |
| `atlas-client-gateway` | 188 / 303 | 177 | 127 / 80 | 94.68% → 99.01% |
| `atlas-client-display` | 185 / 189 | 174 | 365 / 228 | 87.03% → 95.77% |
| `atlas-client-feedback` | 162 / 162 | 162 | 326 / 115 | 68.52% → 87.50% |
| `atlas-client-history` | 168 / 168 | 164 | 101 / 77 | 77.38% → 90.48% |
| `atlas-client-relations` | 203 / 210 | 159 | 365 / 135 | 79.31% → 96.19% |
| `atlas-client-relation-helpers` | 93 / 94 | 78 | 182 / 110 | 81.72% → 96.81% |
| `atlas-client-relation-picker` | 270 / 267 | 259 | 244 / 213 | 72.96% → 74.53% |
| `atlas-page-collections` | 324 / 324 | 314 | 569 / 86 | 73.77% → 96.30% |
| `atlas-page-records` | 125 / 124 | 103 | 214 / 297 | 71.20% → 96.77% |
| `atlas-page-forms` | 240 / 259 | 168 | 311 / 206 | 79.08% → 93.02% |
| `atlas-page-table` | 200 / 204 | 166 | 439 / 89 | 68.50% → 91.67% |
| `atlas-page-controls` | 348 / 300 | 264 | 547 / 151 | 63.22% → 97.67% |

## Reproduced regressions

### Throttling

- Releasing unrelated capacity could wake waiters whose actual bottleneck was still full. A queue now tracks the saturated concurrency slot and waits for relevant capacity or its retry deadline.
- Closing a pressure reader could abort shutdown before other readers, quota reconciliation or the backend were closed. The manager attempts all owned cleanup and retains the failures.
- Registration could leave behind constraint or policy signatures after rejecting the policy. The manager validates the entire registration before committing it.
- Warm leases and cached denials could bypass checks for conflicting definitions or coordination. Requests now use canonical signatures and validate duplicate and invalid dimensions before mutating local quota. Small positive costs cannot spend an exhausted lease.
- Long PostgreSQL semaphore waits could overflow Node's timer range and wake after a millisecond. Bounded, abortable intervals retain the configured deadline.

The queue test releases a composite permit containing both the limiting slot and an unrelated slot. It asserts that the single-slot waiter advances, which detects changing `some` to `every` directly. The queue profile now has 23 Stryker timeouts and two assertion outcomes caused by a Vitest test deadline, compared with 22 and 36 respectively in the reference. These are distinct from ordinary assertion failures. The circuit profile has no timeouts.

Some survivors change private result shape before the acquisition event independently omits absent fields. A queue drains with a single wake controller and clears listeners on settlement, so several variants alter defensive cleanup or leave references until the queue leaves its map. Other survivors affect defensive transitions: a compiled policy rejects inconsistent concurrency capacities before a live state sees the conflicting definition, and pressure denials always carry signal IDs. Generation numbers are compared for identity, so reversing their increment preserves ordinary stale-generation rejection. The raw report keeps these outcomes and the remaining loss-of-progress cases.

The completion profile hit its 600-second limit twice. The final 206-second execution resumed the second same-source checkpoint, reused 411 outcomes and evaluated 117. The previous review also supplies the reports for the unchanged PostgreSQL lease, definition factory, definition validation, schema and public contract profiles. The selected sources or anchored ranges match the current code; these five executions are recorded as carried evidence.

### Studio

- A parameterized Studio mount could match routes other than the configured development path. Scheme-only external links could resolve relative to the Studio origin. A mount must now be literal, and a link must include an explicit HTTP authority.
- An inherited example property could break the action catalog, tuple actions received empty generated inputs, and a thrown value without ordinary string conversion could mask the action's failure. Example validation also rejects proxies whose reflective view differs from their serialized representation.
- An implicit route parameter could overwrite another controller editor field. A request path whose rendered prefix resembled an external authority could escape the intended local destination. Editor names and wire names are handled separately, and the client validates the rendered path.
- Database diagram label truncation could remove part of a Unicode character. The HTML and SVG diagrams now use the same code-point-aware truncation. The worker detail endpoint selects statistics for its own queue even when a custom adapter returns additional rows.
- Late catalog reads could replace the current action, controller or database view. Late polling reads could replace newer worker, scheduled-task, workflow or email state. Controls suppress duplicate submissions, and completed commands invalidate earlier reads. The email, log and observation lists discard pre-clear results so deleted rows cannot reappear. Failed email pagination keeps already loaded results visible.
- Stored observability context could supply inherited values for labels. Artifact panels whose execution IDs matched prototype properties could also render closed incorrectly. A transient polling failure could prevent subsequent interaction polling from recovering.
- Workflow controls returned generic server errors for expired execution links and recovery against an unsupported version. Studio now reports these cases with HTTP 404 and 409, respectively.

### Atlas

- Literal and percent-encoded dot segments and route metacharacters could be interpreted differently by Atlas, the router and Fastify. Mount and login paths validate the literal destination. Inherited renderer names use the intended fallback, and a missing record field whose name matches a prototype property displays as absent.
- Malformed JSON error responses could mask the underlying HTTP status, and media-type classification could miss supported JSON types or read a parameter as part of the type.
- A resource's read slot could accept a write-declared operation, and its CRUD write slot could accept a query. Output transforms could run again while resolving success effects, and invalid effects could leave a generator suspended.
- Browser mutations and sign-out could issue duplicate requests, and successful creation with a null response could leave the editor in a pending state. Native date-time controls now display and submit the expected representations.
- A shared query client could reuse records and relation labels across Atlas mounts. The cache keys now include the mount. A related-collection view resets paging and filters before fetching for a different parent, and selected relation labels use bounded batches.
- Relation hydration accepted unsolicited rows from a custom source. Only explicitly requested identities can contribute labels to a batch, and invalid batch sizes fail before any fetch. Numeric IDs keep their type in the editor. Collection filters and form bindings preserve invalid non-finite values for validation. Previously these values could become JSON null and unintentionally clear a nullable relation.
- Numeric record IDs were converted to text in gateway requests after navigation. Atlas now uses the receiving operation's numeric input contract when binding record routes, and inverse collection filters retain numeric parent identities. A record table could fail to render without `ResizeObserver`; it now renders and tracks scroll events in that environment. Embedding Atlas with changed renderer props now starts the correct router lifecycle. Invalid external record-link configuration now identifies the failing link and retains the original URL parser error as its cause.

## Remaining mutants

- Studio retains four historical ignores around Vite's literal `import.meta.glob` declaration. The final report still includes malformed static extension configurations as runtime errors. Other survivors cover typed router parameters, lifecycle dependencies of keyed views, defensive abort guards, presentation variants and unexercised combinations of operator interactions.
- Atlas includes variants in optional configuration, defensive schema handling, React cleanup and UI presentation. A history rendering assertion checks both the null and empty markers, leaving a variant that swaps the events they describe. The browser tests exercise interactions through the router and the simulated DOM. Atlas's server coverage also uses injected requests. The resource-validation baseline reported 54 errors during test collection. Its original 75% score had 12 eligible outcomes. Its final run scored all 66 outcomes.
- Throttling preserves the raw queue and circuit statuses, including detection by a mutant timeout. Test deadlines, runtime-invalid schema declarations and protocol-script limitations remain separate in the archived comparison.

The local archive is `artifacts/mutation/nov12-throttling-studio-atlas/`. It contains the source-scope fingerprint audits, profile execution records, baseline and final JSON reports, input hashes and status comparisons. The exact comparison pairs unchanged spans and keeps new, removed or changed mutation expressions separate. Shared test files continued to receive assertions between profile runs. The comparison records the related test snapshots that differ from the final checkout and reports the outcomes from each recorded execution.
