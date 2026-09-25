# Workers

[Usage index](./README.md) · [Implementation, scheduling and adapter contracts](../implementation/workers.md)

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
} from "@kestrel/framework/workers";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required.

## Define and publish a job

Queue an operation when it can run asynchronously and needs retry handling. This memory-backed example declares a greeting worker and publishes individual or batched inputs.

```ts
import { z } from "zod";
import { App, defineCatalog } from "@kestrel/framework/app";
import { configure, createConfigurationApi } from "@kestrel/framework/configuration";
import { defineWorker, MemoryWorkerAdapter, WorkerClient, WorkerProvider, workersConfigBase } from "@kestrel/framework/workers";

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
}).register(new WorkerProvider(config.workers, { adapter }));

// Standalone publication uses the same adapter and validation as the DI client.
const workers = new WorkerClient(adapter);
// Deduplicate equivalent publication while this identity remains active.
await workers.enqueue(printGreeting, { name: "Sam" }, { identity: "greeting:member-1" });
await workers.enqueueMany(printGreeting, [{ name: "Alex" }, { name: "Jo" }]);
```

In application services inject `workerClientDependency`. Omit the adapter for the provider's PostgreSQL default, after installing its schema and database provider. Runtime execution also needs the application's logger. Memory publication and consumption must occur in the same process.

`availableAt` schedules future availability. An `identity` deduplicates equivalent publications while the job remains active; it is not an exactly-once guarantee. `enqueueMany` validates every payload before writing and does not accept one shared identity for several jobs.

Prefer `enqueueMany` when publishing several inputs together. PostgreSQL inserts up to 1,000 ordinary jobs per statement and keeps larger publications atomic across chunks. Returned IDs follow input order. When using `correlation` with a configured completion sink, the scheduler waits for durable result delivery before buffering the corresponding acknowledgement; a failed handoff leaves the job available for replay after its lease expires.

## Process batches with partial results

Use batch processing when several queued inputs can be handled together but may succeed independently. Report each outcome so one failed item does not invalidate earlier successes.

```ts
import { jobFail, jobSuccess } from "@kestrel/framework/workers";

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

Forward `context.signal` to cancellable dependencies. Configure `slots`, `reservationLimit`, lease duration and `shutdownBehavior` through `workersConfigBase`. The default shutdown waits for handlers; release/expiry modes require cooperative cancellation and replay-safe effects.

For dependency limits, add `throttling: { requirements: job => ({ admission, estimatedCost }), buffering: { strategy: "defer" } }`. [Throttling](./throttling.md) explains policies; [the worker buffering reference](../implementation/workers.md#choosing-a-buffering-strategy) covers bounded hold and release alternatives.

Tune `ackBufferSize` / `ackFlushIntervalMs` for acknowledgements and `deferBufferSize` / `deferFlushIntervalMs` for throttling deferrals. Both default to 100 jobs and 10 ms and drain at cycle completion or shutdown. A release strategy makes the job immediately eligible once the buffered write succeeds. Leases remain protected while a deferral waits for storage; a failed write is reported as a scheduler storage failure and leaves the job leased for redelivery, without invoking its handler or issuing a handler retry.

## Use cases still to document

- Compose persistent queues with the PostgreSQL schema and runtime providers.
- Schedule delayed jobs and request retries with WorkerRetryError.
- Configure retry exhaustion and inspect terminal failures in dead-letter storage.
- Publish correlated jobs and collect explicit handler results.
- Handle cancellation and shutdown while using throttled admission.
