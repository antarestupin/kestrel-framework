# Workflow runtime profile review

The `workflow-runtime` profile covers the Workflow provider, runtime, public dependency registrations, and activity completion buffer. Every run retains static mutants and has a ten-minute limit. See the [runtime and transport review](./mutation_testing_workflow_runtime_review.md) for the related scheduler and transport work.

## Additional findings

- A custom workflow codec reached the scheduler, client and operator API while both activity paths still used the default codec. An Action requiring numeric input could reject a stored string before entering its handler. An Action output could also use a different representation from the rest of the journal. The runtime now passes the configured codec to the embedded Action transport and the provider passes it to the Worker activity definition. The regression executes the Action through the composed application and checks its persisted result and decoded workflow output.
- A workflow storage operation could reject with `undefined` and leave the failed scope's completion observation without an error diagnostic. Completion now derives the presence of a failure from the scoped outcome and records its original value separately. Assertions cover both ordinary Error values and an undefined rejection.

The tests inspect the registered standalone CLI and invoke its handler through an application execution scope. They also verify Worker catalog identity, dispatch configuration, the actual correlation router and dependency descriptor, and instrumentation across client start, runtime task processing and operator retry. Polling tests exercise application-owned drain, standalone process-signal supervision, sibling cancellation before explicit stop, independent terminal scheduler failure, and both sources of dispatcher recoverability with a bounded idle-cycle fixture. Scoped metadata assertions verify replay versus activity, parent identity, timer command sequence, and completion diagnostics for success and failure.

## November 11 results

| Run | Mutants | Killed | Survived | No coverage | Timeout | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before | 294 | 110 | 98 | 86 | 0 | 89s |
| First after | 300 | 173 | 88 | 38 | 1 | 101s |
| Second after | 300 | 209 | 78 | 12 | 1 | 134s |
| Third after | 305 | 287 | 15 | 2 | 1 | 115s |
| Final | 305 | 290 | 12 | 2 | 1 | 87s |

The final run had zero runtime errors and zero Vitest deadline kills. Of 249 unchanged mutation spans, 82 historical survivors and 66 previously uncovered variants now fail assertions. All 87 matching historical kills are preserved. Of four historical Vitest deadline kills, two now fail assertions and the other two no longer have matching source spans. The final timer test detects all three remaining telemetry changes from the preceding run. Removing the command sequence loses timer identity, while making the error branch unconditional adds an `UnknownError` with message `undefined` to a successful completion.

| Final mutant IDs | Observed outcome and rationale |
| --- | --- |
| 13, 231, 246 | Three survivors affect diagnostics. They blank the message for multiple buffered failures, the workflow drain phase label used in shutdown timeout diagnostics, or the polling aggregate message. Rejections and the aggregated causes are unchanged. |
| 52, 56, 66, 70, 82, 175 | Six survivors add an own `undefined` codec or instrumentation property to private constructor options when that option is absent. The consumers select defaults or skip instrumentation by value. |
| 137 | When no instrumentation or ambient observer is configured, the mutation constructs a no-op wrapper instead of omitting it. It adds empty calls without emitting observations. |
| 162 | A placeholder in the private initial polling-task array is treated as a fulfilled value during an early stop. It adds an inert result to the internal settlement list and changes no failure or ownership outcome. |
| 180, 182, 184 | One survivor and two uncovered variants concern an Action executing outside the runtime's owned async scope. The runtime's private transport is entered only by scheduler callbacks wrapped in that scope. |
| 321 | Replacing the outbox cycle result with unconditional success skips dispatch and keeps polling without the idle wait. Stryker reaches its explicit execution hit limit. The result remains `Timeout`. |

The profile is reviewed under the supported runtime and provider contracts. The before and final JSON, HTML, source and test hashes, and unchanged-span comparison are archived in `artifacts/mutation/nov11-complete-review/workflow-runtime-before/` and `artifacts/mutation/nov11-complete-review/workflow-runtime-after-4/`. Run this profile with `npm run test:mutation:focus -- workflow-runtime`.
