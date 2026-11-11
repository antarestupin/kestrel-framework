# Scheduling primitives mutation review

November 11, 2026. The static-inclusive `component scheduling` profile assessed all four candidate source files. `index.ts` only re-exports symbols and generated no mutants. Every execution finished inside its ten-minute budget. See the [report fingerprints and residual classifications](mutation_testing_scheduling_review.json).

| Run | Killed | Survived | No coverage | Stryker timeout | Vitest deadline kills | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Reference | 79 | 47 | 4 | 6 | 13 | 103 |
| First validation | 135 | 7 | 2 | 4 | 1 | 58 |
| Polling and heartbeat validation | 134 | 1 | 0 | 4 | 0 | 46 |
| Final with shared workflow deadlines | 139 | 1 | 0 | 3 | 0 | 54 |

The unchanged-source comparison matches 104 mutation fingerprints. It preserves all 64 matching kills, directly detects 34 previous survivors and one uncovered mutant, and converts two Stryker timeouts to direct assertions. Eleven former Vitest deadline kills match direct final failures. The remaining 32 reference and 35 final fingerprints sit on changed source spans or have no exact counterpart.

The tests found that Node's timer limit could reduce a delay of more than approximately 25 days to 1 ms, a sibling abort listener could suppress delay cleanup, and a synchronous lease-extension throw could escape the heartbeat and bypass failure reporting. Delays now split across bounded Node timers against a monotonic deadline. Both primitives use Node's abort listener with explicit cleanup, and the heartbeat handles synchronous throws and rejected promises through the same owned path. Polling tests cover the retry budget and jitter boundaries, return to healthy state, interruption during a backoff or failing cycle, and immediate continuation after useful work. The final review also removed an unobservable status assignment overwritten before the first cycle or stop.

The remaining heartbeat survivor removes optional chaining on the failure callback. When the callback is absent, the surrounding catch absorbs the resulting TypeError and preserves the original extension failure and cleanup. The three final Stryker timeouts skip a wait unconditionally, prevent its promise from resolving, or replace the polling loop with an empty spin. Controlled tests separately assert waiting, cancellation and cycle progress. Workflow activity deadlines now share the bounded timer while preserving their previous referenced or unreferenced timer behavior. The profile remains informational.
