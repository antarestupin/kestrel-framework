# Mutation review of HTTP and authorization boundaries

[Coverage inventory](./mutation_testing_inventory.md) · [Contributor commands](../contributing/mutation-testing.md)

The November 12, 2026 assessment covers the 58 eligible sources in `http`, `authorization`, `errors` and `middleware`. Four disjoint profiles cover HTTP. Each other component has one profile. The starting revision is `32df64e5895f21be9a56efb3e81921d0fe15d90d`. Each run retained static and hybrid mutants, forced fresh execution, and had a ten-minute budget. The score remains informational.

The local archive under `artifacts/mutation/nov12-http-boundaries/` contains the before and after reports, scope audits, and comparison. Mutants are paired by file, unchanged source span, operator and replacement. The comparison keeps unmatched mutations separate where a source change makes pairing ambiguous. A Stryker execution limit, a Vitest deadline, and a test assertion are different forms of evidence.

## Results

The completed runs compare 1,553 matched mutants, out of 1,697 baseline and 1,775 final mutants. The final set includes 356 static or hybrid mutants. The longest completed run took 208 seconds.

Among matched mutations, 227 prior survivors, 17 previously uncovered mutants, and four previous Stryker timeouts are killed in the final reports. Every matched previous kill stays killed. One now first fails by a Vitest deadline. Stryker scores include execution timeouts as detections and exclude runtime errors.

| Component | Paired mutants | Before K / S / NC / T / RE | After K / S / NC / T / RE | Stryker score |
| --- | ---: | --- | --- | --- |
| `http` | 1236 | 1062 / 254 / 9 / 11 / 6 | 1322 / 48 / 1 / 4 / 6 | 80.31% → 96.44% |
| `authorization` | 212 | 172 / 38 / 9 / 0 / 9 | 236 / 4 / 0 / 0 / 9 | 78.54% → 98.33% |
| `errors` | 87 | 95 / 11 / 0 / 3 / 0 | 121 / 3 / 0 / 3 / 0 | 89.91% → 97.64% |
| `middleware` | 18 | 18 / 0 / 0 / 0 / 0 | 18 / 0 / 0 / 0 / 0 | 100.00% → 100.00% |

## Profile executions

| Profile | Before mutants | After mutants | Paired | Before seconds | After seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| `http-routing` | 182 | 182 | 182 | 105 | 175 |
| `http-access` | 291 | 302 | 238 | 194 | 182 |
| `http-runtime` | 508 | 486 | 479 | 208 | 153 |
| `http-clients` | 361 | 411 | 337 | 58 | 119 |
| `component-authorization` | 228 | 249 | 212 | 77 | 138 |
| `component-errors` | 109 | 127 | 87 | 55 | 96 |
| `component-middleware` | 18 | 18 | 18 | 28 | 48 |

The input manifest and report hashes are in the local archive. Some related test suites were selected in profiles that ran before the final HTTP runtime and maintenance test assertions landed. The archived comparisons identify those snapshots by file. All final mutant reports contain the current production source for their selected files.

The full suite passed 3,881 tests in 333 files. All 103 mutation infrastructure tests, the framework typecheck, and the framework and playground builds passed.

## Authorization

Two regressions were reproduced on the starting implementation. Directly supplied requirement objects could permit an empty or sparse conjunction, or interpret an unrecognized requirement kind as a disjunction. Evaluation now denies those forms while preserving the valid groups' short-circuit behavior. Role-permission composition could silently bypass a child store's initialization hook. It now rejects a recipe with such a hook before construction, matching the synchronous execution-scoped adapter contract.

Tests also exercise exact PostgreSQL grant and revoke results, subject and stale-role isolation, migration metadata, independent scoped resolver lifecycles, identifier boundaries, and opaque HTTP denial. Of the 212 paired mutants, 34 prior survivors and nine previously uncovered mutants are killed. No final mutation remains uncovered. Two memory-store survivors affect retention of empty assignment sets only. An omitted PostgreSQL actor field and an explicit undefined value generate the same SQL. An empty timestamp mode still selects Drizzle's date builder. The nine runtime errors come from invalid schema mutations at load time.

