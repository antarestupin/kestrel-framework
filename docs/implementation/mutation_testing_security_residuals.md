# Security and HTTP mutation residual review

[Coverage inventory](./mutation_testing_inventory.md) · [Security and resilience reference](./mutation_testing_security_resilience.md) · [HTTP boundary reference](./mutation_testing_http_boundaries.md) · [Contributor commands](../contributing/mutation-testing.md)

This review follows the last complete static-inclusive assessment of `authentication`, `tokens`, `authorization`, `http`, `outbound_http`, `errors`, and `middleware`. It compares against the archived final reports from those two assessments. The source checkout for the follow-up starts at `f02fb9e`.

Each named execution retains static and hybrid mutants and has a ten-minute mutation budget. Fresh declaration profiles load the mutated module inside the corresponding tests, so a broken static declaration can fail an assertion run. For incremental executions, the seed excludes prior residual outcomes and Vitest deadline detections. Stryker checks the remaining assertion kills against the selected source and test identities. The baseline divides the earlier combined profiles by file for the new schema and HTTP declaration profiles. Those partitions preserve the baseline totals and do not double-count mutations. The local archive is `artifacts/mutation/security-residual-review/`.

## Defects reproduced and corrected

- HTTP binding inference mistook the second colon in Fastify's `::` escape for a path parameter, taking input from path parameters instead of the query or body. Generated clients also left the escape doubled in the actual request and could get a 404. The server and transport now respect literal colons.
- Creating a request execution scope could fail before the HTTP error boundary was installed, exposing the internal failure message and losing the response's correlation identifier. The manager now establishes correlation first and returns the opaque fallback for scope creation failures.
- A throwing HTTP or CLI representation method could replace the original error and escape the default transport handler. The fallback now reports the original failure and returns its ordinary safe representation.
- Memory and Redis token storage could revoke a freshly issued ordinary token in a batch that also replaced an earlier token for the same subject. Replacements now apply to the pre-batch state, matching PostgreSQL. Memory also keeps replacement definition and subject keys distinct when either contains the previous separator.
- The in-memory authentication adapter could overwrite an account or credential when its supplied ID factory returned a duplicate. It also retained mutable password-change dates supplied by callers. Duplicate generated IDs now reject before publication and stored audit dates are copied.
- A throwing application claims transform could escape while reading an existing session. Persisted claims that cannot be decoded now resolve as unauthenticated, like other invalid persisted claims.
- The sign-in throttling guard could switch username buckets when a caller mutated the bytes of its supplied HMAC secret. The guard now owns a copy of the key.
- Outbound HTTP inherited the original native `Request` signal even when the caller explicitly supplied `signal: null`. The override now detaches the inherited signal. Retry timers and protected-body reader cleanup now still observe abort if another listener stops event propagation.

## Results

Outcome columns report Killed / Survived / NoCoverage / Timeout / RuntimeError / CompileError / Ignored. Stryker counts timeouts as detections and excludes runtime errors from its score. The fixes changed some generated mutant sets, so the component scores compare complete partitions.

| Component | Profiles | Before outcomes | After outcomes | Score before → after | Vitest deadline kills before → after |
| --- | ---: | --- | --- | ---: | ---: |
| `authentication` | 6/6 | 1575 / 48 / 0 / 0 / 46 / 0 / 0 | 1634 / 41 / 0 / 0 / 2 / 0 / 0 | 97.04% → 97.55% | 4 → 0 |
| `tokens` | 4/4 | 1249 / 36 / 2 / 0 / 17 / 0 / 0 | 1260 / 31 / 0 / 0 / 0 / 0 / 0 | 97.05% → 97.60% | 0 → 0 |
| `authorization` | 2/2 | 236 / 4 / 0 / 0 / 9 / 0 / 0 | 245 / 4 / 0 / 0 / 0 / 0 / 0 | 98.33% → 98.39% | 0 → 0 |
| `http` | 6/6 | 1322 / 48 / 1 / 4 / 6 / 0 / 0 | 1348 / 47 / 1 / 0 / 0 / 0 / 0 | 96.44% → 96.56% | 4 → 0 |
| `outbound_http` | 3/3 | 1112 / 52 / 1 / 1 / 0 / 0 / 0 | 1091 / 30 / 1 / 1 / 0 / 0 / 0 | 95.45% → 97.24% | 35 → 0 |
| `errors` | 1/1 | 121 / 3 / 0 / 3 / 0 / 0 / 0 | 118 / 5 / 0 / 3 / 0 / 0 / 0 | 97.64% → 96.03% | 0 → 0 |
| `middleware` | 1/1 | 18 / 0 / 0 / 0 / 0 / 0 / 0 | 18 / 0 / 0 / 0 / 0 / 0 / 0 | 100.00% → 100.00% | 0 → 0 |

