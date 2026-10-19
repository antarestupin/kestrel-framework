# Workers

[Usage index](./README.md) · [Implementation, scheduling and adapter contracts](../implementation/workers.md)

Provider composition and backend settings follow the [shared adapter configuration contract](./configuration.md#configure-providers-and-their-backends).

Use workers for queued, retryable jobs. Publish against a typed worker definition and run the worker workload separately or through the shared background runtime.

## Install PostgreSQL storage

Add these objects to the application's global Drizzle schema and to the `schema` object passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Keep the library tables and namespace exported together.
export {
  workersSchema,
  workerJobs,
  workerDeadLetterJobs,
  workerQueueControls,
} from "@kestreljs/framework/workers";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required.

## Define and publish a job

Queue an operation when it can run asynchronously and needs retry handling. This memory-backed example declares a greeting worker and publishes individual or batched inputs.

```ts
import { z } from "zod";
import { App, defineCatalog } from "@kestreljs/framework/app";
import { configure, createConfigurationApi } from "@kestreljs/framework/configuration";
import { defineWorker, memoryWorkers, MemoryWorkerAdapter, WorkerClient, WorkerProvider, workersConfigBase } from "@kestreljs/framework/workers";

const printGreeting = defineWorker({
  name: "greeting.print", queue: "greetings",
  input: z.object({ name: z.string() }),
  maxAttempts: 3, retryDelayMs: 1_000,
  handler: async (job, _deps, { signal }) => {
    // Check cooperative cancellation before performing an effect.
    signal.throwIfAborted();
    console.log(`Hello, ${job.payload.name}!`);
  },
});
const configuration = createConfigurationApi({ environments: ["test"], defaultEnvironment: "test" });
const config = configuration.resolveConfig({ workers: configure(workersConfigBase, {}) }, {
  environment: "test", env: {},
});
const adapter = new MemoryWorkerAdapter();
const app = new App(config, {
  catalog: defineCatalog({ greeting: { workers: { printGreeting } } }),
}).register(new WorkerProvider(config.workers, memoryWorkers()));

// Standalone publication uses an independently owned memory adapter.
const workers = new WorkerClient(adapter);
// Deduplicate equivalent publication while this identity remains active.
await workers.enqueue(printGreeting, { name: "Sam" }, { identity: "greeting:member-1" });
await workers.enqueueMany(printGreeting, [{ name: "Alex" }, { name: "Jo" }]);
```

In application services inject `workerClientDependency`. Select PostgreSQL explicitly with `postgresWorkers(database)`, after installing its schema and database provider. Runtime execution also needs the application's logger. Memory publication and consumption must occur in the same process.

`availableAt` schedules future availability. An `identity` deduplicates equivalent publications while the job remains active; it is not an exactly-once guarantee. `enqueueMany` validates every payload before writing and does not accept one shared identity for several jobs.

After schema validation, payloads and optional `correlation` metadata are snapshotted through native JSON serialization with both built-in adapters. Dates become ISO strings, object properties containing `undefined`, functions or symbols are omitted, equivalent array entries become `null`, and non-finite numbers become `null`. Custom `toJSON()` methods are honored. Cycles, unsupported `BigInt` values and root values with no JSON representation reject with `WorkerPayloadSerializationError` before any job in the batch is published. JSON `null` is a supported payload. Changing the original object after publication or a reserved payload during execution cannot change the stored job used by later attempts.

Use schemas that accept the stored JSON representation when the scheduler validates the payload again: for example, keep dates as ISO strings or use an appropriate coercion. Memory and PostgreSQL deduplication compare the normalized JSON content rather than the original JavaScript types. PostgreSQL JSONB restrictions still apply, including its rejection of the Unicode null character. These Worker conversions do not change the stricter default Workflow payload codec. See the [serialization contract](../implementation/workers.md#durable-json-payloads).

Prefer `enqueueMany` when publishing several inputs together. PostgreSQL inserts up to 1,000 ordinary jobs per statement and keeps larger publications atomic across chunks. Returned IDs follow input order. When using `correlation` with a configured completion sink, the scheduler waits for durable result delivery before buffering the corresponding acknowledgement; a failed handoff leaves the job available for replay after its lease expires.

## Limit publication sizes

All publication budgets are optional and independent. Omit `publication`, use `{}`, or omit an individual property to leave the corresponding limit unlimited. Configured limits must be positive safe integers.

```ts
import { configure } from "@kestreljs/framework/configuration";
import { workersConfigBase } from "@kestreljs/framework/workers";

// Any subset is valid; these values are application choices, not defaults.
const workersConfiguration = configure(workersConfigBase, {
  publication: {
    maxJobBytes: 1_048_576,
    maxBatchBytes: 8_388_608,
    maxBatchSize: 100,
  },
});
```

Pass the resolved configuration to `WorkerProvider` as usual. The provider forwards `publication` to the client and built-in adapters, including their direct `enqueue()` calls. For standalone publication, pass a `WorkerPublicationBudgets` object as the second argument to `new WorkerClient(adapter, budgets)`. A standalone memory adapter accepts the same fields in its options; a standalone PostgreSQL adapter accepts budgets as its fifth constructor argument, after the three optional table overrides.

`maxJobBytes` counts the UTF-8 bytes of the serialized payload plus the serialized correlation when present. `maxBatchBytes` sums those job sizes. JSON quotes and escaping count; queue names, identities, scheduling fields, SQL framing and transport overhead do not. Repeated identities count as requested jobs and bytes before deduplication. The limits apply to both `enqueue()` and `enqueueMany()` and are inclusive: an exact-size publication is accepted.

Count overflow is rejected before schema validation. Payloads are then validated and prepared progressively; byte overflow stops preparation and rejects the whole batch before any backend write. `WorkerPublicationBudgetError` exposes `budget`, `limit`, `actual` and the zero-based `jobIndex` for byte failures. These are publication limits only: there is no JSON depth budget, no cumulative queue quota and no new check when consumers reserve, retry or acknowledge jobs. Consumer reservation limits remain independent. See [implementation guarantees and limits](../implementation/workers.md#publication-budgets).

## Process batches with partial results

Use batch processing when several queued inputs can be handled together but may succeed independently. Report each outcome so one failed item does not invalidate earlier successes.

```ts
import { jobFail, jobSuccess } from "@kestreljs/framework/workers";

const importContacts = defineWorker({
  name: "contact.import", queue: "contact-imports",
  input: z.object({ name: z.string() }),
  batch: { size: 100, allowOverflow: false },
  async *handler(jobs) {
    for (const job of jobs) {
      try {
        console.log(job.payload.name);
        // Acknowledge this item independently of later outcomes in the batch.
        yield jobSuccess(job.id);
      } catch (error) {
        // Keep the failure attached to this job so it can follow its retry policy.
        yield jobFail(job.id, { cause: error, retryDelayMs: 1_000 });
      }
    }
  },
});
```

Yield one outcome per job, or return nothing to acknowledge the entire batch. Successful yields stay successful if later jobs fail. Handlers must tolerate replay: confirmed failures retry with backoff, exhausted failures enter dead-letter storage, and lease loss can cause redelivery.

## Run and limit consumption

Start a worker workload when published jobs should be consumed, then size its concurrency for the available resources. These commands use the application's configured launcher.

```sh
./do run workers
# Alternatively, select workers through the combined background launcher.
./do run background --workload workers
```

Forward `context.signal` to cancellable dependencies. Configure `slots`, `reservationLimit`, lease duration and `shutdownBehavior` through `workersConfigBase`. The default shutdown waits for handlers; release/expiry modes require cooperative cancellation and replay-safe effects. The runtime still drains the polling lifetime under the [shared application deadline](./app.md#bound-application-shutdown), including storage calls made before scope creation, so borrowed dependencies are not closed while those calls are pending. The lower-level scheduler retains its non-waiting release/expiry API.

For dependency limits, add `throttling: { requirements: job => ({ admission, estimatedCost }), buffering: { strategy: "defer" } }`. [Throttling](./throttling.md) explains policies; [the worker buffering reference](../implementation/workers.md#choosing-a-buffering-strategy) covers bounded hold and release alternatives.

Tune `ackBufferSize` / `ackFlushIntervalMs` for acknowledgements and `deferBufferSize` / `deferFlushIntervalMs` for throttling deferrals. Both default to 100 jobs and 10 ms and drain at cycle completion or shutdown. A release strategy makes the job immediately eligible once the buffered write succeeds. Leases remain protected while a deferral waits for storage; a failed write is reported as a scheduler storage failure and leaves the job leased for redelivery, without invoking its handler or issuing a handler retry.

## Use cases still to document

- Compose persistent queues with the PostgreSQL schema and runtime providers.
- Schedule delayed jobs and request retries with WorkerRetryError.
- Configure retry exhaustion and inspect terminal failures in dead-letter storage.
- Publish correlated jobs and collect explicit handler results.
- Handle cancellation and shutdown while using throttled admission.