## Errors and middleware

A thrown value with a throwing representation getter could mask the original failure before the default handler produced its opaque HTTP or CLI result. The handler now catches failures during representation lookup and reads a valid method once. It calls that method with the original receiver and context. Tests exercise both representations, debug formatting for falsy aggregate causes, and opaque reporting of non-representable values. A tests-only run killed ten former survivors at identical production source.

The remaining error-handler survivors affect an omitted private stack field, an explicit null precheck whose failure is handled by the same guarded lookup, and an empty catch that implicitly returns undefined. Three mutations of diagnostic traversal reach Stryker's execution-hit limit. The tests exercise the original traversal with shared and cyclic errors.

All middleware mutations were detected on the first run. Additional tests assert that a failing middleware skips dependency resolution and execution downstream, and that an unwind failure preserves its identity after the terminal operation succeeds. These tests cover public pipeline contracts.

## HTTP

The Host allowlist previously parsed the incoming authority using HTTP rules even though the public origins use HTTPS. This could admit an unconfigured port 80 and reject an explicit default port 443. URL normalization also hid path and delimiter characters in malformed Host values. The runtime validates the authority shape before applying HTTPS port normalization. Injection tests check direct requests and trusted proxy forwarding.

If request observation setup or completion recording threw, a managed HTTP request could leave its execution scope open. Start failures could also reach Fastify's generic handler with the internal message. The manager now keeps disposal in the execution's observation context, uses the configured error policy for setup failures, and preserves a response that has already been sent. It installs the correlation header before scoped setup. A separate regression asserts an error diagnostic for a rejected request with an undefined rejection reason.

The generated client can now bind a parameter with a literal prefix or suffix in its segment, while preserving existing query text. A Fastify injection test verifies the actual route parameters for a value that also contains the suffix. The client rejects patterns with multiple parameters in a single segment or regular-expression constraints before fetching. Fastify can decode percent-encoded delimiters before splitting adjacent parameters, which makes unrestricted interpolation ambiguous.

The generator checks normalized output paths before launching writes. Two differently spelled paths could previously identify the same output and bypass the duplicate check. It also escapes comment terminators in metadata inserted into generated JSDoc, keeping the operation identifiers and catalog keys intact in the generated program. The CLI test runs the real generator twice and checks both generated and unchanged output statuses. Other tests exercise argument forwarding, syntax of multi-operation clients, exact request options, empty responses and structured JSON error media types.

At constant HTTP client source, the added tests kill 37 former survivors and one previously uncovered mutant. Remaining client-profile differences concern equivalent fetch options and JSON null serialization, fallback parsing for non-JSON responses, formatting of valid TypeScript, the native file-error contract, and optional catalog metadata. The standalone transport keeps its fast path for whole-segment explicit bindings, including names outside the inferred identifier syntax.

### Residual HTTP evidence

- Routing survivors affect omitted optional properties, an equivalent validation branch, and a capture guaranteed by the named-parameter expression. Tests exercise the explicit Fastify options, status boundary, description and body binding.
- Access survivors affect dispatch of a typed standalone handler with an unused extra field, a redundant action-output condition, and observer behavior after a response is sent. The scope still disposes in the observer case. Four mutations remove whole response or lifecycle blocks and time out. Three mutations cause invalid static default-policy setup.
- The sole uncovered mutant changes the maintenance fallback for a request with no raw URL. Fastify injection supplies a raw URL on each managed request. Other runtime survivors concern equivalent media negotiation fallbacks, redundant CIDR checks, default Helmet options, silent logging and redundant shutdown initiation. The three runtime errors come from invalid proxy schema mutations at import.
- Four HTTP kills still first report Vitest deadlines. These are recorded separately from ordinary assertion failures in the comparison.