The final reports have 158 survivors, two uncovered defensive branches, two deterministic import errors and four detections at Stryker's instrumented hit limit. The `errors` score falls after adding the guarded representation call. Its two new survivors take the same opaque fallback as the unmutated code. The regression exercises a representation method that throws in both HTTP and CLI. No mutation exclusions were added.

### Per-profile executions

| Profile | Before outcomes | After outcomes | Final seconds |
| --- | --- | --- | ---: |
| `authentication-sessions` | 167 / 5 / 0 / 0 / 0 / 0 / 0 | 165 / 3 / 0 / 0 / 0 / 0 / 0 | 96 |
| `password-verification` | 214 / 7 / 0 / 0 / 0 / 0 / 0 | 214 / 7 / 0 / 0 / 0 / 0 / 0 | 28 |
| `authentication-adapters-postgres-schema` | 84 / 17 / 0 / 0 / 44 / 0 / 0 | 128 / 17 / 0 / 0 / 0 / 0 / 0 | 26 |
| `authentication-adapters-runtime` | 463 / 8 / 0 / 0 / 0 / 0 / 0 | 473 / 6 / 0 / 0 / 0 / 0 / 0 | 170 |
| `authentication-http` | 263 / 5 / 0 / 0 / 1 / 0 / 0 | 267 / 5 / 0 / 0 / 1 / 0 / 0 | 40 |
| `authentication-contracts` | 384 / 6 / 0 / 0 / 1 / 0 / 0 | 387 / 3 / 0 / 0 / 1 / 0 / 0 | 281 |
| `tokens-adapters` | 412 / 6 / 2 / 0 / 0 / 0 / 0 | 409 / 3 / 0 / 0 / 0 / 0 / 0 | 296 |
| `tokens-adapters-schema` | 33 / 9 / 0 / 0 / 17 / 0 / 0 | 50 / 9 / 0 / 0 / 0 / 0 / 0 | 171 |
| `tokens-strategies` | 412 / 13 / 0 / 0 / 0 / 0 / 0 | 412 / 13 / 0 / 0 / 0 / 0 / 0 | 323 |
| `tokens-contracts` | 392 / 8 / 0 / 0 / 0 / 0 / 0 | 389 / 6 / 0 / 0 / 0 / 0 / 0 | 53 |
| `authorization-runtime` | 221 / 3 / 0 / 0 / 0 / 0 / 0 | 221 / 3 / 0 / 0 / 0 / 0 / 0 | 33 |
| `authorization-postgres-schema` | 15 / 1 / 0 / 0 / 9 / 0 / 0 | 24 / 1 / 0 / 0 / 0 / 0 / 0 | 8 |
| `http-routing` | 174 / 8 / 0 / 0 / 0 / 0 / 0 | 173 / 7 / 0 / 0 / 0 / 0 / 0 | 226 |
| `http-access` | 258 / 4 / 0 / 4 / 0 / 0 / 0 | 266 / 5 / 0 / 0 / 0 / 0 / 0 | 41 |
| `http-access-policy` | 33 / 0 / 0 / 0 / 3 / 0 / 0 | 36 / 0 / 0 / 0 / 0 / 0 / 0 | 199 |
| `http-runtime` | 360 / 13 / 1 / 0 / 0 / 0 / 0 | 361 / 12 / 1 / 0 / 0 / 0 / 0 | 17 |
| `http-hardening-configuration` | 106 / 3 / 0 / 0 / 3 / 0 / 0 | 109 / 3 / 0 / 0 / 0 / 0 / 0 | 338 |
| `http-clients` | 391 / 20 / 0 / 0 / 0 / 0 / 0 | 403 / 20 / 0 / 0 / 0 / 0 / 0 | 32 |
| `outbound-resilience` | 316 / 16 / 1 / 1 / 0 / 0 / 0 | 292 / 5 / 1 / 1 / 0 / 0 / 0 | 12 |
| `outbound-client` | 426 / 18 / 0 / 0 / 0 / 0 / 0 | 429 / 13 / 0 / 0 / 0 / 0 / 0 | 11 |
| `outbound-contracts` | 370 / 18 / 0 / 0 / 0 / 0 / 0 | 370 / 12 / 0 / 0 / 0 / 0 / 0 | 16 |
| `component-errors` | 121 / 3 / 0 / 3 / 0 / 0 / 0 | 118 / 5 / 0 / 3 / 0 / 0 / 0 | 252 |
| `component-middleware` | 18 / 0 / 0 / 0 / 0 / 0 / 0 | 18 / 0 / 0 / 0 / 0 / 0 / 0 | 75 |

