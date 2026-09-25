# Throttling

[Usage index](./README.md) · [Implementation and coordination contracts](../implementation/throttling.md)

Use throttling to bound dependency requests, concurrency or resource pressure. In Kestrel, resolve `throttlingConfigBase`, register `ThrottlingProvider` after PostgreSQL infrastructure, and inject `throttlingDependency`. The provider defaults to exact shared PostgreSQL rate coordination.

## Install PostgreSQL storage

Add these objects to the application's global Drizzle schema and to the `schema` object passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Keep the library tables and namespace exported together.
export {
  throttlingRateLimits,
  throttlingRateLimitLeases,
} from "@kestrel/framework/throttling";
export { utilsSchema } from "@kestrel/framework/db";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required.

## Limit requests and wait within a budget

Bound calls to a dependency when it has a request quota. A limited wait can absorb short bursts while still giving the caller a deadline and cancellation control.

```ts
import { defineRateLimit, MemoryRateLimitAdapter, seconds, ThrottlingManager } from "@kestrel/framework/throttling";

const partnerLimit = defineRateLimit({ id: "partner-api", requests: 20, per: seconds(1) });
// A standalone memory manager coordinates only this process.
const throttling = new ThrottlingManager(new MemoryRateLimitAdapter(), { namespace: "example" });
async function readPartner<T>(read: () => Promise<T>, signal: AbortSignal) {
  // Wait at most two seconds for admission; run owns permit completion.
  return throttling.run(partnerLimit, { maxWaitMs: 2_000, signal }, read);
}
// The resource owner must await throttling.close() during shutdown.
```

Without `maxWaitMs`, exhaustion rejects immediately. Waiting is bounded and cancellable; the budget covers admission, not the protected operation. Pass cancellation to the dependency too. A `rateKey` partitions one stable definition by an opaque identity, without creating a definition for each user. Avoid personal data in that key.

## Combine rate, concurrency and health limits

Compose admission limits when a costly dependency has several constraints at once. This generation example budgets requests and tokens, bounds concurrent calls and stops admitting calls when the dependency is unhealthy.

```ts
import { circuitBreaker, concurrencyLimit, defineAdmissionPolicy, minutes, rateLimit } from "@kestrel/framework/throttling";

const generationPolicy = defineAdmissionPolicy({
  id: "text-generation",
  limits: [
    rateLimit({ id: "generation-requests", unit: "requests", limit: 100, per: minutes(1) }),
    rateLimit({ id: "generation-tokens", unit: "tokens", limit: 10_000, per: minutes(1) }),
    concurrencyLimit({ id: "generation-concurrency", limit: 4, scope: "process" }),
    circuitBreaker({
      id: "generation-health", failureThreshold: 5, cooldown: seconds(30),
      halfOpen: { maxConcurrentProbes: 1, successThreshold: 1 },
    }),
  ],
  // Reconcile the reserved estimate with actual usage before the run completes.
  costAccounting: { reconciliation: "synchronous" },
});
async function generate(call: () => Promise<{ text: string; tokens: number }>) {
  return throttling.run(generationPolicy, {
    estimatedCost: { requests: 1, tokens: 500 },
  }, async ({ reportActualCost }) => {
    const result = await call();
    // Report measured usage so reconciliation can adjust the initial estimate.
    reportActualCost({ requests: 1, tokens: result.tokens });
    return result.text;
  });
}
```

Every rate dimension needs an estimate. The default cost accounting records actual usage without adjusting quota; this recipe explicitly enables synchronous reconciliation. Asynchronous reconciliation returns earlier but may be lost on a crash. Concurrency and circuit state are process-local even with shared rate storage.

Call `reportFeedback({ kind: "timeout" | "transient" | "permanent" | "throttled" })` once when you can classify the outcome. Throttled feedback may include `retryAt`. A circuit breaker changes health admission, independently of rate tokens.

## Defer worker jobs when a dependency is busy

Defer queued work when its dependency has no capacity yet. The job remains available for a later attempt without occupying a normal handler slot while waiting.

```ts
import { z } from "zod";
import { defineWorker } from "@kestrel/framework/workers";

const synchronize = defineWorker({
  name: "partner.synchronize", queue: "partner-sync",
  input: z.object({ id: z.string() }),
  throttling: {
    requirements: () => ({ admission: partnerLimit, estimatedCost: { requests: 1 } }),
    // Return unadmitted jobs for later processing instead of keeping a handler busy.
    buffering: { strategy: "defer" },
  },
  handler: async (job) => { console.log(job.payload.id); },
});
```

Admission waiting does not occupy an ordinary worker handler slot. `hold` keeps a bounded leased buffer; `release` returns the reservation. Outbound HTTP can use `throttleRequests` for one acquisition per network attempt, including retries.

## Inspect pressure and choose failure behavior

Inspect admission state when diagnosing saturation, and choose how the application should react if coordination storage fails. Inspection helps explain pressure without consuming capacity.

`inspect(definition, options)` is advisory and does not reserve capacity. `localResourcePressure` adds configured process signals such as event-loop delay; the [pressure recipes](../implementation/throttling.md#local-resource-pressure) explain thresholds and unavailable-signal policy. Exact and leased rate coordination have different accuracy/round-trip tradeoffs; select them deliberately using the [coordination reference](../implementation/throttling.md#scope-and-distributed-coordination).

Storage failure rejects by default. Emergency-local capacity is an explicit provider policy and multiplies across processes. Standalone owners must close managers; manual `acquire` callers must complete permits exactly once. Prefer `run` to own completion automatically.

## Use cases still to document

- Configure PostgreSQL exact or leased rate coordination and backend failure policy.
- Partition one limit with rateKey identities.
- Report dependency feedback and observe circuit transitions.
- Configure local resource-pressure thresholds and inspect admission state.
- Complete a manually acquired permit and compare worker hold and release buffering.
