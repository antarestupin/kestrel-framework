# Workflow operations and replay mutation review

The operations profile covers the typed client, operator actions, deployment version checks and execution cursors. The replay profile covers the durable activation replayer and workflow context as well as the standalone runner and its memory journal. These profiles are part of the [framework mutation inventory](./mutation_testing_inventory.md). Each new execution uses the ten-minute budget, with static mutants retained.

| Profile | Baseline Killed / Survived / NoCoverage | Final Killed / Survived / NoCoverage | Final Stryker Timeout | Final Vitest deadlines | Final seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| `workflow-operations` | 279 / 125 / 89 | 450 / 51 / 1 | 0 | 0 | 169 |
| `workflow-replay` | 501 / 151 / 67 | 613 / 99 / 16 | 18 | 1 | 198 |

The [exact classifications](./mutation_testing_workflow_operations_replay_review.json) include source and report hashes, matched-site transitions, raw remaining variants and deadline detections. The fixes change the mutation corpus. Raw differences and matching-site changes are reported independently.

## Defects and regression tests

The operator `signal()` path accepted an empty deduplication key that the typed client already rejected. The test reproduced a stored signal with that key. Both entry points now reject the empty key before writing, and a nonempty key still deduplicates repeated delivery.

Replay could end an activation before an asynchronous codec finished encoding a side effect. Its staged capture still contained the initial null placeholder. A separate failing case showed an asynchronous Activity schema being mistaken for an unsupported handler suspension. The replayer now tracks framework-owned preparation and waits for it to settle before deciding whether a workflow is waiting. The tests control both encoder completion orders and a delayed decoder, and confirm that an arbitrary handler-owned promise still blocks. Parallel command preparation retains its previous completion ordering, which preserves replay of existing histories.

A capture callback that threw could send the live handler down its catch branch while the journal recorded a successful null capture. The reproduced history included the null completion followed by a timer from the catch branch. When replayed, that history delivered success and could no longer reconstruct the recorded fallback. Both adapters now persist the callback error as the completion, reusing the existing history error field. The memory regression finishes the fallback after replay and calls the producer only once. The PostgreSQL integration checks that the queued activation sees a completion error with no result. An uncaught encoding error retains the pre-commit failure behavior.

The operator tests also cover wait deadlines derived from timer, signal and Activity histories, failed and pending graph nodes, retry observations, exact cursor precision and the current and future deployment version boundaries. Replay tests cover typed errors from stored completions, cancellation after reconstructing parallel commands, removed-history detection, clock and UUID captures, retry and timeout normalization, child identity and concurrency, undeclared signal waits, and journal validation before appending commands. The combined Workers and Workflows test suites passed 875 tests across 48 files after isolating the qualified PostgreSQL test schema across parallel runs.

## Remaining evidence and limits

The operations residuals concern fallback metadata for malformed adapter replies, optional operator fields, diagnostic wording and representation within the cursor and history contracts. Its single uncovered variant removes the optional completion timestamp from a completed child node in the graph. The replay residuals include optional child and continuation metadata, exceptional custom history and scheduler-context seams, and diagnostics for native type or callback boundaries. Its uncovered variants include fallback fields for incomplete legacy error metadata, repeated continuation and direct low-level command validation. The Vitest deadline occurs when a mutation removes the deletion of a settled preparation from its tracking set. Bounded tests independently require delayed preparations to finish and publish their commands. Stryker timeouts come from promise and replay loops that fail to make progress when mutated, and their raw status is preserved separately.