## Residual classifications

### Authentication

| Profile and final mutant IDs | Disposition |
| --- | --- |
| `authentication-adapters-postgres-schema` 7, 10, 15, 19, 41, 47, 52, 56, 60, 81, 87, 93, 97, 101, 105, 109, 113 | Empty SQL names are inferred from the unchanged property names, and empty timestamp modes still select Drizzle's default Date builder. Schema, migration metadata and adapter integration assertions verify the observable contract. All 44 previous static import errors are now attributed to the schema test body via dynamic imports. |
| `authentication-sessions` 68 | Accessing the combined account without optional chaining is equivalent: an absent combined resolution has already returned through the missing-session check when using the combined resolver. |
| `authentication-sessions` 99, 146 | An empty catch and an explicit undefined return are identical for claims parsing. An empty catch in canonical token validation instead returns undefined, which the sole caller rejects with the same `!isCanonicalToken` check. The exception paths are exercised with a throwing claims transform and non-string token. |
| `authentication-adapters-runtime` 66, 89, 154 | A missed subject, digest or username index returns an undefined ID. Maps storing string IDs cannot contain that key, so continuing into their guarded lookup still returns undefined. The tests cover positive and negative reads. |
| `authentication-adapters-runtime` 221, 226 | Only inserted records or values read through an internally consistent ID index reach the clone helpers. The optional guards are defensive when the index cannot point to a deleted record through the adapter. |
| `authentication-adapters-runtime` 251 | An omitted account state and an explicitly undefined state both invoke the same application table default in Drizzle INSERT. Explicit account state and custom triggers are exercised. |
| `authentication-contracts` 53, 57 | Explicit undefined client metadata and omitted client metadata follow the same manager allowlist and leave the stored session fields absent. |
| `authentication-contracts` 183 | The pending and anonymous context variants have no principal field. Unconditional field access returns the same undefined. |
| `authentication-contracts` 0 | Dropping the sign-in schema's shape makes its `.omit({ metadata: true })` declaration invalid during import. The standalone schema assertion and HTTP tests check that credentials are validated and payload metadata cannot leak into sessions. The static mutation is rejected by Zod before related Vitest suites can collect. |
| `authentication-http` 41, 45 | An explicitly undefined burst is normalized by `defineRateLimit`; concrete burst values are exercised through the guard. `Buffer.byteLength` also accepts `Uint8Array` and returns its byte length, so the changed overload has the same result for either supported secret type. |
| `authentication-http` 93 | The action and manager independently omit undefined user-agent metadata. The integration tests assert omission when the transport did not provide an agent and preservation when it did. |
| `authentication-http` 133, 253 | An explicit undefined and an implicit undefined from an empty catch have the same result. The malformed encoded cookie and invalid URL assertions exercise both paths. |
| `authentication-http` 270 | The shared definition validator rejects the static empty name at import time. Integration checks exercise both authenticated and anonymous Action invocation. |
| `password-verification` 0 | The dummy input is an internal, deliberately unprivileged timing fixture. Its derivation parameters and one-time caching matter, rather than the input literal. |
| `password-verification` 40, 80 | Native derivation receives the configured `tagLength` and returns exactly that many bytes or errors. An incompatible tag is already rejected in the controlled native response test. Explicit `secret: undefined` behaves like an omitted native optional secret. |
| `password-verification` 177, 178, 179, 180 | The regex produces only unsigned decimal fields. Non-integer and zero values introduced by bypassing the preliminary predicate still fail the independent validation before native work. The encoded length, separate upper bounds and actual native resource contract remain covered. |

### Tokens

