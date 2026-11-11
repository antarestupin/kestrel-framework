# Workflow runtime and transport mutation review

November 11, 2026. This review covers the `workflow-runtime`, `workflow-scheduler` and `workflow-transports` profiles. Together they select the runtime, provider, dependency registrations, completion buffer, scheduler, and both activity transports. The [framework inventory](mutation_testing_inventory.md) tracks these slices alongside replay, operator operations, public contracts and storage adapters.

## Reproduced defects

- A workflow task scope could remain open if observer resolution or execution recording threw. The workflow runtime now disposes the scope after setup failures and ensures completion recording cannot bypass disposal. The test checks actual scoped completion events on all three paths.
- A lost lease could leave an activity entering its handler after asynchronous scope setup. The scheduler now checks ownership before entering the scope and again at the invocation boundary. Lease loss also aborts the transport signal. The scheduler returns a late reservation after application shutdown and uses the original token when making the task available for redelivery.
- The activity completion buffer joined two opaque adapter coordinates with a colon. A stale reservation and a distinct committed reservation could compare equal. The buffer now encodes both coordinates as a tuple. Tests also check single and multiple batch failures and drain order.
- One rejected outbox publication could end the dispatch cycle while a sibling still used the adapter. The cycle now waits for every started publication and propagates their failures. Tests hold the second publication open while the first fails and assert that ownership remains with the cycle.
- The Worker transport reused the same identity when continue-as-new reset command sequence numbers. An older completion could also modify the newer journal. The activity identity now includes the history generation while retaining the established generation-one representation. The transport carries generation in the completion correlation, validates its envelope, and preserves authoritative routing coordinates even when a result includes extra fields. Queued legacy jobs can carry their original outbox id to prove ownership of an active command after an upgrade.
- Long start-to-close deadlines could be coerced to a 1 ms Node timer. The embedded and Worker transports share the bounded scheduling timer and abort a cooperative transport at the deadline. Embedded deadlines keep the process alive and Worker deadlines remain unreferenced, matching their previous ownership behavior.
- A configured workflow payload codec reached the client and journal replay, while the two Action activity transports decoded with the default JSON codec. Workflows using a different representation could fail Action schema validation on valid inputs. Both transports now use the provider-selected codec for the Action input and result. End-to-end tests cover an embedded Action and a Worker-backed Action across history rotation.

The unit and integration suites exercise app scope construction, actual Worker enqueue and correlated completion, workflow history, and two generations of one workflow. Each test controls time or releases the work it starts. A transport deadline or lost lease does not guarantee that an external system cancelled an effect that already began. Keep target-owned idempotency keys for such effects.

## Mutation evidence

| Profile | Reference Killed / Survived / NoCoverage | Final Killed / Survived / NoCoverage | Final Timeout / Vitest deadline kills | Final seconds |
| --- | ---: | ---: | ---: | ---: |
| `workflow-scheduler` | 272 / 122 / 43 | 363 / 104 / 7 | 2 / 0 | 189 |
| `workflow-transports` | 149 / 118 / 88 | 371 / 83 / 0 | 0 / 0 | 172 |

Of 391 matching scheduler mutations, 25 survivors and 29 uncovered variants now fail behavior assertions. Both remaining Stryker timeouts turn idle polling into a busy loop and hit the execution guard. The seven uncovered variants describe an immediately redundant abort guard, diagnostic outcome or timing fields, and the defensive exception for a malformed timer reservation. All 242 matching prior kills were retained.

Of 278 matching transport mutations, 63 survivors and 52 uncovered variants now fail behavior assertions. All seven prior matching Vitest deadline detections became direct failures through a controlled clock and explicit handler release. The final transport report has no uncovered mutations or execution timeouts and retains all 110 matching prior kills. Remaining variants concern optional metadata, defensive envelope validation, legacy defaults and alternate diagnostic projections.

The [scheduler and transport classifications](mutation_testing_workflow_scheduler_transports_classification.json) list residuals by source boundary and report ID. The [runtime and provider analysis](mutation_testing_workflow_runtime_profile.md) records its final profile, tests and residual details.
