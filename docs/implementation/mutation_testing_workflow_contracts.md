# Workflow contract mutation review

The `workflow-contracts` profile selects the storage contract and adapter definition, concurrency, errors, history types and helpers, observations, serialization, signals, workflow definitions, replay fixture tooling, and the public barrel. It retains static mutants and limits each execution to ten minutes.

## Corrected behavior

- A configured keyed callback returning `undefined` silently skipped the keyed admission policy. The start now rejects an invalid key before creating an execution.
- The default JSON codec accepted sparse arrays and negative zero even though their in-memory representation differed from JSON storage. It now rejects array holes at the exact index and canonicalizes zero. It reads indexed values directly and diagnoses unsupported instances without invoking their overridden constructor property.
- A thrown value with a failing primitive conversion or error accessor could cause failure serialization itself to throw. Durable failure handling now retains a bounded generic message when it cannot inspect the original value.
- Replay fixture export could combine metadata from an earlier execution revision or history generation with later history. Export verifies both identities after reading history and rejects a concurrent change, including rotation back to revision zero.

Assertions exercise persisted error discriminators, timeout and cancellation details, diagnostic context, observation routing, signal definitions, terminal status, version limits, key policy defaults, fixture import/export, payload redaction, and replay compatibility with injected services. The export race fixtures advance a real memory journal through signal delivery or `continueAsNew` between reads.

## November 11 results

| Run | Mutants | Killed | Survived | No coverage | Timeout | Runtime error | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Before | 465 | 276 | 120 | 63 | 1 | 5 | 139s |
| First after | 493 | 473 | 12 | 2 | 1 | 5 | 156s |
| Final | 493 | 482 | 5 | 0 | 1 | 5 | 228s |

Of 410 unchanged mutation spans, 104 historical survivors and 60 previously uncovered variants now fail assertions. All 235 matching historical kills are preserved. Production changes and the shared command identity helper changed the mutation corpus. The first after run reported two Vitest deadline kills because terminal classification mutants could leave a result waiter pending indefinitely. The fixture now checks terminal classification before awaiting the result, and the final run records zero Vitest deadline kills.

| Final mutant IDs | Observed outcome and rationale |
| --- | --- |
| 131, 276, 451 | Three survivors change operator-facing text. Deployment diagnostics retain every incompatible definition and reason without the original separator. Invalid signal and workflow names retain the validation error with different wording. |
| 306 | The error constructor's own `cause` assignment still retains the original incompatibility cause if the `Error` options object is empty. |
| 352 | A cancellation event has no result or error. Sending it through the completed-command export branch yields the same timestamp and event fields for supported history records. |
| 221 | Removing the cycle guard makes payload encoding recurse until the explicit Stryker execution hit limit. Its status remains `Timeout`. |
| 437, 439, 443, 445, 447 | Five invalid Zod declarations fail during schema initialization or validation because the mutated discriminated union loses its discriminator or a required variant shape. They retain `RuntimeError`. |

The profile is reviewed under the current workflow contracts. Its raw JSON, HTML, source hashes, test hashes and unchanged-span comparison are in `artifacts/mutation/nov11-complete-review/workflow-contracts-before/` and `artifacts/mutation/nov11-complete-review/workflow-contracts-after-2/`. Run it with `npm run test:mutation:focus -- workflow-contracts`. See the [framework inventory](./mutation_testing_inventory.md) for the other workflow profiles.