- Drizzle infers the same SQL name when the explicit identifier is empty for `id`, `definition`, `subject`, `digest`, and `payload`. Empty timestamp mode strings keep the Date builder because only the exact string mode selects the alternative. The schema tests already assert physical names, indexes, PostgreSQL types and Date decoding.
- A PostgreSQL replacement group containing the mutation's inserted string derives absent definition and subject values. The extra SQL disjunct cannot match a valid row. An undefined Drizzle field projection selects the full table; the public result uses the same projected columns. The ORM also reads the unused subject-exclusivity and revoked-date columns.
- Redis omits undefined values from serialized JSON, so explicitly setting an absent subject index to undefined writes the same command argument.
- The TokenManager's empty JSON and resolution catch variants implicitly return undefined or reach the same explicit JSON validation error. A stored token decoded from an empty string has zero bytes, below the configured minimum, so the length branch independently rejects it. Passing an explicit undefined subject to the storage recipe yields the same persisted state in all built-in adapters.
- TokenProvider invokes `createStrategies()` without a store only when both the default stored strategy and stateful factories are disabled. Creating an empty map of factories preserves the signed-only result; the stored branch is still guarded by `stored: false`.
- JWT key lookup accepts only an exact registered identity and algorithm. When either coordinate is absent, the subsequent Map lookup or algorithm equality already prevents a result. The codec's explicit rejection when key resolution returns undefined fails closed even without the guard because the later property access throws into its catch.
- JOSE enforces the same future limit for `nbf`, and Kestrel already requires `iat === nbf`. `Number.isSafeInteger` rejects every non-number without coercion. The codec's empty catch returns undefined implicitly. Its explicit subjectless branch equals comparing the absent subject directly, and optional metadata explicitly set to undefined is private to the codec and read the same way by both strategies.

### Authorization

The memory store's empty-set cleanup variants retain an empty assignment after the final role is revoked. Reads return a detached empty set, and the next grant and revoke behave the same. In the PostgreSQL store, an omitted actor field and a field set to `undefined` generate identical SQL in Drizzle. The default timestamp mode is Date, including when the mode string is empty. The schema test checks columns, migration metadata and indexes inside the test boundary.

### HTTP

- Controller declarations omit optional fields when their values are absent. The variants insert the same absent values into private objects. The only explicit parameter token in a supported affixed route has a populated capture. A whole-segment named binding and its regular-expression path give the same value when the name matches both, while explicit names outside the inferred identifier syntax retain the whole-segment path.
- The executor's standalone arm already requires a handler; the Action-output shortcut requires an Action output schema equal to the controller output and no controller handler. An empty object passed to the default error handler selects its ordinary opaque representation. A completion observation on an absent observer can throw inside the surrounding protected cleanup after the response has been sent, with no difference in response or disposal. Request-response tests check the scope creation fallback and preserve the controller's already-sent response.
- Client generation retains the same optional options, code tokens, and runtime behavior when indentation or whitespace alone changes. The native filesystem returns Error objects with a code for failures relevant to the missing-file check. Adding an explicit undefined fetch body, using `JSON.stringify(null)` in place of `String(null)`, and substituting a different unrecognized fallback content type preserve the actual request or response behavior.
- HTTP hardening still rejects a second CIDR slash through numeric-prefix validation. Decimal digit validation already rules out negative prefixes. The explicit Helmet configurations for same-origin opener/resource policy and no-referrer agree with the pinned defaults. A malformed authority still fails closed. Tests check the known security response and timeout values.
- A supported Fastify request carries its raw URL. The missing-URL fallback remains a defensive condition. HTTP maintenance falls back to JSON for absent media types, treats bare JSON with or without an explicit UTF-8 header the same for ordinary payloads, and strips outer spaces before parsing. An equal positive HTML preference cannot tie an explicit JSON quality of zero. Runtime stop already begins shutdown through its shared wait operation, and Fastify uses silent logging when no logger is supplied.

### Errors and middleware

An absent stack adds no visible stack field to HTTP or CLI output. Invoking an absent method inside the protected call would throw and reach the same fallback. An empty catch implicitly returns undefined. The representation's null precheck avoids a failing property operation which the same catch already contains. Returning undefined explicitly or falling through that catch has the same result. Cycle traversal variants that remove progress or its visited guard are checked by the mutation hit limit. All 18 middleware mutations remain detected. Stryker revalidated the reference assertion kills during its incremental assessment.

