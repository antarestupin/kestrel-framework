# Concurrency

[Usage index](./README.md) · [Implementation and lifecycle contracts](../implementation/concurrency.md)

Use these standalone primitives for in-process batching and owned asynchronous work. They do not persist work; use [workers](./workers.md) for durable jobs.

## Buffer individual writes into batches

Buffer small writes when the destination can process a batch more efficiently than individual calls. Size and waiting-time limits balance throughput against latency.

```ts
import { BatchBuffer } from "@kestrel/framework/concurrency";

const written: string[][] = [];
const buffer = new BatchBuffer<string>({
  maxBatchSize: 100,
  maxWaitMs: 25,
  // Finish one batch before starting another against this destination.
  execution: "sequential",
  handler: async (values) => { written.push([...values]); },
});
buffer.add("first");
buffer.add("second");
const outcome = await buffer.run();
// Always close at the owning resource's shutdown boundary.
await buffer.close();
```

Size, age or `run()` can trigger a batch. `run()` returns accumulated successes and failures, including batches already triggered in the background. It does not retry failed batches. `close()` rejects later additions and drains accepted values. Timers do not keep an otherwise idle process alive.

## Report partial success from a bulk operation

Collect individual outcomes when an import should continue after one item fails. The caller receives both successful values and errors, associated with their original inputs.

```ts
import { AggregatedResultBuilder } from "@kestrel/framework/concurrency";

async function importNames(names: readonly string[], save: (name: string) => Promise<string>) {
  const result = new AggregatedResultBuilder<string, string, unknown>();
  for (const name of names) {
    try {
      result.addResult(name, await save(name));
    } catch (error) {
      // Retain the failed input and continue with the remaining items.
      result.addError(name, error);
    }
  }
  return result.build({ attempted: names.length });
}
```

The result status is `success`, `partial` or `error`; an empty operation is successful. Normalize errors before exposing them over a transport. `runAggregatedResult` also accepts producers and generators, while `collectAggregatedResult` collects streamed outcomes.

## Drain deferred work before releasing resources

Use deferred tasks for asynchronous work that may finish after the main operation but must complete before cleanup. The owner closes the task group before releasing resources those tasks use.

```ts
import { DeferredTasks } from "@kestrel/framework/concurrency";

const tasks = new DeferredTasks();
tasks.defer(async () => { console.log("Deferred work"); });
// Wait for accepted work before releasing anything it might still use.
await tasks.close();
```

Attach cleanup to the resource that owns the tasks. Application execution scopes already own deferred tasks for their lifecycle. Failures are collected and surfaced by the owning boundary; deferring work does not make it durable.

## Use cases still to document

- Wait for an individual buffered value with addAndWait and handle its outcome.
- Produce and collect aggregated results from generators or asynchronous streams.
- Drain deferred tasks that enqueue more work and handle collected failures.