### Outbound HTTP

Three regressions were reproduced before their fixes. The native low-level `fetch()` inherited an input Request's abort signal when `RequestInit.signal` was explicitly null. It now distinguishes null from omission. Retry backoff and a guarded response body could miss an abort when an earlier listener stopped event propagation. Retry now uses the shared abort-safe bounded delay and guarded readers use Node's abort subscription, keeping resource cleanup active. A separate regression confirms that an aborted coalesced cache waiter does not make a fresh attempt when its load owner returns an unshareable response. Body ownership now uses the active registry to dispose each reader once. Tests assert asynchronous settlement after a simulated deadline or in-memory event-loop turn. Stable middleware sorting uses the platform's stable array sort.

The retry contract retains a defensive fallback after the loop. The configured attempt count is validated as a positive integer. On the final iteration every path returns the response or throws, so the fallback cannot be reached through valid input. The decrementing counter mutation prevents the retry loop from reaching the final attempt and hits Stryker's instrumented execution limit.

| Profile and report IDs | Disposition |
| --- | --- |
| `outbound-resilience` 20 | The body truncation accessor normalizes undefined and false to false. The positive state is set when an oversized error chunk is truncated. |
| `outbound-resilience` 35, 40, 53 | Native stream cancellation happens once and completion releases the reader. A suspended pull may resume after its reader was cancelled. The native stream already rejects enqueues or closes on a terminal controller, and the shared cancellation guard prevents a second disposal. |
| `outbound-resilience` 136 | The error classifier is only invoked after cancellation, when the native signal has a reason. An absent timeout error cannot match that reason. |
| `outbound-resilience` 202, 227 | Decrementing the retry attempt loses progress and reaches the mutation hit limit. The fallback diagnostic is outside the validated attempt loop. |
| `outbound-contracts` 18 | The private cache ownership error is intercepted by type and owner, then unwrapped to the real result or error. Its message is internal. |
| `outbound-contracts` 27, 31 | Passing an absent fixed cache method or priority as undefined selects the same default. The policy tests check explicit overrides and the exact options a backend receives. |
| `outbound-contracts` 249, 298 | Constructing a Date from an absent retry instant fails the following invalid-date check. A missing or blank header fails the following decimal and HTTP-date checks. |
| `outbound-contracts` 350, 358, 359 | An absent optional observer registration throws inside the protected resolution boundary. An ambient instrumentation object is constructed only after obtaining a context. An absent active observer would throw inside the protected recording boundary and the explicit sink still runs. |
| `outbound-contracts` 369, 375, 380, 383 | Absent timeout and instrumentation values passed explicitly produce the same defaults. When one sink exists, a combined wrapper would catch an absent sink and record to the same active destination. The no-sink path is verified without invoking the measurement clock. |
| `outbound-client` 108, 110 | Structured templates reject schemes, authority syntax, backslashes and ASCII control characters, and percent-encode interpolated segments. A relative structured URL requires a base before this origin check. The origin guard is retained as defense in depth. |
| `outbound-client` 130, 134, 138 | Adding explicitly undefined body, middleware and timeout fields selects the same defaults. |
| `outbound-client` 171, 172 | The deadline runner checks before fetch, and the middleware runner links replacement request signals before reaching transport. The defensive transport checks can repeat those guarantees. |
| `outbound-client` 205 | For supported URL and string inputs, constructing a URL with an explicitly undefined base agrees with one-argument construction. |
| `outbound-client` 216, 219, 376 | An empty catch and an explicit undefined return both result in no clock sample. Absent instrumentation cannot escape its catch. Constructing Headers with undefined produces an empty set. |
| `outbound-client` 225, 239 | On logical cancellation the deadline or linked request signal provides the same typed abort failure. Returning an already normalized typed failure also keeps the failure and its cause. |

## Residual report index

Paths are relative to `src/packages/kestrel/src`. Mutant IDs are local to each final profile report.

### `authentication`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `authentication-sessions` | `authentication/manager.ts:172` | Survived | 68 |
| `authentication-sessions` | `authentication/manager.ts:221` | Survived | 99 |
| `authentication-sessions` | `authentication/manager.ts:298` | Survived | 146 |
| `password-verification` | `authentication/mechanisms/password/hashers/argon2id/hasher.ts:48` | Survived | 0 |
| `password-verification` | `authentication/mechanisms/password/hashers/argon2id/hasher.ts:121` | Survived | 40 |
| `password-verification` | `authentication/mechanisms/password/hashers/argon2id/hasher.ts:160` | Survived | 80 |
| `password-verification` | `authentication/mechanisms/password/hashers/argon2id/hasher.ts:269` | Survived | 177, 178, 179, 180 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:35` | Survived | 7 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:38` | Survived | 10 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:40` | Survived | 15 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:43` | Survived | 19 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:78` | Survived | 41 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:82` | Survived | 47 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:86` | Survived | 52 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:89` | Survived | 56 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:92` | Survived | 60 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:123` | Survived | 81 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:128` | Survived | 87 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:133` | Survived | 93 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:136` | Survived | 97 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:138` | Survived | 101 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:141` | Survived | 105 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:145` | Survived | 109 |
| `authentication-adapters-postgres-schema` | `authentication/adapters/postgres/schema.ts:148` | Survived | 113 |
| `authentication-adapters-runtime` | `authentication/adapters/memory/adapter.ts:58` | Survived | 66 |
| `authentication-adapters-runtime` | `authentication/adapters/memory/adapter.ts:126` | Survived | 89 |
| `authentication-adapters-runtime` | `authentication/adapters/memory/adapter.ts:208` | Survived | 154 |
| `authentication-adapters-runtime` | `authentication/adapters/memory/adapter.ts:325` | Survived | 221 |
| `authentication-adapters-runtime` | `authentication/adapters/memory/adapter.ts:338` | Survived | 226 |
| `authentication-adapters-runtime` | `authentication/adapters/postgres/adapter.ts:69` | Survived | 251 |
| `authentication-http` | `authentication/guards/throttling.ts:120` | Survived | 41 |
| `authentication-http` | `authentication/guards/throttling.ts:125` | Survived | 45 |
| `authentication-http` | `authentication/http/controllers.ts:119` | Survived | 93 |
| `authentication-http` | `authentication/http/cookie.ts:24` | Survived | 133 |
| `authentication-http` | `authentication/http/middleware.ts:132` | Survived | 253 |
| `authentication-http` | `authentication/middleware.ts:8` | RuntimeError | 270 |
| `authentication-contracts` | `authentication/actions.ts:16` | RuntimeError | 0 |
| `authentication-contracts` | `authentication/actions.ts:94` | Survived | 53 |
| `authentication-contracts` | `authentication/actions.ts:97` | Survived | 57 |
| `authentication-contracts` | `authentication/context.ts:33` | Survived | 183 |

### `tokens`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `tokens-adapters` | `tokens/adapters/postgres/adapter.ts:182` | Survived | 252 |
| `tokens-adapters` | `tokens/adapters/postgres/adapter.ts:189` | Survived | 255 |
| `tokens-adapters` | `tokens/adapters/redis/adapter.ts:51` | Survived | 342 |
| `tokens-adapters-schema` | `tokens/adapters/postgres/schema.ts:50` | Survived | 11 |
| `tokens-adapters-schema` | `tokens/adapters/postgres/schema.ts:51` | Survived | 12 |
| `tokens-adapters-schema` | `tokens/adapters/postgres/schema.ts:52` | Survived | 13 |
| `tokens-adapters-schema` | `tokens/adapters/postgres/schema.ts:54` | Survived | 16 |
| `tokens-adapters-schema` | `tokens/adapters/postgres/schema.ts:55` | Survived | 17 |
| `tokens-adapters-schema` | `tokens/adapters/postgres/schema.ts:57` | Survived | 20 |
| `tokens-adapters-schema` | `tokens/adapters/postgres/schema.ts:61` | Survived | 24 |
| `tokens-adapters-schema` | `tokens/adapters/postgres/schema.ts:65` | Survived | 28 |
| `tokens-adapters-schema` | `tokens/adapters/postgres/schema.ts:69` | Survived | 32 |
| `tokens-strategies` | `tokens/strategies/jwt/codec.ts:160` | Survived | 149 |
| `tokens-strategies` | `tokens/strategies/jwt/codec.ts:170` | Survived | 156 |
| `tokens-strategies` | `tokens/strategies/jwt/codec.ts:178` | Survived | 164 |
| `tokens-strategies` | `tokens/strategies/jwt/codec.ts:216` | Survived | 187 |
| `tokens-strategies` | `tokens/strategies/jwt/codec.ts:220` | Survived | 190 |
| `tokens-strategies` | `tokens/strategies/jwt/codec.ts:233` | Survived | 211 |
| `tokens-strategies` | `tokens/strategies/jwt/codec.ts:240` | Survived | 225 |
| `tokens-strategies` | `tokens/strategies/jwt/codec.ts:270` | Survived | 252 |
| `tokens-strategies` | `tokens/strategies/jwt/codec.ts:274` | Survived | 268 |
| `tokens-strategies` | `tokens/strategies/jwt/keyring.ts:93` | Survived | 378, 379, 380, 382 |
| `tokens-contracts` | `tokens/manager.ts:191` | Survived | 188 |
| `tokens-contracts` | `tokens/manager.ts:221` | Survived | 206 |
| `tokens-contracts` | `tokens/provider.ts:60` | Survived | 320 |
| `tokens-contracts` | `tokens/provider.ts:70` | Survived | 329 |
| `tokens-contracts` | `tokens/stored_strategy.ts:81` | Survived | 373 |
| `tokens-contracts` | `tokens/stored_strategy.ts:175` | Survived | 411 |

### `authorization`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `authorization-runtime` | `authorization/adapters/memory/store.ts:27` | Survived | 15, 18 |
| `authorization-runtime` | `authorization/adapters/postgres/store.ts:34` | Survived | 29 |
| `authorization-postgres-schema` | `authorization/adapters/postgres/schema.ts:28` | Survived | 8 |

### `http`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `http-routing` | `http/bindings.ts:72` | Survived | 28 |
| `http-routing` | `http/controller.ts:288` | Survived | 58 |
| `http-routing` | `http/controller.ts:299` | Survived | 66 |
| `http-routing` | `http/controller.ts:302` | Survived | 70 |
| `http-routing` | `http/controller.ts:368` | Survived | 96 |
| `http-routing` | `http/controller.ts:376` | Survived | 104 |
| `http-routing` | `http/controller.ts:383` | Survived | 114 |
| `http-access` | `http/controller_executor.ts:65` | Survived | 114, 116 |
| `http-access` | `http/controller_executor.ts:133` | Survived | 137 |
| `http-access` | `http/controller_manager.ts:54` | Survived | 144 |
| `http-access` | `http/controller_manager.ts:256` | Survived | 215 |
| `http-runtime` | `http/hardening/profile.ts:55` | Survived | 59 |
| `http-runtime` | `http/hardening/profile.ts:56` | Survived | 61 |
| `http-runtime` | `http/hardening/profile.ts:62` | Survived | 64 |
| `http-runtime` | `http/hardening/profile.ts:155` | Survived | 131 |
| `http-runtime` | `http/maintenance/policy.ts:45` | NoCoverage | 187 |
| `http-runtime` | `http/maintenance/policy.ts:45` | Survived | 185 |
| `http-runtime` | `http/maintenance/policy.ts:75` | Survived | 250 |
| `http-runtime` | `http/maintenance/policy.ts:76` | Survived | 253 |
| `http-runtime` | `http/maintenance/policy.ts:80` | Survived | 265 |
| `http-runtime` | `http/maintenance/policy.ts:83` | Survived | 274 |
| `http-runtime` | `http/maintenance/policy.ts:100` | Survived | 313 |
| `http-runtime` | `http/runtime.ts:68` | Survived | 356 |
| `http-runtime` | `http/runtime.ts:109` | Survived | 373 |
| `http-hardening-configuration` | `http/hardening/configuration.ts:114` | Survived | 82, 85 |
| `http-hardening-configuration` | `http/hardening/configuration.ts:127` | Survived | 108 |
| `http-clients` | `http/client.ts:89` | Survived | 29 |
| `http-clients` | `http/client.ts:175` | Survived | 115, 118 |
| `http-clients` | `http/client.ts:181` | Survived | 120 |
| `http-clients` | `http/client.ts:182` | Survived | 126 |
| `http-clients` | `http/client.ts:230` | Survived | 181 |
| `http-clients` | `http/client.ts:252` | Survived | 202 |
| `http-clients` | `http/client_generation/generator.ts:79` | Survived | 265 |
| `http-clients` | `http/client_generation/generator.ts:80` | Survived | 266 |
| `http-clients` | `http/client_generation/generator.ts:140` | Survived | 284 |
| `http-clients` | `http/client_generation/generator.ts:165` | Survived | 293 |
| `http-clients` | `http/client_generation/generator.ts:166` | Survived | 294, 295 |
| `http-clients` | `http/client_generation/generator.ts:226` | Survived | 329 |
| `http-clients` | `http/client_generation/generator.ts:227` | Survived | 330, 331 |
| `http-clients` | `http/client_generation/generator.ts:228` | Survived | 332 |
| `http-clients` | `http/client_generation/generator.ts:285` | Survived | 385, 386 |
| `http-clients` | `http/client_generation/provider.ts:107` | Survived | 422 |

### `outbound_http`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `outbound-resilience` | `outbound_http/body.ts:36` | Survived | 20 |
| `outbound-resilience` | `outbound_http/body.ts:51` | Survived | 35 |
| `outbound-resilience` | `outbound_http/body.ts:57` | Survived | 40 |
| `outbound-resilience` | `outbound_http/body.ts:68` | Survived | 53 |
| `outbound-resilience` | `outbound_http/deadline.ts:38` | Survived | 136 |
| `outbound-resilience` | `outbound_http/middleware/retry/index.ts:48` | Timeout | 202 |
| `outbound-resilience` | `outbound_http/middleware/retry/index.ts:80` | NoCoverage | 227 |
| `outbound-client` | `outbound_http/client.ts:229` | Survived | 108, 110 |
| `outbound-client` | `outbound_http/client.ts:251` | Survived | 130 |
| `outbound-client` | `outbound_http/client.ts:254` | Survived | 134 |
| `outbound-client` | `outbound_http/client.ts:255` | Survived | 138 |
| `outbound-client` | `outbound_http/client.ts:337` | Survived | 171 |
| `outbound-client` | `outbound_http/client.ts:339` | Survived | 172 |
| `outbound-client` | `outbound_http/client.ts:411` | Survived | 205 |
| `outbound-client` | `outbound_http/client.ts:427` | Survived | 216 |
| `outbound-client` | `outbound_http/client.ts:434` | Survived | 219 |
| `outbound-client` | `outbound_http/client.ts:463` | Survived | 225 |
| `outbound-client` | `outbound_http/client.ts:483` | Survived | 239 |
| `outbound-client` | `outbound_http/client.ts:597` | Survived | 376 |
| `outbound-contracts` | `outbound_http/middleware.ts:81` | Survived | 298 |
| `outbound-contracts` | `outbound_http/middleware/cache/index.ts:64` | Survived | 18 |
| `outbound-contracts` | `outbound_http/middleware/cache/index.ts:87` | Survived | 27 |
| `outbound-contracts` | `outbound_http/middleware/cache/index.ts:88` | Survived | 31 |
| `outbound-contracts` | `outbound_http/middleware/throttling/index.ts:96` | Survived | 249 |
| `outbound-contracts` | `outbound_http/provider.ts:39` | Survived | 350 |
| `outbound-contracts` | `outbound_http/provider.ts:50` | Survived | 358 |
| `outbound-contracts` | `outbound_http/provider.ts:52` | Survived | 359 |
| `outbound-contracts` | `outbound_http/provider.ts:69` | Survived | 369 |
| `outbound-contracts` | `outbound_http/provider.ts:72` | Survived | 375 |
| `outbound-contracts` | `outbound_http/provider.ts:83` | Survived | 380 |
| `outbound-contracts` | `outbound_http/provider.ts:84` | Survived | 383 |

### `errors`

| Profile | Source line | Outcome | Mutant IDs |
| --- | --- | --- | --- |
| `component-errors` | `errors/error_handler.ts:141` | Survived | 48 |
| `component-errors` | `errors/error_handler.ts:144` | Survived | 52 |
| `component-errors` | `errors/error_handler.ts:161` | Survived | 62 |
| `component-errors` | `errors/error_handler.ts:172` | Timeout | 69, 71 |
| `component-errors` | `errors/error_handler.ts:174` | Timeout | 73 |
| `component-errors` | `errors/representations.ts:56` | Survived | 117 |
| `component-errors` | `errors/representations.ts:62` | Survived | 127 |

### `middleware`

Every mutant was killed by an assertion.
